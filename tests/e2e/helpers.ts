/** Shared steps for the browser tests. */
import { createHmac, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';

export const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3000';
export const STUDIO_URL = process.env.STUDIO_URL ?? 'http://localhost:3001';
const API_LOG = process.env.E2E_API_LOG ?? '/var/tmp/mp-api.log';

/** A fresh Uzbek mobile number (9 digits after +998), so runs never collide. */
export function newPhone(): string {
  return `90${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
}

const usedCodes = new Set<string>();

/**
 * The newest SMS code sent to this phone that no earlier call returned (so the
 * consent code after sign-up is not confused with the first), read from the API log
 * (SMS_PROVIDER=log masks the number as +99890*****67). Polls briefly,
 * because the log is written after the response.
 */
export async function smsCode(phone: string): Promise<string> {
  const masked = new RegExp(
    `To \\+998${phone.slice(0, 2)}\\*+${phone.slice(-2)}: .*?(\\d{6})`,
    'g',
  );
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
