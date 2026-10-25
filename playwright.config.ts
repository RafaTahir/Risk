import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.e2e.ts', timeout: 120_000, workers: 1,
  expect: { timeout: 10_000 },
  use: { baseURL: process.env.RISK_TEST_BASE_URL || 'http://127.0.0.1:3000', viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000, navigationTimeout: 15_000,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
