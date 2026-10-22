import { defineConfig } from '@playwright/test';
import { browserLaunchOptions } from './test-support/browser-pin.mjs';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 900_000,
  expect: { timeout: 10_000 },
  reporter: [['line'], ['./test-support/browser-case-diagnostics.mjs']],
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: browserLaunchOptions(),
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    navigationTimeout: 10_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'block',
  },
});
