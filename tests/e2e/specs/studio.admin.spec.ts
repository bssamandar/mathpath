/**
 * Staff side: an admin must enrol 2FA on first sign-in, then locks a parent's
 * account with a reason, and the change appears in the audit log; then asks
 * for a refund of the parent's Payme payment.
 */
import { expect, test } from '@playwright/test';
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
  const password = 'studio-e2e-pass-2026';

  // Two ordinary accounts from the web app; one becomes the first admin.
  for (const [phone, name] of [
    [adminPhone, 'Admin'],
    [parentPhone, 'Nodira'],
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
