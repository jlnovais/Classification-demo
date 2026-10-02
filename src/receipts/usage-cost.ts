/**
 * What the model calls cost, from the `claude_calls` ledger.
 *
 * The ledger stores tokens, not money. Each call is priced when the totals are
 * read, by `ReceiptsRepository.usageSummary`, at the `model_prices` row in
 * effect when the call was made - so a price change is a new row rather than
 * a backfill, and a past period keeps the prices it was billed at.
 *
 * Pure, taking query results rather than the pool, like `spending-summary.ts`.
 */

/** USD per million tokens, first-party API rates. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** One line of the ledger aggregate: a feature and a model over the period. */
export interface UsageLine {
  endpoint: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** The priced calls only; null when none of the line's calls had a price. */
  cost_usd: number | null;
  /** Calls with no price in effect when they were made. */
  unpriced_calls: number;
}

export interface AiUsage {
  lines: UsageLine[];
  /** The priced calls only; `unpriced_calls` says what it leaves out. */
  total_cost_usd: number;
  unpriced_calls: number;
}

export function summarizeUsage(lines: UsageLine[]): AiUsage {
  return {
    lines,
    total_cost_usd: round(
      lines.reduce((sum, line) => sum + (line.cost_usd ?? 0), 0),
    ),
    unpriced_calls: lines.reduce((sum, line) => sum + line.unpriced_calls, 0),
  };
}

/** To a millionth of a dollar: one Haiku input token is exactly 0.000001. */
function round(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}
