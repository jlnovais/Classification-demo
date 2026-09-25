import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExtractedReceipt } from '../claude/claude.service';
import { FxRate } from './fx.service';
import { CurrencyTotal, ReceiptQuery } from './receipt-query';
import {
  CategorySpread,
  DuplicateMatch,
  ReceiptHistory,
  ReceiptVerdict,
} from './history-anomalies';
import {
  CategoryTotal,
  MonthEurTotal,
  MonthTotal,
  SpendingSummary,
} from './spending-summary';

export interface ReceiptRecord {
  id: string;
  merchant: string | null;
  merchant_details: string | null;
  merchant_vatNumber: string | null;
  merchant_phone: string | null;
  invoice_number: string | null;
  location: string | null;
  receipt_date: string | null;
  total_amount: string | null;
  currency: string | null;
  total_eur: string | null;
  fx_rate: string | null;
  fx_date: string | null;
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
   * The file counterpart of `createPending`, shared by the PDF and photo
   * endpoints. `raw_text` stays null - the file is sent straight to Claude
   * rather than converted to text here - so the file name and size are recorded
   * instead, which is what makes a failed row traceable back to an upload.
   *
   * `sourceType` is a parameter rather than two near-identical inserts. It
   * needed no migration: the column already exists and 'image' fits its width.
   */
  async createPendingUpload(
    sourceType: 'pdf' | 'image',
    filename: string,
    sizeBytes: number,
    promptUsed: string,
  ): Promise<string> {
    const result = await this.db.pool.query<{ id: string }>(
      `INSERT INTO receipts (prompt_used, status, source_type, source_filename, source_bytes)
       VALUES ($1, 'pending', $2, $3, $4) RETURNING id`,
      [promptUsed, sourceType, filename, sizeBytes],
    );
    return result.rows[0].id;
  }

  /**
   * `verdict` is written instead of the extraction's own flag fields: by this
   * point the model's verdict has been unioned with the calendar and history
   * checks, and that merged result is what the row has to carry.
   *
   * `totalEur` is computed by the caller and rounded to cents by the
   * NUMERIC(12, 2) column on write. A null `rate` leaves all three FX columns
   * null.
   */
  async completeWithExtraction(
    receiptId: string,
    extracted: ExtractedReceipt,
    rawResponse: unknown,
    verdict: ReceiptVerdict,
    rate: FxRate | null,
    totalEur: number | null,
  ): Promise<void> {
    await this.db.pool.query(
      `UPDATE receipts SET
        merchant = $2,
        merchant_details = $3,
        merchant_vatNumber = $4,
        merchant_phone = $5,
        invoice_number = $6,
        location = $7,
        receipt_date = $8,
        total_amount = $9,
        currency = $10,
        payment_method = $11,
        confidence_score = $12,
        raw_response = $13,
        is_suspicious = $14,
        flag_reason = $15,
        duplicate_of = $16,
        fx_rate = $17,
        fx_date = $18,
        total_eur = $19,
        status = 'completed',
        updated_at = now()
      WHERE id = $1`,
      [
        receiptId,
        extracted.merchant,
        extracted.merchant_details,
        extracted.merchant_vatNumber,
        extracted.merchant_phone,
        extracted.invoice_number,
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
        rate?.rate ?? null,
        rate?.date ?? null,
        totalEur,
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
        r.total_eur, r.fx_rate, to_char(r.fx_date, 'YYYY-MM-DD') AS fx_date,
        r.payment_method, r.confidence_score,
        r.is_suspicious, r.flag_reason, r.duplicate_of, r.status, r.created_at,
        r.merchant_details, r.merchant_vatnumber AS "merchant_vatNumber",
        r.merchant_phone, r.invoice_number,
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

  /**
   * The aggregates behind `GET /api/insights`: what was spent per category and
   * per month over a date range. Aggregating here rather than handing the model
   * a pile of receipts is the point of the endpoint - the model writes about
   * numbers SQL already computed, so it has nothing to total up wrongly.
   *
   * Both queries group by currency as well, so a EUR total is never added to a
   * USD one. Undated receipts are excluded: they cannot be placed in the range.
   */
  async spendingSummary(from: string, to: string): Promise<SpendingSummary> {
    const [categories, months, months_eur] = await Promise.all([
      this.categoryTotals(from, to),
      this.monthTotals(from, to),
      this.monthTotalsEur(from, to),
    ]);

    return { from, to, categories, months, months_eur };
  }

  /**
   * Spend per calendar month in EUR, across every currency. Grouped by month
   * alone - unlike the other two queries - because `total_eur` is already one
   * currency. Receipts without a conversion are counted, not summed.
   */
  private async monthTotalsEur(
    from: string,
    to: string,
  ): Promise<MonthEurTotal[]> {
    const result = await this.db.pool.query<{
      month: string;
      receipts: number;
      total_eur: string | number | null;
      unconverted: number;
    }>(
      `SELECT
        to_char(date_trunc('month', r.receipt_date), 'YYYY-MM') AS month,
        count(r.total_eur)::int AS receipts,
        sum(r.total_eur) AS total_eur,
        (count(*) - count(r.total_eur))::int AS unconverted
      FROM receipts r
      WHERE r.status = 'completed'
        AND r.total_amount IS NOT NULL
        AND r.receipt_date BETWEEN $1::date AND $2::date
      GROUP BY 1
      ORDER BY 1`,
      [from, to],
    );

    return result.rows.map((row) => ({
      month: row.month,
      receipts: row.receipts,
      total_eur: Number(row.total_eur ?? 0),
      unconverted: row.unconverted,
    }));
  }

  /**
   * Spend per category. A receipt with two categories contributes its full
   * total to both rows, so these totals deliberately overlap - `renderSummary`
   * tells the model as much, and the per-month rows are what add up.
   */
  private async categoryTotals(
    from: string,
    to: string,
  ): Promise<CategoryTotal[]> {
    const result = await this.db.pool.query<{
      category: string;
      currency: string | null;
      receipts: number;
      total: string | number;
    }>(
      `SELECT
        c.name AS category,
        r.currency,
        count(*)::int AS receipts,
        sum(r.total_amount) AS total
      FROM receipts r
      JOIN receipt_categories rc ON rc.receipt_id = r.id
      JOIN categories c ON c.id = rc.category_id
      WHERE r.status = 'completed'
        AND r.total_amount IS NOT NULL
        AND r.receipt_date BETWEEN $1::date AND $2::date
      GROUP BY c.name, r.currency
      ORDER BY sum(r.total_amount) DESC`,
      [from, to],
    );

    return result.rows.map((row) => ({
      category: row.category,
      currency: row.currency,
      receipts: row.receipts,
      total: Number(row.total),
    }));
  }

  /** Spend per calendar month, counting each receipt exactly once. */
  private async monthTotals(from: string, to: string): Promise<MonthTotal[]> {
    const result = await this.db.pool.query<{
      month: string;
      currency: string | null;
      receipts: number;
      total: string | number;
    }>(
      `SELECT
        to_char(date_trunc('month', r.receipt_date), 'YYYY-MM') AS month,
        r.currency,
        count(*)::int AS receipts,
        sum(r.total_amount) AS total
      FROM receipts r
      WHERE r.status = 'completed'
        AND r.total_amount IS NOT NULL
        AND r.receipt_date BETWEEN $1::date AND $2::date
      GROUP BY 1, r.currency
      ORDER BY 1, r.currency`,
      [from, to],
    );

    return result.rows.map((row) => ({
      month: row.month,
      currency: row.currency,
      receipts: row.receipts,
      total: Number(row.total),
    }));
  }

  /**
   * The query behind the `query_receipts` tool. The model chose `args`, so they
   * arrive validated by `parseQueryArgs` and still only as parameters; the
   * statement itself is fixed, with each optional filter written as
   * `$n IS NULL OR ...` rather than assembled.
   *
   * The category filter is an EXISTS rather than a join, so a receipt in two of
   * the requested categories is counted once - unlike `categoryTotals`, these
   * totals can be quoted as they are. Grouped by currency for the same reason
   * as the insights queries.
   */
  async queryReceipts(args: ReceiptQuery): Promise<CurrencyTotal[]> {
    const result = await this.db.pool.query<{
      currency: string | null;
      receipts: number;
      total: string | number;
      total_eur: string | number | null;
      unconverted: number;
    }>(
      `SELECT
        r.currency,
        count(*)::int AS receipts,
        sum(r.total_amount) AS total,
        sum(r.total_eur) AS total_eur,
        (count(*) - count(r.total_eur))::int AS unconverted
      FROM receipts r
      WHERE r.status = 'completed'
        AND r.total_amount IS NOT NULL
        AND r.receipt_date BETWEEN $1::date AND $2::date
        AND ($3::text[] IS NULL OR EXISTS (
          SELECT 1
          FROM receipt_categories rc
          JOIN categories c ON c.id = rc.category_id
          WHERE rc.receipt_id = r.id AND c.name = ANY($3::text[])
        ))
        AND ($4::text IS NULL OR r.merchant ILIKE '%' || $4::text || '%')
        AND ($5::numeric IS NULL OR r.total_amount >= $5::numeric)
        AND ($6::numeric IS NULL OR r.total_amount <= $6::numeric)
      GROUP BY r.currency
      ORDER BY r.currency`,
      [
        args.from,
        args.to,
        args.categories,
        // ILIKE's own wildcards are escaped, so a merchant named "100%" is a
        // literal match rather than a pattern.
        args.merchant?.replace(/[\\%_]/g, '\\$&') ?? null,
        args.min_total,
        args.max_total,
      ],
    );

    return result.rows.map((row) => ({
      currency: row.currency,
      receipts: row.receipts,
      total: Number(row.total),
      total_eur: Number(row.total_eur ?? 0),
      unconverted: row.unconverted,
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
