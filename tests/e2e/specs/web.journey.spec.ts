/**
 * The main family journey on a phone: a parent signs up, adds a child with
 * SMS-confirmed consent, the child signs in with the family code and PIN and
 * answers a practice question; then the parent signs in again.
 */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  newPhone,
  passDevCaptcha,
  signUpParent,
  smsCode,
  WEB_URL,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

const phone = newPhone();
const password = 'quiet-river-71-lamp';
const nickname = `Dilya${phone.slice(-3)}`;
const pin = '2580';
let familyCode = '';

test('a parent signs up and is asked to add a child', async ({ page }) => {
  await signUpParent(page, phone, password);
  await expect(page.getByRole('link', { name: 'Farzand qo‘shish' })).toBeVisible();
  // The session lives in HttpOnly cookies only (ADR-0005).
  const cookies = await page.context().cookies();
  expect(cookies.length).toBeGreaterThan(0);
  expect(cookies.every((c) => c.httpOnly)).toBe(true);
  await expectAccessible(page);
});

test('the parent adds a child after confirming consent by SMS', async ({ page }) => {
  await page.goto(`${WEB_URL}/login`);
  await page.getByLabel('Telefon raqami').fill(phone);
  await page.getByLabel('Parol').fill(password);
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Kirish' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));

  await page.goto(`${WEB_URL}/parent/children/new`);
  await page.getByLabel('Farzandingiz ismi').fill('Dilnoza');
  await page.getByRole('textbox', { name: 'Taxallus' }).fill(nickname);
  await page.getByLabel('Sinf').selectOption('5');
  // A too simple PIN is refused before any SMS is sent.
  await page.getByLabel('Kirish uchun PIN').fill('1234');
  await page.getByRole('button', { name: 'SMS bilan tasdiqlash' }).click();
  await expect(page.getByText('Bu PIN juda oson. Boshqasini tanlang.')).toBeVisible();

  await page.getByLabel('Kirish uchun PIN').fill(pin);
  await page.getByLabel(/o‘qish ma’lumotlarini saqlashiga roziman/).check();
  await page.getByRole('button', { name: 'SMS bilan tasdiqlash' }).click();
  await page.getByLabel('SMSdagi kod').fill(await smsCode(phone));
  await page.waitForURL('**/parent');
  await expect(page.locator('.child-card', { hasText: 'Dilnoza' })).toBeVisible();
  // The family code is shown once the family has a child.
  const code = page.getByText(/Farzandlaringiz kirishi uchun oila kodi: [A-Z0-9]+/);
  await expect(code).toBeVisible();
  familyCode = /: ([A-Z0-9]+)/.exec((await code.textContent()) ?? '')?.[1] ?? '';
  expect(familyCode).not.toBe('');
  // CI's load test clones this child into its students (tests/load).
  if (process.env.E2E_FAMILY_FILE) {
    writeFileSync(process.env.E2E_FAMILY_FILE, JSON.stringify({ familyCode, nickname, pin }));
  }
  await expectAccessible(page);
});

test('the child signs in with the family code and practises', async ({ browser }) => {
  // A separate browser profile: the child's own phone.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/child-login`);
  await page.getByLabel('Oila kodi').fill(familyCode);
  await page.getByLabel('MathPath’dagi isming').fill(nickname);
  await page.getByLabel('PIN').fill(pin);
  await page.getByRole('button', { name: 'Kirish' }).click();
  await page.waitForURL('**/student');
  await expect(page.getByRole('heading', { name: 'Kurslaring' })).toBeVisible();
  await expectAccessible(page);

  // The demo course (db seed) and its first topic.
  await page.locator('a.card[href^="/course/"]').first().click();
  await page.locator('a.card[href^="/learn/"]').first().click();
  await page.locator('.stepper').waitFor();
  // Step through the lesson to its practice step ("2-qadam / 4 · Mashq"); the
  // practice panel loads its status before the start button appears.
  const position = page.getByText(/^\d+-qadam \/ \d+ · /);
  for (let step = 0; step < 10 && !/· Mashq$/.test((await position.textContent()) ?? ''); step++) {
    await page.getByRole('button', { name: 'Keyingisi' }).last().click();
  }
  await page.getByRole('button', { name: /Mashqni boshlash|Davom ettirish/ }).click();

  // Answer the first question (right or wrong does not matter here); the
  // server grades it and the page shows feedback.
  await page.locator('.question').waitFor();
  if ((await page.locator('.choice').count()) > 0) {
    await page.locator('.choice').first().click();
  } else {
    await page.locator('.pad').getByRole('button', { name: '9', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Tekshirish' }).click();
  await expect(page.locator('.feedback')).toBeVisible();
  await context.close();
});

test('a wrong password is refused and the right one signs the parent in', async ({ page }) => {
  await page.goto(`${WEB_URL}/login`);
  await page.getByLabel('Telefon raqami').fill(phone);
  await page.getByLabel('Parol').fill('wrong-password-123');
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Kirish' }).click();
  await expect(page.locator('p.error')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Parol').fill(password);
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Kirish' }).click();
  await passDevCaptcha(page);
  await page.waitForURL('**/parent');
});
