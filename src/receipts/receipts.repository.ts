import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExtractedReceipt } from '../claude/claude.service';

export interface ReceiptRecord {
  id: string;
  merchant: string | null;
  location: string | null;
  receipt_date: string | null;
  total_amount: string | null;
  currency: string | null;
  payment_method: string | null;
  confidence_score: string | null;
  status: string;
  created_at: Date;
  categories: string[];
}

@Injectable()
export class ReceiptsRepository {
  constructor(private readonly db: DatabaseService) {}

  async createPending(rawText: string, promptUsed: string): Promise<string> {
    const result = await this.db.pool.query<{ id: string }>(
      `INSERT INTO receipts (raw_text, prompt_used, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [rawText, promptUsed],
    );
    return result.rows[0].id;
  }

  async completeWithExtraction(
    receiptId: string,
    extracted: ExtractedReceipt,
    rawResponse: unknown,
  ): Promise<void> {
    await this.db.pool.query(
      `UPDATE receipts SET
        merchant = $2,
        location = $3,
        receipt_date = $4,
        total_amount = $5,
        currency = $6,
        payment_method = $7,
        confidence_score = $8,
        raw_response = $9,
        status = 'completed',
        updated_at = now()
      WHERE id = $1`,
      [
        receiptId,
        extracted.merchant,
        extracted.location,
        extracted.date,
        extracted.total_amount,
        extracted.currency,
        extracted.payment_method,
        extracted.confidence_score,
        JSON.stringify(rawResponse),
      ],
    );

    await this.attachCategories(receiptId, extracted.categories);
  }

  async markFailed(receiptId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE receipts SET status = 'failed', updated_at = now() WHERE id = $1`,
      [receiptId],
    );
  }

  async findById(receiptId: string): Promise<ReceiptRecord | null> {
    const result = await this.db.pool.query<ReceiptRecord>(
      `SELECT
        r.id, r.merchant, r.location,
        to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date,
        r.total_amount, r.currency,
        r.payment_method, r.confidence_score, r.status, r.created_at,
        COALESCE(array_agg(c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS categories
      FROM receipts r
      LEFT JOIN receipt_categories rc ON rc.receipt_id = r.id
      LEFT JOIN categories c ON c.id = rc.category_id
      WHERE r.id = $1
      GROUP BY r.id`,
      [receiptId],
    );

    return result.rows[0] ?? null;
  }

  private async attachCategories(
    receiptId: string,
    categoryNames: string[],
  ): Promise<void> {
    for (const rawName of categoryNames) {
      const name = rawName.trim();
      if (!name) continue;

      const category = await this.db.pool.query<{ id: number }>(
        `INSERT INTO categories (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name],
      );

      await this.db.pool.query(
        `INSERT INTO receipt_categories (receipt_id, category_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [receiptId, category.rows[0].id],
      );
    }
  }
}
