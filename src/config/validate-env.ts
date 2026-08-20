export type EnvLike = Record<string, unknown>;

function emptyToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function toOptionalNumber(key: string, value: unknown): number | undefined {
  const v = emptyToUndefined(value);
  if (v === undefined || v === null) return undefined;

  const parsed = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(parsed)) {
    const shown = typeof v === 'string' ? v : JSON.stringify(v);
    throw new Error(
      `Environment variable ${key} must be a number, got "${shown}"`,
    );
  }
  return parsed;
}

/**
 * Parses env-style booleans. Unset or empty values use `defaultValue`.
 * False when the value is `false` or `0` (case-insensitive, trimmed);
 * any other non-empty value is true.
 */
export function parseEnvBoolean(
  value: unknown,
  defaultValue: boolean,
): boolean {
  const v = emptyToUndefined(value);
  if (v === undefined || v === null) return defaultValue;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    return !(normalized === 'false' || normalized === '0');
  }
  return Boolean(v);
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (emptyToUndefined(value) === undefined) return undefined;
  return parseEnvBoolean(value, false);
}

export interface ValidateEnvOptions {
  stringKeys?: readonly string[];
  numberKeys?: readonly string[];
  booleanKeys?: readonly string[];
  requiredKeys?: readonly string[];
}

/**
 * Creates a ConfigModule-compatible env validator that normalizes values
 * based on the provided key lists, then enforces that required keys are
 * present. Each app passes its own keys.
 *
 * Kept intentionally small - this app has few enough env vars that a full
 * schema library would be more ceremony than it's worth.
 */
export function createValidateEnv({
  stringKeys = [],
  numberKeys = [],
  booleanKeys = [],
  requiredKeys = [],
}: ValidateEnvOptions) {
  return function validateEnv(config: EnvLike): EnvLike {
    const next: EnvLike = { ...config };

    for (const key of stringKeys) next[key] = emptyToUndefined(next[key]);
    for (const key of numberKeys) next[key] = toOptionalNumber(key, next[key]);
    for (const key of booleanKeys) next[key] = toOptionalBoolean(next[key]);

    for (const key of requiredKeys) {
      if (emptyToUndefined(next[key]) === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }

    return next;
  };
}
