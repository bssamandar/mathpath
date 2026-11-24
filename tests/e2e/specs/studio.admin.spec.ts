/**
 * Staff side: an admin must enrol 2FA on first sign-in; a future author turns
 * on 2FA in the studio before having a role, so the admin can grant it; the
 * admin locks a parent's account with a reason, and the change appears in the
 * audit log; then asks for a refund of the parent's Payme payment.
 */
import { type Browser, expect, test } from '@playwright/test';
import {
  expectAccessible,
  grantRole,
  paidPaymeOrder,
  newPhone,
  passDevCaptcha,
  signUpParent,
  STUDIO_URL,
  totp,
} from '../helpers';

test('an admin enrols 2FA, locks an account, reads the audit log and asks for a refund', async ({
  page,
  browser,
}) => {
  const adminPhone = newPhone();
  const parentPhone = newPhone();
  const authorPhone = newPhone();
  const password = 'studio-e2e-pass-2026';

  // Two ordinary accounts from the web app; one becomes the first admin.
  for (const [phone, name] of [
    [adminPhone, 'Admin'],
    [parentPhone, 'Nodira'],
    [authorPhone, 'Aziz'],
  ] as const) {
    const context = await browser.newContext();
    await signUpParent(await context.newPage(), phone, password, name);
    await context.close();
  }
  await grantRole(adminPhone, 'admin');
  await paidPaymeOrder(parentPhone);

  await page.goto(`${STUDIO_URL}/`);
  await page.waitForURL('**/login');
  await expectAccessible(page);
  await page.getByLabel('Telefon raqami').fill(`+998${adminPhone}`);
  await page.getByLabel('Parol').fill(password);
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Kirish' }).click();

  // Staff roles need 2FA: enrolment is forced on the first sign-in.
  const secret = page.locator('code.secret');
  await secret.waitFor();
  await page
    .getByLabel('Autentifikator ilovasidagi 6 xonali kod')
    .fill(totp((await secret.textContent()) ?? ''));
  await page.getByRole('button', { name: 'Tasdiqlash' }).click();
  await page.getByRole('button', { name: 'Saqladim, davom etish' }).click();

  // A staff role needs 2FA first: the future author turns it on in the studio
  // without a role, and the admin can then grant one.
  const authorSecret = await enrolWithoutRole(browser, authorPhone, password);
  await page.getByRole('link', { name: 'Foydalanuvchilar' }).click();
  await page.getByLabel('Telefon, ism yoki ID').fill(authorPhone);
  await page.getByRole('button', { name: 'Qidirish' }).click();
  await expect(page.getByText('2FA yoqilgan')).toBeVisible();
  await page.getByRole('button', { name: 'O‘zgartirish' }).click();
  await page.getByRole('checkbox', { name: 'Muallif' }).check();
  await page.getByLabel('Sabab').fill('E2E: new content author');
  await page.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByRole('status').getByText('Saqlandi.')).toBeVisible();
  await signInAsStaff(browser, authorPhone, password, authorSecret);

  await page.getByRole('link', { name: 'Foydalanuvchilar' }).click();
  await page.getByLabel('Telefon, ism yoki ID').fill(parentPhone);
  await page.getByRole('button', { name: 'Qidirish' }).click();
  await expect(page.getByText('Nodira')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'O‘zgartirish' }).click();
  await page.getByLabel('Hisob holati').selectOption('locked');
  await page.getByLabel('Sabab').fill('E2E: the parent reported a lost phone');
  await page.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByRole('status').getByText('Saqlandi.')).toBeVisible();

  await page.getByRole('link', { name: 'Audit jurnali', exact: true }).click();
  await expect(page.getByRole('button', { name: 'user.status_change' }).first()).toBeVisible();
  await expectAccessible(page);

  // Refund the parent's Payme payment: recorded, then finished in the Payme cabinet.
  await page.getByRole('link', { name: 'To‘lovlar' }).click();
  await page.getByLabel('Telefon yoki ID').fill(parentPhone);
  await page.getByRole('button', { name: 'Qidirish' }).click();
  await expect(page.getByText('99 000 so‘m')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Pulni qaytarish' }).click();
  await page.getByLabel('Sabab').fill('E2E: the parent asked within 14 days');
  await page.getByRole('button', { name: 'Qaytarishni tasdiqlash' }).click();
  await expect(page.getByRole('status').getByText('So‘rov yozildi.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pulni qaytarish' })).toHaveCount(0);
  await expectAccessible(page);
});

/** Signs in to the studio without a staff role, turns on 2FA, returns the TOTP secret. */
async function enrolWithoutRole(browser: Browser, phone: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${STUDIO_URL}/login`);
  await page.getByLabel('Telefon raqami').fill(`+998${phone}`);
  await page.getByLabel('Parol').fill(password);
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Kirish' }).click();
  const secret = (await page.locator('code.secret').textContent()) ?? '';
  await page.getByLabel('Autentifikator ilovasidagi 6 xonali kod').fill(totp(secret));
  await page.getByRole('button', { name: 'Tasdiqlash' }).click();
  await page.getByRole('button', { name: 'Saqladim, davom etish' }).click();
  await expect(page.getByText('Ikki bosqichli tasdiq yoqilgan')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Chiqish' }).click();
  await context.close();
  return secret;
}

/** Signs in with the granted role: one TOTP code, then the studio opens. */
async function signInAsStaff(browser: Browser, phone: string, password: string, secret: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${STUDIO_URL}/login`);
  await page.getByLabel('Telefon raqami').fill(`+998${phone}`);
  await page.getByLabel('Parol').fill(password);
  await passDevCaptcha(page);
  await page.getByRole('button', { name: 'Kirish' }).click();
  // The enrolment code's 30-second step is spent; the next step is within the drift window.
  await page
    .getByLabel('Autentifikator ilovasidagi 6 xonali kod')
    .fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Tasdiqlash' }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
  await context.close();
}
