import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      host: config.get<string>('POSTGRES_HOST'),
      port: config.get<number>('POSTGRES_PORT', 5432),
      user: config.get<string>('POSTGRES_USER'),
      password: config.get<string>('POSTGRES_PASSWORD', ''),
      database: config.get<string>('POSTGRES_DB'),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    // Requires PostgreSQL 13+ (gen_random_uuid() is built into core as of pg13).
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_text TEXT NOT NULL,
        prompt_used TEXT,
        merchant TEXT,
        location TEXT,
        receipt_date DATE,
        total_amount NUMERIC(12, 2),
        currency VARCHAR(3),
        payment_method TEXT,
        confidence_score NUMERIC(3, 2),
        raw_response JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS receipt_categories (
        receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        PRIMARY KEY (receipt_id, category_id)
      );
    `);

    // `CREATE TABLE IF NOT EXISTS` above is a no-op on a database that already
    // has these tables, so anything added after the first release has to be an
    // explicit, idempotent ALTER. All three statements below are safe to re-run.
    await this.pool.query(`
      -- A PDF upload has no raw text at ingest time; Claude reads the document
      -- itself, so there is nothing to store in this column for those receipts.
      ALTER TABLE receipts ALTER COLUMN raw_text DROP NOT NULL;

      -- The DEFAULT backfills every pre-existing row as 'text', which is what
      -- they all are: the PDF endpoint is the only writer of 'pdf'.
      ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS source_type VARCHAR(10) NOT NULL DEFAULT 'text';

      -- Kept so a failed PDF extraction can be traced back to an actual file.
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source_filename TEXT;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source_bytes INTEGER;

      -- The anomaly verdict. The DEFAULT backfills pre-existing rows as not
      -- suspicious, which is what they are: they were never assessed, and they
      -- carry no reason. anomaly_evidence gets no column of its own - it is
      -- reasoning scaffolding, and it is already kept in raw_response.
      ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS flag_reason TEXT;

      -- The earlier receipt this one duplicates, when the deduplication key
      -- matched. The inline REFERENCES is carried by the ADD COLUMN, so it is
      -- skipped along with the column on a re-run rather than being added
      -- twice. ON DELETE SET NULL, not CASCADE: deleting the original must not
      -- delete the copy that was flagged against it.
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS duplicate_of UUID
        REFERENCES receipts(id) ON DELETE SET NULL;

      -- Merchant identity fields. Unquoted, so merchant_vatNumber is really
      -- merchant_vatnumber - every SELECT of it needs an AS "merchant_vatNumber".
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_details TEXT;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_vatNumber TEXT;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_phone TEXT;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS invoice_number TEXT;

      -- The EUR conversion. All nullable: no total, no currency, or an FX
      -- lookup that failed leaves them empty rather than failing the receipt.
      -- fx_date is the day the rate applies to, which is the receipt date
      -- unless the rate provider fell back to its nearest business day.
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS total_eur NUMERIC(12, 2);
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(18, 8);
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS fx_date DATE;
    `);

    // One row per model call, for every endpoint - /insights and /ask spend
    // tokens too but have no receipt row, hence a table rather than columns.
    // A new table, so CREATE ... IF NOT EXISTS is the idempotent form; any
    // column added to it later still goes in an ALTER. receipt_id is SET NULL
    // on delete: deleting a receipt does not un-spend what its calls cost.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS claude_calls (
        id BIGSERIAL PRIMARY KEY,
        receipt_id UUID REFERENCES receipts(id) ON DELETE SET NULL,
        endpoint VARCHAR(10) NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS claude_calls_receipt_idx
        ON claude_calls (receipt_id);
      CREATE INDEX IF NOT EXISTS claude_calls_created_idx
        ON claude_calls (created_at);

      -- Shared by every row one endpoint request wrote (/ask writes one per
      -- round). Null on rows recorded before it existed.
      ALTER TABLE claude_calls ADD COLUMN IF NOT EXISTS request_id UUID;
    `);

    // USD per million tokens, matched to claude_calls.model by prefix. A price
    // change is a new row with a later valid_from, never an UPDATE, so a past
    // call keeps the price that applied when it was made.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS model_prices (
        model_prefix TEXT NOT NULL,
        valid_from DATE NOT NULL,
        input NUMERIC(10, 4) NOT NULL,
        output NUMERIC(10, 4) NOT NULL,
        cache_read NUMERIC(10, 4) NOT NULL,
        cache_write NUMERIC(10, 4) NOT NULL,
        PRIMARY KEY (model_prefix, valid_from)
      );

      -- The seed predates the ledger so every recorded call finds a price.
      -- ON CONFLICT keeps it idempotent; a seed row deleted by hand comes back
      -- on the next boot.
      INSERT INTO model_prices
        (model_prefix, valid_from, input, output, cache_read, cache_write)
      VALUES
        ('claude-haiku-4-5', '2000-01-01', 1, 5, 0.1, 1.25),
        ('claude-sonnet-5-5', '2000-01-01', 2, 10, 0.2, 2.5),
        ('claude-opus-5-5', '2000-01-01', 4, 20, 0.2, 5),
        ('claude-fable-5-1', '2000-01-01', 10, 50, 0.25, 12.5)
      ON CONFLICT (model_prefix, valid_from) DO NOTHING;

      -- The price in effect for a model at a moment: the longest matching
      -- prefix, then the latest valid_from not after it. No row when the
      -- model is unknown or the moment predates its first price. starts_with
      -- rather than LIKE, whose _ wildcard would match any character.
      CREATE OR REPLACE FUNCTION model_price_at(p_model TEXT, p_at TIMESTAMPTZ)
      RETURNS SETOF model_prices
      LANGUAGE sql STABLE AS $$
        SELECT * FROM model_prices
        WHERE starts_with(p_model, model_prefix) AND valid_from <= p_at
        ORDER BY length(model_prefix) DESC, valid_from DESC
        LIMIT 1
      $$;
    `);

    // Indexes for the two history queries in `receipts.repository.ts`, which
    // run on every parse and would otherwise scan the whole table as it grows.
    await this.pool.query(`
      -- The deduplication key, expressed the same way the lookup is: trimmed
      -- and case-folded merchant. Partial on 'completed' because a pending or
      -- failed row has no extraction to match against.
      CREATE INDEX IF NOT EXISTS receipts_duplicate_key_idx
        ON receipts (lower(btrim(merchant)), receipt_date, total_amount)
        WHERE status = 'completed';

      -- The category spread query joins from the category side, and the table's
      -- primary key is (receipt_id, category_id), which cannot serve that.
      CREATE INDEX IF NOT EXISTS receipt_categories_category_idx
        ON receipt_categories (category_id);
    `);
  }
}
