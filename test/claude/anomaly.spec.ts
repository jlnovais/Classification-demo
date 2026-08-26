import { applyCalendarAnomalies } from '../../src/claude/anomaly';

/** A model verdict with nothing flagged, which each case overrides as needed. */
function clean(date: string | null) {
  return { date, is_suspicious: false, flag_reason: null };
}

describe('applyCalendarAnomalies', () => {
  it('flags a receipt issued on a Saturday', () => {
    expect(applyCalendarAnomalies(clean('2026-08-15'))).toEqual({
      is_suspicious: true,
      flag_reason: 'Issued on a Saturday.',
    });
  });

  it('flags a receipt issued on a Sunday', () => {
    expect(applyCalendarAnomalies(clean('2026-08-16'))).toEqual({
      is_suspicious: true,
      flag_reason: 'Issued on a Sunday.',
    });
  });

  it('leaves a weekday receipt alone', () => {
    expect(applyCalendarAnomalies(clean('2026-08-13'))).toEqual({
      is_suspicious: false,
      flag_reason: null,
    });
  });

  it('keeps the model verdict when the date is missing', () => {
    expect(applyCalendarAnomalies(clean(null))).toEqual({
      is_suspicious: false,
      flag_reason: null,
    });
  });

  // A date the model got wrong must not throw, and must not be read as a
  // weekend either - `new Date` would happily accept some of these.
  it.each(['not-a-date', '13/08/2026', '2026-08', '2026-02-30', '2026-13-01'])(
    'ignores the unusable date %p',
    (date) => {
      expect(applyCalendarAnomalies(clean(date))).toEqual({
        is_suspicious: false,
        flag_reason: null,
      });
    },
  );

  it('passes a weekday model flag through untouched', () => {
    expect(
      applyCalendarAnomalies({
        date: '2026-06-10',
        is_suspicious: true,
        flag_reason: 'A single steak at 450.00 EUR is implausible.',
      }),
    ).toEqual({
      is_suspicious: true,
      flag_reason: 'A single steak at 450.00 EUR is implausible.',
    });
  });

  it('joins both reasons when the model flagged a weekend receipt', () => {
    const result = applyCalendarAnomalies({
      date: '2026-08-15',
      is_suspicious: true,
      flag_reason: 'A single steak at 450.00 EUR is implausible.',
    });

    expect(result.is_suspicious).toBe(true);
    expect(result.flag_reason).toBe(
      'A single steak at 450.00 EUR is implausible. Issued on a Saturday.',
    );
  });

  it('adds the missing full stop before joining the reasons', () => {
    expect(
      applyCalendarAnomalies({
        date: '2026-08-16',
        is_suspicious: true,
        flag_reason: 'The total does not match the item lines',
      }).flag_reason,
    ).toBe('The total does not match the item lines. Issued on a Sunday.');
  });

  // A model that sets the boolean but no reason still has to produce a usable
  // one, rather than a flag nobody can act on.
  it('supplies the calendar reason when the model flagged without one', () => {
    expect(
      applyCalendarAnomalies({
        date: '2026-08-15',
        is_suspicious: true,
        flag_reason: '   ',
      }),
    ).toEqual({ is_suspicious: true, flag_reason: 'Issued on a Saturday.' });
  });
});
