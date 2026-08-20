import { validateEnv } from '../../src/config/env.validation';
import {
  createValidateEnv,
  parseEnvBoolean,
} from '../../src/config/validate-env';

const baseEnv = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_USER: 'postgres',
  POSTGRES_DB: 'classification_demo',
  ANTHROPIC_API_KEY: 'sk-test',
};

describe('createValidateEnv', () => {
  it('coerces declared number keys to numbers', () => {
    const validate = createValidateEnv({ numberKeys: ['PORT'] });

    expect(validate({ PORT: '3000' }).PORT).toBe(3000);
  });

  it('throws when a declared number key is not numeric', () => {
    const validate = createValidateEnv({ numberKeys: ['PORT'] });

    expect(() => validate({ PORT: 'abc' })).toThrow(
      'Environment variable PORT must be a number, got "abc"',
    );
  });

  it('normalizes blank values to undefined so code defaults apply', () => {
    const validate = createValidateEnv({
      stringKeys: ['POSTGRES_PASSWORD'],
      numberKeys: ['PORT'],
    });

    const result = validate({ POSTGRES_PASSWORD: '', PORT: '  ' });

    expect(result.POSTGRES_PASSWORD).toBeUndefined();
    expect(result.PORT).toBeUndefined();
  });

  it('coerces declared boolean keys', () => {
    const validate = createValidateEnv({ booleanKeys: ['DEBUG'] });

    expect(validate({ DEBUG: 'true' }).DEBUG).toBe(true);
    expect(validate({ DEBUG: '0' }).DEBUG).toBe(false);
    expect(validate({}).DEBUG).toBeUndefined();
  });

  it('throws when a required key is missing or blank', () => {
    const validate = createValidateEnv({ requiredKeys: ['ANTHROPIC_API_KEY'] });

    expect(() => validate({})).toThrow(
      'Missing required environment variable: ANTHROPIC_API_KEY',
    );
    expect(() => validate({ ANTHROPIC_API_KEY: '' })).toThrow(
      'Missing required environment variable: ANTHROPIC_API_KEY',
    );
  });

  it('passes through keys it was not told about', () => {
    const validate = createValidateEnv({ numberKeys: ['PORT'] });

    expect(validate({ SOMETHING_ELSE: 'kept' }).SOMETHING_ELSE).toBe('kept');
  });
});

describe('parseEnvBoolean', () => {
  it.each([
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['true', true],
    ['1', true],
    ['anything', true],
  ])('parses %s as %s', (value, expected) => {
    expect(parseEnvBoolean(value, false)).toBe(expected);
  });

  it('falls back to the default when unset or blank', () => {
    expect(parseEnvBoolean(undefined, true)).toBe(true);
    expect(parseEnvBoolean('', true)).toBe(true);
  });
});

describe('validateEnv (app keys)', () => {
  it('accepts a complete environment', () => {
    const result = validateEnv({
      ...baseEnv,
      PORT: '3000',
      POSTGRES_PORT: '5432',
    });

    expect(result.PORT).toBe(3000);
    expect(result.POSTGRES_PORT).toBe(5432);
  });

  it.each(Object.keys(baseEnv))('requires %s', (key) => {
    const env: Record<string, unknown> = { ...baseEnv };
    delete env[key];

    expect(() => validateEnv(env)).toThrow(
      `Missing required environment variable: ${key}`,
    );
  });
});
