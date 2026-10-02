import { UsageLine, summarizeUsage } from '../../src/receipts/usage-cost';

describe('summarizeUsage', () => {
  it('adds the lines up across endpoints and models', () => {
    const { total_cost_usd } = summarizeUsage([
      line({ endpoint: 'text', cost_usd: 1 }),
      line({ endpoint: 'ask', model: 'claude-opus-5-5', cost_usd: 2 }),
    ]);

    expect(total_cost_usd).toBe(3);
  });

  it('counts unpriced calls apart instead of guessing their cost', () => {
    const usage = summarizeUsage([
      line({ cost_usd: 1 }),
      line({
        model: 'claude-sonnet-4-5',
        calls: 3,
        cost_usd: null,
        unpriced_calls: 3,
      }),
    ]);

    expect(usage.unpriced_calls).toBe(3);
    // Only the priced line is in the total; the unpriced one is counted apart.
    expect(usage.total_cost_usd).toBe(1);
  });

  it('keeps the priced part of a partly priced line', () => {
    // 5 calls made before the model's first price, 5 after.
    const usage = summarizeUsage([
      line({ calls: 10, cost_usd: 0.5, unpriced_calls: 5 }),
    ]);

    expect(usage.total_cost_usd).toBe(0.5);
    expect(usage.unpriced_calls).toBe(5);
  });

  it('rounds away float noise from the sum', () => {
    const { total_cost_usd } = summarizeUsage([
      line({ cost_usd: 0.1 }),
      line({ cost_usd: 0.2 }),
    ]);

    expect(total_cost_usd).toBe(0.3);
  });

  it('reports an empty ledger as costing nothing', () => {
    expect(summarizeUsage([])).toEqual({
      lines: [],
      total_cost_usd: 0,
      unpriced_calls: 0,
    });
  });
});

function line(overrides: Partial<UsageLine> = {}): UsageLine {
  return {
    endpoint: 'text',
    model: 'claude-haiku-4-5',
    calls: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0,
    unpriced_calls: 0,
    ...overrides,
  };
}
