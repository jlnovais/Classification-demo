interface ValidateEnvOptions {
  numberKeys?: string[];
  requiredKeys?: string[];
}

/**
 * Coerces declared numeric env vars and enforces required keys are present.
 * Kept intentionally small - this app has few enough env vars that a full
 * schema library would be more ceremony than it's worth.
 */
export function createValidateEnv({
  numberKeys = [],
  requiredKeys = [],
}: ValidateEnvOptions) {
  return (config: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...config };

    for (const key of numberKeys) {
      const raw = result[key];
      if (raw === undefined || raw === '') continue;

      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        throw new Error(
          `Environment variable ${key} must be a number, got "${JSON.stringify(raw)}"`,
        );
      }
      result[key] = parsed;
    }

    for (const key of requiredKeys) {
      if (result[key] === undefined || result[key] === '') {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }

    return result;
  };
}
