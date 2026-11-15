import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('applies safe defaults for local development', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
  });

  it('parses a comma-separated origin list', () => {
    const env = parseEnv({ CORS_ORIGINS: 'https://mathpath.uz, https://studio.mathpath.uz' });
    expect(env.CORS_ORIGINS).toEqual(['https://mathpath.uz', 'https://studio.mathpath.uz']);
  });

  it('rejects invalid values and names the variable', () => {
    expect(() => parseEnv({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => parseEnv({ CORS_ORIGINS: 'not a url' })).toThrow(/CORS_ORIGINS/);
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
