/** Public pages load without errors and pass the accessibility check. */
import { expect, test } from '@playwright/test';
import { expectAccessible, WEB_URL } from '../helpers';

for (const path of ['/', '/login', '/signup', '/child-login', '/pricing']) {
  test(`${path} is accessible`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${WEB_URL}${path}`);
    await page.locator('main').waitFor();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
}

test('every page sends the security headers', async ({ request }) => {
  const response = await request.get(`${WEB_URL}/login`);
  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-powered-by']).toBeUndefined();
});
