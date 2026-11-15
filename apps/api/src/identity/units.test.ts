import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '@mathpath/config';
import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../config/env';
import { HibpBreachedPasswordChecker } from './breached-passwords';
import { AuthKeys } from './keys';
import { PasswordService } from './password.service';
import { LogSmsSender, maskPhone } from './sms/sms-sender';

const rules = loadConfig().auth.password;
const base = { DATABASE_URL: 'postgres://u:p@localhost/db' };

describe('AuthKeys', () => {
  const pem = (k: ReturnType<typeof generateKeyPairSync>['privateKey']) =>
    k.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('loads an Ed25519 key and accepts the previous key during rotation', () => {
    const current = generateKeyPairSync('ed25519');
    const previous = generateKeyPairSync('ed25519');
    const keys = AuthKeys.fromEnv(
      parseEnv({
        ...base,
        JWT_PRIVATE_KEY: pem(current.privateKey).replaceAll('\n', '\\n'),
        JWT_KEY_ID: 'k2',
        JWT_PREVIOUS_PUBLIC_KEY: previous.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
        JWT_PREVIOUS_KEY_ID: 'k1',
        AUTH_HMAC_SECRET: 's'.repeat(32),
      }),
    );
    expect(keys.keyId).toBe('k2');
    expect(keys.verificationKey('k1')).toBeDefined();
    expect(keys.verificationKey('k2')).toBeDefined();
    expect(keys.verificationKey('k3')).toBeUndefined();
    expect(keys.verificationKey(undefined)).toBeUndefined();
  });

  it('refuses keys that are not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      AuthKeys.fromEnv(parseEnv({ ...base, JWT_PRIVATE_KEY: pem(rsa.privateKey) })),
    ).toThrow(/Ed25519/);
  });

  it('derives independent HMAC keys per purpose', () => {
    const keys = AuthKeys.fromEnv(parseEnv({ ...base, AUTH_HMAC_SECRET: 's'.repeat(32) }));
    expect(keys.hmac('otp', 'x')).not.toBe(keys.hmac('csrf', 'x'));
    expect(keys.hmac('otp', 'x')).toBe(keys.hmac('otp', 'x'));
  });
});

describe('PasswordService', () => {
  const service = new PasswordService(rules, { isBreached: async () => Promise.resolve(true) });

  it('flags hashes made with other parameters for rehashing', async () => {
    const weaker = new PasswordService(
      { ...rules, argon2: { ...rules.argon2, timeCost: 2 } },
      { isBreached: async () => Promise.resolve(false) },
    );
    const oldHash = await weaker.hash('correct horse battery');
    expect(await service.verify(oldHash, 'correct horse battery')).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(service.needsRehash('$2b$10$bcrypt')).toBe(true);
  });

  it('treats a malformed stored hash as a wrong password', async () => {
    expect(await service.verify('garbage', 'anything')).toEqual({ ok: false, needsRehash: false });
  });

  it('refuses breached and over-long passwords', async () => {
    await expect(
      service.assertAcceptable('long-unique-phrase-42', { phone: '+998901234567' }),
    ).rejects.toMatchObject({
      code: 'PASSWORD_BREACHED',
    });
    await expect(
      service.assertAcceptable('a'.repeat(129), { phone: '+998901234567' }),
    ).rejects.toMatchObject({
      code: 'PASSWORD_TOO_LONG',
    });
  });
});

describe('HibpBreachedPasswordChecker', () => {
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const suffix = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

  it('sends only the 5-character prefix and finds the suffix', async () => {
    const fetchFn = vi.fn(
      async () => new Response(`0000000000000000000000000000000000A:0\r\n${suffix}:42\r\n`),
    );
    const checker = new HibpBreachedPasswordChecker(fetchFn as unknown as typeof fetch);
    expect(await checker.isBreached('password')).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.pwnedpasswords.com/range/5BAA6',
      expect.anything(),
    );
  });

  it('ignores padding entries with a count of zero', async () => {
    const fetchFn = async () => new Response(`${suffix}:0\r\n`);
    expect(
      await new HibpBreachedPasswordChecker(fetchFn as typeof fetch).isBreached('password'),
    ).toBe(false);
  });

  it('fails open when the service is unavailable (C-02)', async () => {
    const down = async () => new Response('', { status: 503 });
    const checker = new HibpBreachedPasswordChecker(down as typeof fetch);
    vi.spyOn(checker['logger'], 'warn').mockImplementation(() => undefined);
    expect(await checker.isBreached('password')).toBe(false);
  });
});

describe('SMS helpers', () => {
  it('masks phone numbers in logs', () => {
    expect(maskPhone('+998901234567')).toBe('+99890*****67');
    expect(maskPhone('+12')).toBe('***');
  });

  it('prints messages in development', async () => {
    const sender = new LogSmsSender();
    const log = vi.spyOn(sender['logger'], 'log').mockImplementation(() => undefined);
    await sender.send('+998901234567', 'hello');
    expect(log).toHaveBeenCalledWith('To +99890*****67: hello');
  });
});
