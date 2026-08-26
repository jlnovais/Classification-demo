import {
  MIN_CATEGORY_SAMPLE,
  OUTLIER_MULTIPLE,
  assessHistory,
} from '../../src/receipts/history-anomalies';

describe('assessHistory', () => {
  it('leaves a clean receipt alone when the history is empty', () => {
    expect(assessHistory(receipt(), { duplicate: null, spreads: [] })).toEqual({
      is_suspicious: false,
      flag_reason: null,
      duplicate_of: null,
    });
  });

  it('preserves the model verdict when no history check fires', () => {
    const flagged = receipt({
      is_suspicious: true,
      flag_reason: 'A laptop on a pharmacy receipt',
    });

    // The model's own sentence is stored verbatim, without a full stop added:
    // only a joined reason gets normalized.
    expect(assessHistory(flagged, { duplicate: null, spreads: [] })).toEqual({
      is_suspicious: true,
      flag_reason: 'A laptop on a pharmacy receipt',
      duplicate_of: null,
    });
  });

  it('names the matched receipt and its submission day', () => {
    const verdict = assessHistory(receipt(), {
      duplicate: {
        id: 'earlier-receipt',
        created_at: new Date('2026-08-20T22:30:00Z'),
      },
      spreads: [],
    });

    expect(verdict.is_suspicious).toBe(true);
    expect(verdict.duplicate_of).toBe('earlier-receipt');
    expect(verdict.flag_reason).toBe(
      'Same merchant, date and total as receipt earlier-receipt, submitted on ' +
        '2026-08-20; possible duplicate submission.',
    );
  });

  it('flags a total far above the spread of its categories', () => {
    const verdict = assessHistory(receipt({ total_amount: 450 }), {
      duplicate: null,
      spreads: [{ category: 'Food', sample_size: 30, p90: 25 }],
    });

    expect(verdict.is_suspicious).toBe(true);
    expect(verdict.flag_reason).toBe(
      `Total 450.00 EUR is more than ${OUTLIER_MULTIPLE}x the 25.00 EUR ` +
        '90th percentile of 30 earlier Food receipts.',
    );
  });

  it('does not flag a total merely at the top of the spread', () => {
    // Exactly on the multiple is inside the band, not outside it.
    const verdict = assessHistory(
      receipt({ total_amount: 25 * OUTLIER_MULTIPLE }),
      {
        duplicate: null,
        spreads: [{ category: 'Food', sample_size: 30, p90: 25 }],
      },
    );

    expect(verdict.is_suspicious).toBe(false);
    expect(verdict.flag_reason).toBeNull();
  });

  it('ignores a category with too little history to compare against', () => {
    const verdict = assessHistory(receipt({ total_amount: 450 }), {
      duplicate: null,
      spreads: [
        { category: 'Food', sample_size: MIN_CATEGORY_SAMPLE - 1, p90: 25 },
      ],
    });

    expect(verdict.is_suspicious).toBe(false);
    expect(verdict.flag_reason).toBeNull();
  });

  it('measures against the priciest category on the receipt', () => {
    // 300 dwarfs the Food spread but sits inside the Electronics one, and a
    // receipt covering both is not an outlier for having a laptop on it.
    const spreads = [
      { category: 'Food', sample_size: 40, p90: 25 },
      { category: 'Electronics', sample_size: 12, p90: 400 },
    ];

    expect(
      assessHistory(receipt({ total_amount: 300 }), {
        duplicate: null,
        spreads,
      }).is_suspicious,
    ).toBe(false);

    const verdict = assessHistory(receipt({ total_amount: 5000 }), {
      duplicate: null,
      spreads,
    });
    expect(verdict.is_suspicious).toBe(true);
    expect(verdict.flag_reason).toContain('earlier Electronics receipts');
  });

  it('skips the outlier check when the receipt has no total', () => {
    // A missing total is the model's own check to flag; there is nothing to
    // compare here, and it must not be read as a zero.
    const verdict = assessHistory(receipt({ total_amount: null }), {
      duplicate: null,
      spreads: [{ category: 'Food', sample_size: 30, p90: 25 }],
    });

    expect(verdict.is_suspicious).toBe(false);
  });

  it('joins every reason when the model and both history checks fire', () => {
    const verdict = assessHistory(
      receipt({
        total_amount: 450,
        is_suspicious: true,
        flag_reason: 'A single steak at 450.00 EUR is implausible.',
      }),
      {
        duplicate: {
          id: 'earlier-receipt',
          created_at: new Date('2026-08-20T09:00:00Z'),
        },
        spreads: [{ category: 'Food', sample_size: 30, p90: 25 }],
      },
    );

    expect(verdict.duplicate_of).toBe('earlier-receipt');
    expect(verdict.flag_reason).toBe(
      'A single steak at 450.00 EUR is implausible. ' +
        'Same merchant, date and total as receipt earlier-receipt, submitted ' +
        'on 2026-08-20; possible duplicate submission. ' +
        `Total 450.00 EUR is more than ${OUTLIER_MULTIPLE}x the 25.00 EUR ` +
        '90th percentile of 30 earlier Food receipts.',
    );
  });

  it('omits the currency from the reason when the receipt has none', () => {
    const verdict = assessHistory(
      receipt({ total_amount: 450, currency: null }),
      {
        duplicate: null,
        spreads: [{ category: 'Food', sample_size: 30, p90: 25 }],
      },
    );

    expect(verdict.flag_reason).toBe(
      `Total 450.00 is more than ${OUTLIER_MULTIPLE}x the 25.00 ` +
        '90th percentile of 30 earlier Food receipts.',
    );
  });
});

/** Only the extraction fields the history checks read. */
function receipt(overrides: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...overrides };
}

function base() {
  return {
    total_amount: 4.5 as number | null,
    currency: 'EUR' as string | null,
    categories: ['Food'],
    is_suspicious: false,
    flag_reason: null as string | null,
  };
}
