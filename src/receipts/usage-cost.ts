/**
 * What the model calls cost, from the `claude_calls` ledger.
 *
 * The ledger stores tokens, not money, and the price is applied here, when the
 * totals are read: a price change then needs one edit to this table rather
 * than a backfill. The flip side is that a past period is priced at today's
 * rates - the tokens are exact, the dollars are an estimate.
 *
 * Pure, taking query results rather than the pool, like `spending-summary.ts`.
 */

/** USD per million tokens, first-party API rates. */
interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Matched by prefix, so a dated id such as `claude-haiku-4-5-20251001` finds
 * its model. A model missing from this table is reported as unpriced rather
 * than guessed at.
 *
 * ponytail: cache writes are priced at the 5-minute TTL (1.25x input). The
 * app sets no `cache_control` today; if it ever uses the 1-hour TTL (2x), the
 * ledger needs to record which TTL was written.
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write: 1.25,
  },
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
  },
  'claude-opus-5-5': {
    input: 4,
    output: 20,
    cache_read: 0.2,
    cache_write: 5,
  },
  'claude-fable-5-1': {
    input: 10,
    output: 50,
    cache_read: 0.25,
    cache_write: 12.5,
  },
};

/** One line of the ledger aggregate: a feature and a model over the period. */
export interface UsageRow {
  endpoint: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface UsageLine extends UsageRow {
  /** Null when the model has no entry in the price table. */
  cost_usd: number | null;
}

export interface AiUsage {
  lines: UsageLine[];
  /** The priced lines only; `unpriced_calls` says what it leaves out. */
  total_cost_usd: number;
  unpriced_calls: number;
}

export function summarizeUsage(rows: UsageRow[]): AiUsage {
  const lines = rows.map((row) => ({ ...row, cost_usd: costOf(row) }));

  return {
    lines,
    total_cost_usd: round(
      lines.reduce((sum, line) => sum + (line.cost_usd ?? 0), 0),
    ),
    unpriced_calls: lines
      .filter((line) => line.cost_usd === null)
      .reduce((sum, line) => sum + line.calls, 0),
  };
}

function costOf(row: UsageRow): number | null {
  const price = Object.entries(MODEL_PRICES).find(([model]) =>
    row.model.startsWith(model),
  )?.[1];
  if (!price) return null;

  return round(
    (row.input_tokens * price.input +
      row.output_tokens * price.output +
      row.cache_read_input_tokens * price.cache_read +
      row.cache_creation_input_tokens * price.cache_write) /
      1_000_000,
  );
}

/** To a millionth of a dollar: one Haiku input token is exactly 0.000001. */
function round(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}
