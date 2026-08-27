import { AnomalyVerdict, unionAnomalies } from '../claude/anomaly';

/**
 * The anomaly checks that need the history of previously stored receipts, as
 * opposed to the semantic ones the model runs on a single receipt
 * (`claude.service.ts`) and the calendar one computed from the extracted date
 * (`claude/anomaly.ts`).
 *
 * The split is the point of this file: an exact duplicate and a comparison
 * against past spending are *rules* - a key lookup and an aggregate - and SQL
 * answers both exactly, whereas the model has no view of the history and would
 * be guessing. What stays with the model is judgement about a single receipt:
 * whether an item plausibly belongs on this merchant's bill, whether the total
 * reconciles with the lines.
 *
 * The functions here are pure, taking the query results rather than the pool,
 * so the thresholds can be tested without a database.
 */

/**
 * How many earlier receipts a category needs before its spread is treated as
 * meaningful. A category with three receipts in it has no distribution to speak
 * of, and flagging against one produces noise on a young database.
 */
export const MIN_CATEGORY_SAMPLE = 8;

/**
 * How far above the historical 90th percentile a total has to land to count as
 * an outlier. Deliberately blunt: this check exists to catch the order of
 * magnitude the model waved through (a 450 EUR steak), not to second-guess an
 * expensive-but-ordinary receipt.
 */
export const OUTLIER_MULTIPLE = 4;

/** An earlier receipt sharing this one's deduplication key. */
export interface DuplicateMatch {
  id: string;
  created_at: Date;
}

/** The historical total spread for one category, from `categorySpreads`. */
export interface CategorySpread {
  category: string;
  sample_size: number;
  /** The 90th percentile of the totals of earlier receipts in this category. */
  p90: number;
}

/** Everything the history checks read, gathered by the repository. */
export interface ReceiptHistory {
  duplicate: DuplicateMatch | null;
  spreads: CategorySpread[];
}

/** The fields of an extraction the history checks read. */
export interface HistoryFields extends AnomalyVerdict {
  total_amount: number | null;
  currency: string | null;
  categories: readonly string[];
}

/**
 * The verdict stored against the receipt: the anomaly flag as it stands after
 * every check, plus the earlier receipt this one duplicates, if any. The id is
 * carried separately from the sentence because it is the useful half for a
 * reviewer - a sentence cannot be joined back to the original row.
 */
export interface ReceiptVerdict extends AnomalyVerdict {
  duplicate_of: string | null;
}

/**
 * Folds the history checks into the verdict the model and the calendar check
 * already produced. Both checks can fire at once, and `unionAnomalies` keeps
 * both sentences.
 */
export function assessHistory(
  extracted: HistoryFields,
  history: ReceiptHistory,
): ReceiptVerdict {
  const duplicate = history.duplicate;

  return {
    ...unionAnomalies(
      extracted,
      duplicate && duplicateReason(duplicate),
      outlierReason(extracted, history.spreads),
    ),
    duplicate_of: duplicate?.id ?? null,
  };
}

/**
 * Worded as a candidate rather than a verdict. The key is exact, but two
 * genuinely separate purchases can share it - the same coffee bought twice in a
 * day - so the flag is there for a human to resolve, and the earlier receipt is
 * named so they can.
 */
function duplicateReason(duplicate: DuplicateMatch): string {
  return (
    `Same merchant, date and total as receipt ${duplicate.id}, submitted on ` +
    `${isoDay(duplicate.created_at)}; possible duplicate submission.`
  );
}

/**
 * Compares the total against what earlier receipts in the same categories cost.
 * The benchmark is the *highest* percentile among the categories present, so a
 * receipt only trips the check when it dwarfs even the priciest category it
 * belongs to: a 150 EUR supermarket run that is Food and Electronics is judged
 * against Electronics, not Food. Categories without enough history are ignored,
 * and when none of them qualify the check simply does not run.
 */
function outlierReason(
  extracted: HistoryFields,
  spreads: CategorySpread[],
): string | null {
  const total = extracted.total_amount;
  if (total === null || total <= 0) return null;

  const eligible = spreads.filter(
    (spread) => spread.sample_size >= MIN_CATEGORY_SAMPLE && spread.p90 > 0,
  );
  if (eligible.length === 0) return null;

  const benchmark = eligible.reduce((highest, spread) =>
    spread.p90 > highest.p90 ? spread : highest,
  );
  if (total <= benchmark.p90 * OUTLIER_MULTIPLE) return null;

  const currency = extracted.currency ? ` ${extracted.currency}` : '';
  return (
    `Total ${total.toFixed(2)}${currency} is more than ${OUTLIER_MULTIPLE}x the ` +
    `${benchmark.p90.toFixed(2)}${currency} 90th percentile of ` +
    `${benchmark.sample_size} earlier ${benchmark.category} receipts.`
  );
}

/** The submission day of the matched receipt, in the receipts' own date shape. */
function isoDay(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 10);
}
