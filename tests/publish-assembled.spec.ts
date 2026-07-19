import { expect, test } from '@playwright/test';

// Browser coverage for the ASSEMBLED publish surfaces (deploy-configure), not
// the raw dist-publish. Runs only under E2E_SERVER_MODE=publish-assembled, where
// scripts/serve-publish-e2e.mjs assembles a multi-target site — two compile
// surfaces that share one runtime (#240) plus a self-contained static surface
// (#241) — and serves it at http://localhost:3000/.
//
// osc-geometry-viewer sets data-geometry-loaded="true" on its container once the
// mesh is in the scene; CI Chromium has working WebGL (see viewer.spec), so that
// DOM signal is a reliable "it rendered" assertion. Playwright's selector engine
// pierces the component's open shadow root.

const assembled = process.env.E2E_SERVER_MODE === 'publish-assembled';
const baseUrl = new URL('http://localhost:3000/');

test('a shared-runtime compile mount fetches libraries from the shared runtime and renders (#240)', async ({
  page,
}) => {
  test.skip(!assembled, 'requires E2E_SERVER_MODE=publish-assembled');

  const responses: { url: string; status: number }[] = [];
  page.on('response', (response) =>
    responses.push({ url: response.url(), status: response.status() }),
  );

  await page.goto(new URL('viewer/', baseUrl).toString());

  // A thin compile mount has no libraries/ of its own: the compile renders only
  // if the worker resolved libraries/fonts.zip against the shared runtime. If it
  // had resolved against the mount (the #240 blocker), the fetch would 404 and
  // the geometry would never load.
  await page.waitForSelector('[data-geometry-loaded="true"]', { timeout: 90_000 });

  // The worker resolves libraries against the SHARED runtime and its fetch of
  // fonts.zip (done at FS init on every compile) succeeds there. If it had
  // resolved against the thin mount instead (the #240 blocker), FS init would
  // have thrown and the geometry above would never have loaded.
  //
  // (A separate, harmless main-thread prefetch hint still points a `<link
  // rel=prefetch>` at the mount path and 404s; that is non-fatal and not what
  // this test guards.)
  const sharedFonts = responses.find(
    (response) =>
      response.url.includes('/_openscad-web/') && response.url.includes('/libraries/fonts.zip'),
  );
  expect(sharedFonts, 'the worker fetched fonts.zip from the shared runtime').toBeTruthy();
  expect(sharedFonts!.status).toBe(200);
});

test('a static mount renders the pre-rendered geometry with no WASM (#241)', async ({ page }) => {
  test.skip(!assembled, 'requires E2E_SERVER_MODE=publish-assembled');

  const requestedUrls: string[] = [];
  page.on('request', (request) => requestedUrls.push(request.url()));

  await page.goto(new URL('static/', baseUrl).toString());

  await page.waitForSelector('[data-geometry-loaded="true"]', { timeout: 30_000 });

  expect(
    requestedUrls.filter((url) => url.endsWith('.wasm')),
    'the static mount loads no OpenSCAD WASM',
  ).toEqual([]);
});
