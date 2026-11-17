/** Shared steps for the browser tests. */
import { createHmac, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';

export const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3000';
export const STUDIO_URL = process.env.STUDIO_URL ?? 'http://localhost:3001';
const API_LOG = process.env.E2E_API_LOG ?? '/var/tmp/mp-api.log';

/** How the log sender shows a number (+99890*****67): operator code and last two digits. */
const maskPattern = (phone: string) => `To \\+998${phone.slice(0, 2)}\\*+${phone.slice(-2)}: `;

/**
 * A fresh Uzbek mobile number (9 digits after +998). The API log masks all but
 * the operator code and the last two digits, so a number whose mask already
 * appears in the log (or was handed out in this process) is skipped: otherwise
 * `smsCode` could read another account's code. That allows 100 numbers per run.
 */
const handedOut = new Set<string>();
export function newPhone(): string {
  let log = '';
  try {
    log = readFileSync(API_LOG, 'utf8');
  } catch {
    // No log yet: nothing to collide with.
  }
  for (let tries = 0; tries < 1000; tries++) {
    const phone = `90${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const mask = phone.slice(-2);
    if (handedOut.has(mask) || new RegExp(maskPattern(phone)).test(log)) continue;
    handedOut.add(mask);
    return phone;
  }
  throw new Error('no unused phone mask left; start the e2e stack with a fresh API log');
}

const usedCodes = new Set<string>();

/**
 * The newest SMS code sent to this phone that no earlier call returned (so the
 * consent code after sign-up is not confused with the first), read from the API log
 * (SMS_PROVIDER=log masks the number as +99890*****67). Polls briefly,
 * because the log is written after the response.
 */
export async function smsCode(phone: string): Promise<string> {
  const masked = new RegExp(`${maskPattern(phone)}.*?(\\d{6})`, 'g');
  for (let i = 0; i < 20; i++) {
    const codes = [...readFileSync(API_LOG, 'utf8').matchAll(masked)];
    const code = codes.at(-1)?.[1];
    if (code && !usedCodes.has(`${phone}:${code}`)) {
      usedCodes.add(`${phone}:${code}`);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no SMS code for ${phone.slice(-2)} in ${API_LOG}`);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret, as authenticator apps do. */
export function totp(secret: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const offset = h[19]! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Clicks the development CAPTCHA if the risk engine asked for one. */
export async function passDevCaptcha(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /dev: I am not a robot/ });
  if (await button.isVisible().catch(() => false)) await button.click();
}

/** Signs up a parent through the web app; ends on /parent. */
export async function signUpParent(
  page: Page,
  phone: string,
  password: string,
  firstName = 'Dilnoza',
): Promise<void> {
  await page.goto(`${WEB_URL}/`);
  await page.getByRole('link', { name: 'Men ota-onaman' }).click();
  await page.getByLabel('Telefon raqami').fill(phone);
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Davom etish' }).click();
  await page.getByLabel('SMSdagi kod').fill(await smsCode(phone));
  await page.getByLabel('Ism').fill(firstName);
  await page.getByLabel('Parol', { exact: true }).fill(password);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Hisob yaratish' }).click();
  await page.waitForURL('**/parent');
}

/** Fails the test on serious or critical WCAG 2.1 A/AA violations (UX §6). */
export async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`);
  expect(blocking, `accessibility problems on ${page.url()}`).toEqual([]);
}

/**
 * Grants a role straight in the database. Only for the first admin: in real
 * use another admin grants roles in the studio, which is what the test then
 * checks.
 */
export async function grantRole(phone: string, role: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `INSERT INTO user_roles (user_id, role)
       SELECT id, $2 FROM users WHERE phone_e164 = $1
       ON CONFLICT DO NOTHING`,
      [`+998${phone}`, role],
    );
    if (result.rowCount !== 1) throw new Error(`could not grant ${role} to ${phone.slice(-2)}`);
  } finally {
    await client.end();
  }
}

/**
 * A Payme payment this parent made, written straight to the database as the
 * Payme callbacks would leave it (paid order, active subscription), so the
 * studio has something to refund without a Payme sandbox.
 */
export async function paidPaymeOrder(phone: string, amountTiyin = 9_900_000): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `WITH owner AS (SELECT id FROM users WHERE phone_e164 = $1),
            o AS (
              INSERT INTO orders (id, owner_id, plan_code, plan_interval, student_ids, amount_tiyin,
                                  provider, status, idempotency_key, expires_at, paid_at)
              SELECT gen_random_uuid(), id, 'individual_monthly', 'month', ARRAY[id], $2,
                     'payme', 'paid', gen_random_uuid()::text, now() + interval '1 hour', now()
              FROM owner RETURNING id, owner_id),
            s AS (
              INSERT INTO subscriptions (id, owner_id, order_id, plan_code, status, seats,
                                         price_tiyin, current_period_start, current_period_end)
              SELECT gen_random_uuid(), owner_id, id, 'individual_monthly', 'active', 1, $2,
                     now(), now() + interval '1 month'
              FROM o RETURNING id, order_id)
       INSERT INTO payments (id, order_id, subscription_id, provider, provider_txn_id,
                             amount_tiyin, status, paid_at)
       SELECT gen_random_uuid(), order_id, id, 'payme', substr(md5(random()::text), 1, 24), $2,
              'paid', now()
       FROM s`,
      [`+998${phone}`, amountTiyin],
    );
  } finally {
    await client.end();
  }
}
