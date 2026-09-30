import { UsageRow, summarizeUsage } from '../../src/receipts/usage-cost';

describe('summarizeUsage', () => {
  it('prices every kind of token at its own rate', () => {
    const { lines, total_cost_usd } = summarizeUsage([
      row({
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
    ]);

    // Haiku 4.5: 1.00 in + 0.50 out + 0.10 cache read + 1.25 cache write.
    expect(lines[0].cost_usd).toBe(2.85);
    expect(total_cost_usd).toBe(2.85);
  });

  it('finds the price of a dated model id by its prefix', () => {
    const { lines } = summarizeUsage([
      row({ model: 'claude-haiku-4-5-20251001', input_tokens: 2_000_000 }),
    ]);

    expect(lines[0].cost_usd).toBe(2);
  });

  it('reports an unknown model as unpriced instead of guessing', () => {
    const usage = summarizeUsage([
      row({ input_tokens: 1_000_000 }),
      row({ model: 'claude-sonnet-4-5', calls: 3, input_tokens: 1_000_000 }),
    ]);

    expect(usage.lines[1].cost_usd).toBeNull();
    expect(usage.unpriced_calls).toBe(3);
    // Only the priced line is in the total; the unpriced one is counted apart.
    expect(usage.total_cost_usd).toBe(1);
  });

  it('adds the lines up across endpoints and models', () => {
    const { total_cost_usd } = summarizeUsage([
      row({ endpoint: 'text', output_tokens: 200_000 }),
      row({ endpoint: 'ask', model: 'claude-opus-5-5', input_tokens: 500_000 }),
    ]);

    // 1.00 (Haiku output) + 2.00 (Opus input).
    expect(total_cost_usd).toBe(3);
  });

  it('reports an empty ledger as costing nothing', () => {
    expect(summarizeUsage([])).toEqual({
      lines: [],
      total_cost_usd: 0,
      unpriced_calls: 0,
    });
  });
});

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    endpoint: 'text',
    model: 'claude-haiku-4-5',
    calls: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...overrides,
  };
}
