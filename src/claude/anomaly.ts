/**
 * The anomaly checks that are cheaper and more reliable to compute than to ask
 * for. Everything semantic - is this price plausible for this item, do these
 * items belong on this merchant's receipt - is the model's job and lives in the
 * system prompt. Day-of-week is not semantic: it is arithmetic on an already
 * extracted date, and the prompt explicitly tells the model not to attempt it.
 *
 * Kept out of `claude.service.ts` so it can be tested without an API key, and
 * typed structurally rather than against `ExtractedReceipt` so there is no
 * import cycle between the two files.
 */

/** Only the fields the calendar checks read. */
export interface AnomalyFields {
  date: string | null;
  is_suspicious: boolean;
  flag_reason: string | null;
}

export interface AnomalyVerdict {
  is_suspicious: boolean;
  flag_reason: string | null;
}

/** The prompt normalizes dates to this shape; anything else is not parsed. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Unions the calendar verdict with the model's, the way `mergeCategories` unions
 * item categories into receipt categories: a flag either side raised is kept,
 * and when both fire the reasons are joined rather than one overwriting the
 * other.
 */
export function applyCalendarAnomalies(
  extracted: AnomalyFields,
): AnomalyVerdict {
  const weekend = weekendDayName(extracted.date);
  if (!weekend) {
    return {
      is_suspicious: extracted.is_suspicious,
      flag_reason: extracted.flag_reason,
    };
  }

  const calendarReason = `Issued on a ${weekend}.`;
  const modelReason = extracted.flag_reason?.trim();

  return {
    is_suspicious: true,
    flag_reason: modelReason
      ? `${withFinalStop(modelReason)} ${calendarReason}`
      : calendarReason,
  };
}

/**
 * The weekday name when `date` falls on a Saturday or Sunday, otherwise null.
 * A null, malformed or impossible date is not an anomaly here - the model is
 * asked to flag a missing date itself - so it must produce no flag rather than
 * throwing or guessing.
 */
function weekendDayName(date: string | null): string | null {
  if (!date || !ISO_DATE.test(date)) return null;

  // Parsed as UTC, and read back with getUTCDay, so the host timezone cannot
  // shift the receipt into the neighbouring day.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;

  const day = parsed.getUTCDay();
  return day === 0 || day === 6 ? WEEKDAY_NAMES[day] : null;
}

/** Keeps the joined reason readable when the model omitted its own full stop. */
function withFinalStop(reason: string): string {
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}
