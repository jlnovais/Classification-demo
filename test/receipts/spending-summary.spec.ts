import {
  SpendingSummary,
  isEmpty,
  renderSummary,
} from '../../src/receipts/spending-summary';

describe('renderSummary', () => {
  it('renders the totals the model is allowed to quote', () => {
    const block = renderSummary(summary());

    expect(block).toContain('Period: 2026-01-01 to 2026-02-28 (inclusive).');
    expect(block).toContain('- 2026-01: 133.20 EUR over 9 receipts');
    expect(block).toContain('- Food: 210.40 EUR over 14 receipts');
  });

  it('keeps each currency on its own line rather than summing them', () => {
    const block = renderSummary(
      summary({
        months: [
          { month: '2026-01', currency: 'EUR', receipts: 9, total: 133.2 },
          { month: '2026-01', currency: 'USD', receipts: 2, total: 40 },
        ],
      }),
    );

    expect(block).toContain('- 2026-01: 133.20 EUR over 9 receipts');
    expect(block).toContain('- 2026-01: 40.00 USD over 2 receipts');
    // 173.20 is the sum across currencies, which must never be computed here.
    expect(block).not.toContain('173.20');
  });

  // The warning is the whole reason category rows are safe to send: without it
  // the model adds them up and reports a total no query produced.
  it('warns that category totals overlap and month totals do not', () => {
    const block = renderSummary(summary());

    expect(block).toContain('may be added up');
    expect(block).toContain('must never be summed into a total');
  });

  it('omits the code when the receipts carried no currency', () => {
    const block = renderSummary(
      summary({
        months: [{ month: '2026-01', currency: null, receipts: 1, total: 5 }],
      }),
    );

    expect(block).toContain('- 2026-01: 5.00 over 1 receipt');
  });
});

describe('isEmpty', () => {
  it('is empty when no month has any spending', () => {
    expect(isEmpty(summary({ months: [], categories: [] }))).toBe(true);
    expect(isEmpty(summary())).toBe(false);
  });
});

function summary(overrides: Partial<SpendingSummary> = {}): SpendingSummary {
  return {
    from: '2026-01-01',
    to: '2026-02-28',
    months: [{ month: '2026-01', currency: 'EUR', receipts: 9, total: 133.2 }],
    categories: [
      { category: 'Food', currency: 'EUR', receipts: 14, total: 210.4 },
    ],
    ...overrides,
  };
}
