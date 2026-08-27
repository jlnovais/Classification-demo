import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      host: this.config.get<string>('POSTGRES_HOST'),
      port: this.config.get<number>('POSTGRES_PORT', 5432),
      user: this.config.get<string>('POSTGRES_USER'),
      password: this.config.get<string>('POSTGRES_PASSWORD', ''),
      database: this.config.get<string>('POSTGRES_DB'),
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
