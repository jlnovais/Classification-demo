import { createValidateEnv } from './validate-env';

/**
 * Every env var this app reads, grouped by the type it should be coerced to.
 * Keys listed here are normalized before ConfigService ever sees them; keys
 * in `requiredKeys` abort the boot when missing or blank.
 */
export const validateEnv = createValidateEnv({
  stringKeys: [
    'NODE_ENV',
    'POSTGRES_HOST',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
  ],
  numberKeys: ['PORT', 'POSTGRES_PORT'],
  booleanKeys: [],
  requiredKeys: [
    'POSTGRES_HOST',
    'POSTGRES_USER',
    'POSTGRES_DB',
    'ANTHROPIC_API_KEY',
  ],
});
