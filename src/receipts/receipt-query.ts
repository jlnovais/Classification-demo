import { CATEGORIES } from '../claude/claude.service';

/**
 * The arguments of the `query_receipts` tool once validated. Everything the
 * model chose reaches the database through this type only.
 */
export interface ReceiptQuery {
  from: string;
  to: string;
  categories: string[] | null;
  merchant: string | null;
  min_total: number | null;
  max_total: number | null;
}

/** One row per currency, as `ReceiptsRepository.queryReceipts` returns it. */
export interface CurrencyTotal {
  currency: string | null;
  receipts: number;
  total: number;
  total_eur: number;
  unconverted: number;
}

/** One tool call, as the `/api/ask` response reports it. */
export interface QueryLog {
  input: unknown;
  result?: CurrencyTotal[];
  error?: string;
}

export type ParsedQuery =
  { ok: true; args: ReceiptQuery } | { ok: false; error: string };

const KEYS = new Set([
  'from',
  'to',
  'categories',
  'merchant',
  'min_total',
  'max_total',
]);
const TAXONOMY = new Set<string>(CATEGORIES);
const MAX_MERCHANT_LENGTH = 100;

/**
 * The trust boundary of `/api/ask`. The tool is declared `strict`, so the API
 * already holds the model to the schema - this re-checks it anyway, and adds
 * what a schema cannot say: that a date exists, that the range is ordered. A
 * rejection is returned to the model as an error `tool_result` so it can
 * correct itself; nothing invalid reaches the query.
 *
 * A missing key is read as null, the same as "no filter".
 */
export function parseQueryArgs(input: unknown): ParsedQuery {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('The arguments must be an object.');
  }

  const unknown = Object.keys(input).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) {
    return fail(`Unknown argument(s): ${unknown.join(', ')}.`);
  }

  const args = input as Record<string, unknown>;
  const { from, to } = args;
  if (!isDay(from) || !isDay(to)) {
    return fail('"from" and "to" must be real dates written as YYYY-MM-DD.');
  }
  if (from > to) {
    return fail('"from" must not be later than "to".');
  }

  const categories = args.categories ?? null;
  if (
    categories !== null &&
    !(
      Array.isArray(categories) &&
      categories.every((c) => typeof c === 'string' && TAXONOMY.has(c))
    )
  ) {
    return fail(
      `"categories" must be null or a list drawn from: ${CATEGORIES.join(', ')}.`,
    );
  }

  const merchant = args.merchant ?? null;
  if (merchant !== null && typeof merchant !== 'string') {
    return fail('"merchant" must be a string or null.');
  }
  const trimmed = merchant?.trim() || null;
  if (trimmed !== null && trimmed.length > MAX_MERCHANT_LENGTH) {
    return fail(
      `"merchant" must be at most ${MAX_MERCHANT_LENGTH} characters.`,
    );
  }

  const min = args.min_total ?? null;
  const max = args.max_total ?? null;
  if (!isAmount(min) || !isAmount(max)) {
    return fail(
      '"min_total" and "max_total" must be null or non-negative numbers.',
    );
  }
  if (min !== null && max !== null && min > max) {
    return fail('"min_total" must not be larger than "max_total".');
  }

  return {
    ok: true,
    args: {
      from,
      to,
      // An empty list is read as "any category" rather than as a filter
      // that matches nothing.
      categories:
        categories !== null && categories.length > 0
          ? (categories as string[])
          : null,
      merchant: trimmed,
      min_total: min,
      max_total: max,
    },
  };
}

function fail(error: string): ParsedQuery {
  return { ok: false, error };
}

/** A real calendar day: '2026-02-30' has the right shape but does not exist. */
function isDay(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().startsWith(value)
  );
}

function isAmount(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}
