import { parseQueryArgs } from '../../src/receipts/receipt-query';

describe('parseQueryArgs', () => {
  it('accepts well-formed arguments', () => {
    expect(
      parseQueryArgs(
        args({ categories: ['Food'], merchant: '  Pingo Doce ', min_total: 5 }),
      ),
    ).toEqual({
      ok: true,
      args: {
        from: '2026-06-01',
        to: '2026-08-31',
        categories: ['Food'],
        merchant: 'Pingo Doce',
        min_total: 5,
        max_total: null,
      },
    });
  });

  it('reads missing filters, a blank merchant and an empty list as no filter', () => {
    const parsed = parseQueryArgs({
      from: '2026-06-01',
      to: '2026-08-31',
      categories: [],
      merchant: '   ',
    });

    expect(parsed).toMatchObject({
      ok: true,
      args: { categories: null, merchant: null, min_total: null },
    });
  });

  it.each([
    ['a non-object', 'from 2026-06-01'],
    ['an array', []],
    ['an unknown key', args({ sql: 'DROP TABLE receipts' })],
    ['a malformed date', args({ from: '01/06/2026' })],
    ['a day that does not exist', args({ to: '2026-02-30' })],
    ['a reversed range', args({ from: '2026-09-01' })],
    ['a category outside the taxonomy', args({ categories: ['Dinners'] })],
    ['a non-string merchant', args({ merchant: 42 })],
    ['an overlong merchant', args({ merchant: 'x'.repeat(101) })],
    ['a negative total', args({ min_total: -1 })],
    ['a non-finite total', args({ max_total: Infinity })],
    ['min above max', args({ min_total: 50, max_total: 10 })],
  ])('rejects %s', (_, input) => {
    expect(parseQueryArgs(input)).toMatchObject({ ok: false });
  });
});

function args(overrides: Record<string, unknown> = {}) {
  return {
    from: '2026-06-01',
    to: '2026-08-31',
    categories: null,
    merchant: null,
    min_total: null,
    max_total: null,
    ...overrides,
  };
}
