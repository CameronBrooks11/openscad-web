import { defineConfig, devices } from '@playwright/test';

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
  },
  // Chromium runs the full suite. Firefox runs a smaller smoke matrix (tests
  // tagged @firefox) covering the cross-browser core — app load + WASM worker
  // compile, syntax-error reporting, and the Blob/File + BrowserFS-fallback ZIP
  // import path (Firefox has no File System Access API, so it exercises the
  // fallback). Chromium-only surfaces (FS Access picker, clipboard paste) are
  // intentionally not tagged. Firefox runs only in the default prod server mode
  // (the main e2e job); the publish/dev runs that check path-serving stay
  // Chromium-only. See #124.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: process.env.CI === 'true' ? ['--no-sandbox'] : [] },
      },
    },
    ...(serverMode === 'prod'
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
              // Headless Firefox in CI has no GPU; nudge it toward software WebGL
              // so the viewer can still init. The @firefox smoke tests assert on
              // the WASM render output rather than the canvas, so this is a
              // best-effort bonus, not load-bearing.
              launchOptions: {
                firefoxUserPrefs: {
                  'webgl.force-enabled': true,
                  'webgl.disabled': false,
                  'gfx.webrender.software': true,
                },
              },
            },
            grep: /@firefox/,
          },
        ]
      : []),
  ],
  webServer: {
    command: webServerCommand,
    url: appUrl,
    timeout: 180_000,
    reuseExistingServer:
      process.env.CI !== 'true' && !isPublishRootServer && !isPublishSubpathServer,
  },
});
