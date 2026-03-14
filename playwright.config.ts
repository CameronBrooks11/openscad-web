import { defineConfig } from '@playwright/test';

const serverMode = process.env.E2E_SERVER_MODE === 'dev' ? 'dev' : 'prod';
const isProductionServer = serverMode === 'prod';
const appUrl = isProductionServer ? 'http://localhost:3000/dist/' : 'http://localhost:4000/';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: process.env.CI === 'true',
  retries: 0,
  workers: process.env.CI === 'true' ? 1 : undefined,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: appUrl,
    headless: process.env.PLAYWRIGHT_HEADFUL !== 'true',
    screenshot: 'only-on-failure',
    trace: process.env.CI === 'true' ? 'retain-on-failure' : 'on-first-retry',
    launchOptions: {
      args: process.env.CI === 'true' ? ['--no-sandbox'] : [],
    },
  },
  webServer: {
    command: isProductionServer ? 'npm run start:production' : 'npm run start:development',
    url: appUrl,
    timeout: 180_000,
    reuseExistingServer: process.env.CI !== 'true',
  },
});
