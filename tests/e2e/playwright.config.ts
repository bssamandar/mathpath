/**
 * Browser tests against a running stack (docs/guides/testing.md):
 * web on WEB_URL, studio on STUDIO_URL, the API with SMS_PROVIDER=log writing
 * its log to E2E_API_LOG (the tests read SMS codes from it), and DATABASE_URL
 * for the one step a browser cannot do: granting the first admin role.
 *
 * One worker: the specs share one database and the per-IP SMS limits.
 */
import { defineConfig, devices } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    locale: 'uz-UZ',
    timezoneId: 'Asia/Tashkent',
    screenshot: 'only-on-failure',
    trace: 'off',
    // Locally, a preinstalled Chromium can be used instead of a download.
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [
    // Students and parents mostly use phones (UX §1).
    { name: 'web', testMatch: /web\..*spec\.ts/, use: { ...devices['Pixel 7'] } },
    { name: 'studio', testMatch: /studio\..*spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
});
