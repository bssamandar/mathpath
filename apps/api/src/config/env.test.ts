import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };
const secret = 'x'.repeat(32);

describe('parseEnv', () => {
  it('applies safe defaults for local development', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.SMS_PROVIDER).toBe('log');
  });

  it('parses a comma-separated origin list', () => {
    const env = parseEnv({
      ...base,
      CORS_ORIGINS: 'https://mathpath.uz, https://studio.mathpath.uz',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://mathpath.uz', 'https://studio.mathpath.uz']);
  });

  it('closes checkout by default and needs Payme credentials when Payme is on', () => {
    expect(parseEnv(base).PAYMENT_PROVIDERS).toEqual([]);
    expect(() => parseEnv({ ...base, PAYMENT_PROVIDERS: 'payme' })).toThrow(/PAYME_KEY/);
    expect(() => parseEnv({ ...base, PAYMENT_PROVIDERS: 'stripe' })).toThrow(/PAYMENT_PROVIDERS/);
    const env = parseEnv({
      ...base,
      PAYMENT_PROVIDERS: 'payme, click',
      PAYME_MERCHANT_ID: '0123456789abcdef01234567',
      PAYME_KEY: secret,
    });
    expect(env.PAYMENT_PROVIDERS).toEqual(['payme', 'click']);
    expect(env.PAYME_CHECKOUT_URL).toBe('https://checkout.test.paycom.uz');
  });

  it('rejects invalid values and names the variable', () => {
    expect(() => parseEnv({ ...base, PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...base, CORS_ORIGINS: 'not a url' })).toThrow(/CORS_ORIGINS/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => parseEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...base, AUTH_HMAC_SECRET: 'short' })).toThrow(/AUTH_HMAC_SECRET/);
  });

  it('requires real keys in production and refuses the console SMS provider', () => {
    let message = '';
    try {
      parseEnv({ ...base, NODE_ENV: 'production' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/JWT_PRIVATE_KEY/);
    expect(message).toMatch(/AUTH_HMAC_SECRET/);
    expect(message).toMatch(/SMS_PROVIDER/);
    expect(message).toMatch(/S3_ENDPOINT/);
    expect(message).toMatch(/MEDIA_KEY_SECRET/);
  });

  it('accepts development without keys, because they are generated at start-up', () => {
    expect(parseEnv({ ...base, AUTH_HMAC_SECRET: secret }).AUTH_HMAC_SECRET).toBe(secret);
  });

  it('treats empty values from .env.example as unset', () => {
    const env = parseEnv({ ...base, JWT_PRIVATE_KEY: '', AUTH_HMAC_SECRET: '' });
    expect(env.JWT_PRIVATE_KEY).toBeUndefined();
    expect(env.AUTH_HMAC_SECRET).toBeUndefined();
  });

  it('requires the previous key and its ID together', () => {
    expect(() => parseEnv({ ...base, JWT_PREVIOUS_PUBLIC_KEY: 'pem' })).toThrow(
      /JWT_PREVIOUS_KEY_ID/,
    );
  });
});
