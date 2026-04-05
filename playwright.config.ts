import { defineConfig } from '@playwright/test';

const serverMode = process.env.E2E_SERVER_MODE ?? 'prod';
const isDevelopmentServer = serverMode === 'dev';
const isPublishRootServer = serverMode === 'publish-root';
const isPublishSubpathServer = serverMode === 'publish-subpath';
const appUrl = isDevelopmentServer
  ? 'http://localhost:4000/'
  : isPublishRootServer
    ? 'http://localhost:3000/'
    : isPublishSubpathServer
      ? 'http://localhost:3000/openscad-web/'
      : 'http://localhost:3000/dist/';
const webServerCommand = isDevelopmentServer
  ? 'npm run start:development'
  : isPublishRootServer || isPublishSubpathServer
    ? 'node ./scripts/serve-publish-e2e.mjs'
    : 'npm run start:production';

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
    command: webServerCommand,
    url: appUrl,
    timeout: 180_000,
    reuseExistingServer:
      process.env.CI !== 'true' && !isPublishRootServer && !isPublishSubpathServer,
  },
});
