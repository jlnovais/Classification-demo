import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExtractedReceipt } from '../claude/claude.service';
import {
  CategorySpread,
  DuplicateMatch,
  ReceiptHistory,
  ReceiptVerdict,
} from './history-anomalies';

export interface ReceiptRecord {
  id: string;
  merchant: string | null;
  location: string | null;
  receipt_date: string | null;
  total_amount: string | null;
  currency: string | null;
  payment_method: string | null;
  confidence_score: string | null;
  // BOOLEAN comes back from `pg` as a real boolean, unlike the NUMERIC columns
  // above, which arrive as strings and are coerced in the service.
  is_suspicious: boolean;
  flag_reason: string | null;
  duplicate_of: string | null;
  status: string;
  created_at: Date;
  categories: string[];
}

@Injectable()
export class ReceiptsRepository {
  constructor(private readonly db: DatabaseService) {}

  async createPending(rawText: string, promptUsed: string): Promise<string> {
    const result = await this.db.pool.query<{ id: string }>(
      `INSERT INTO receipts (raw_text, prompt_used, status, source_type)
       VALUES ($1, $2, 'pending', 'text') RETURNING id`,
      [rawText, promptUsed],
    );
    return result.rows[0].id;
  }

  /**
   * The PDF counterpart of `createPending`. `raw_text` stays null - the file is
   * sent straight to Claude rather than converted to text here - so the file
   * name and size are recorded instead, which is what makes a failed row
   * traceable back to an upload.
   */
  async createPendingPdf(
    filename: string,
    sizeBytes: number,
    promptUsed: string,
  ): Promise<string> {
    const result = await this.db.pool.query<{ id: string }>(
      `INSERT INTO receipts (prompt_used, status, source_type, source_filename, source_bytes)
       VALUES ($1, 'pending', 'pdf', $2, $3) RETURNING id`,
      [promptUsed, filename, sizeBytes],
    );
    return result.rows[0].id;
  }

  /**
   * `verdict` is written instead of the extraction's own flag fields: by this
   * point the model's verdict has been unioned with the calendar and history
   * checks, and that merged result is what the row has to carry.
   */
  async completeWithExtraction(
    receiptId: string,
    extracted: ExtractedReceipt,
    rawResponse: unknown,
    verdict: ReceiptVerdict,
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
        is_suspicious = $10,
        flag_reason = $11,
        duplicate_of = $12,
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
        verdict.is_suspicious,
        verdict.flag_reason,
        verdict.duplicate_of,
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
        r.payment_method, r.confidence_score,
        r.is_suspicious, r.flag_reason, r.duplicate_of, r.status, r.created_at,
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

  /**
   * The two history lookups the anomaly checks in `history-anomalies.ts` need,
   * run together because neither depends on the other. Both exclude the receipt
   * being processed: it is still `pending` at this point, but excluding it by id
   * keeps that from being load-bearing.
   */
  async findHistory(
    receiptId: string,
    extracted: ExtractedReceipt,
  ): Promise<ReceiptHistory> {
    const [duplicate, spreads] = await Promise.all([
      this.findDuplicate(receiptId, extracted),
      this.categorySpreads(receiptId, extracted.categories),
    ]);

    return { duplicate, spreads };
  }

  /**
   * The earliest completed receipt sharing this one's deduplication key:
   * merchant, date and total, with currency guarding against 50 USD matching
   * 50 EUR. Merchant is trimmed and case-folded because the model's
   * capitalization varies between runs on the same shop.
   *
   * An incomplete key means no lookup at all - a receipt with no total or no
   * date is flagged by the model for exactly that, and matching on the fields
   * that remain would call every dateless receipt from one shop a duplicate.
   */
  private async findDuplicate(
    receiptId: string,
    extracted: ExtractedReceipt,
  ): Promise<DuplicateMatch | null> {
    const { merchant, date, total_amount: total } = extracted;
    if (!merchant?.trim() || !date || total === null) return null;

    const result = await this.db.pool.query<DuplicateMatch>(
      `SELECT id, created_at
       FROM receipts
       WHERE status = 'completed'
         AND id <> $1
         AND lower(btrim(merchant)) = lower(btrim($2))
         AND receipt_date = $3::date
         AND total_amount = $4
         AND currency IS NOT DISTINCT FROM $5
       ORDER BY created_at
       LIMIT 1`,
      [receiptId, merchant, date, total, extracted.currency],
    );

    return result.rows[0] ?? null;
  }

  /**
   * The historical total spread of the categories this receipt was assigned, so
   * the outlier check has something to measure against. `percentile_cont`
   * resolves to its double-precision overload here, so `pg` returns a number
   * rather than the string the NUMERIC columns come back as - coerced anyway,
   * so a future switch to the NUMERIC overload cannot leak a string into the
   * comparison.
   */
  private async categorySpreads(
    receiptId: string,
    categories: readonly string[],
  ): Promise<CategorySpread[]> {
    if (categories.length === 0) return [];

    const result = await this.db.pool.query<{
      category: string;
      sample_size: number;
      p90: string | number;
    }>(
      `SELECT
        c.name AS category,
        count(*)::int AS sample_size,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY r.total_amount) AS p90
      FROM receipts r
      JOIN receipt_categories rc ON rc.receipt_id = r.id
      JOIN categories c ON c.id = rc.category_id
      WHERE r.status = 'completed'
        AND r.total_amount IS NOT NULL
        AND r.id <> $1
        AND c.name = ANY($2::text[])
      GROUP BY c.name`,
      [receiptId, [...categories]],
    );

    return result.rows.map((row) => ({
      category: row.category,
      sample_size: row.sample_size,
      p90: Number(row.p90),
    }));
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
