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
    `);
  }
}
