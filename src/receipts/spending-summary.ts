/**
 * The aggregates behind `GET /api/insights`, and the block of text they are
 * rendered into for the model.
 *
 * The split matters for the same reason as in `history-anomalies.ts`: the
 * numbers are a *rule* - SQL sums them exactly - and the model is only asked to
 * write about them. It never sees a receipt, only the totals below, so it has
 * nothing to add up wrongly and nothing to invent a figure from.
 *
 * Everything here is pure, taking query results rather than the pool, so the
 * rendering can be tested without PostgreSQL or an API key.
 */

/** Spending in one category, in one currency, over the requested range. */
export interface CategoryTotal {
  category: string;
  currency: string | null;
  receipts: number;
  total: number;
}

/** Spending in one calendar month, in one currency. `month` is `YYYY-MM`. */
export interface MonthTotal {
  month: string;
  currency: string | null;
  receipts: number;
  total: number;
}

/**
 * Spending in one calendar month with every currency converted to EUR. The
 * only cross-currency figure in the summary, and SQL produces it, not the
 * model. `unconverted` counts the receipts left out for lack of a rate - rows
 * from before the conversion existed, or a lookup that failed.
 */
export interface MonthEurTotal {
  month: string;
  receipts: number;
  total_eur: number;
  unconverted: number;
}

/** Everything the report is written from, as gathered by the repository. */
export interface SpendingSummary {
  from: string;
  to: string;
  categories: CategoryTotal[];
  months: MonthTotal[];
  months_eur: MonthEurTotal[];
}

/** Nothing completed in the range, so there is nothing to write about. */
export function isEmpty(summary: SpendingSummary): boolean {
  return summary.months.length === 0;
}

/**
 * Renders the aggregates as the text handed to the model.
 *
 * Two things are stated in the block rather than in the system prompt, because
 * they are properties of *these* numbers rather than of the task: that category
 * totals overlap - a receipt with two categories is counted in full under both,
 * so adding them up overstates the spend - and that each currency is a separate
 * running total. Without the first the model reports an inflated grand total
 * that no query ever produced; without the second it adds euros to dollars.
 */
export function renderSummary(summary: SpendingSummary): string {
  return [
    `Period: ${summary.from} to ${summary.to} (inclusive).`,
    '',
    'Totals per month, one line per month and currency. These count each',
    'receipt exactly once, so they are the only lines that may be added up:',
    ...summary.months.map(
      (month) =>
        `- ${month.month}: ${money(month.total, month.currency)} over ` +
        `${plural(month.receipts, 'receipt')}`,
    ),
    '',
    'Totals per category, one line per category and currency. A receipt with',
    'more than one category is counted in full under each of them, so these',
    'lines overlap and must never be summed into a total:',
    ...summary.categories.map(
      (entry) =>
        `- ${entry.category}: ${money(entry.total, entry.currency)} over ` +
        `${plural(entry.receipts, 'receipt')}`,
    ),
    ...renderEur(summary.months_eur),
  ].join('\n');
}

/**
 * The EUR section, stated as a second view of the month lines rather than more
 * spending - without that the model adds the converted total to the EUR line it
 * already reported. Omitted when nothing in the period could be converted.
 */
function renderEur(months: MonthEurTotal[]): string[] {
  if (!months.some((month) => month.receipts > 0)) return [];

  return [
    '',
    'Totals per month with every currency converted to EUR at the ECB rate on',
    "each receipt's date. This is the same spending as the month lines above,",
    'not additional spending. Each receipt is counted once, so these lines may',
    'be added up, and they are the only figures that combine currencies:',
    ...months.map(
      (month) =>
        `- ${month.month}: ${money(month.total_eur, 'EUR')} over ` +
        `${plural(month.receipts, 'receipt')}` +
        (month.unconverted > 0
          ? ` (${plural(month.unconverted, 'receipt')} could not be converted and ${month.unconverted === 1 ? 'is' : 'are'} left out)`
          : ''),
    ),
  ];
}

/** Two decimals and the currency code, or no code when the receipts carried none. */
function money(amount: number, currency: string | null): string {
  return currency ? `${amount.toFixed(2)} ${currency}` : amount.toFixed(2);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
