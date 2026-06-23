import { expect, test, type Page } from '@playwright/test';

// The viewer-only entry (viewer.html) is driven entirely by the Layer-0 host
// transport (ADR 0005). These tests play the host: a same-origin harness page
// embeds viewer.html in an iframe (real embedding — the viewer posts to its
// parent, not itself), sends messages, and asserts the viewer reports back.

const isProductionServer = process.env.E2E_SERVER_MODE !== 'dev';
const appOrigin = isProductionServer ? 'http://localhost:3000' : 'http://localhost:4000';
const appBasePath =
  process.env.E2E_SERVER_MODE === 'publish-root'
    ? '/'
    : process.env.E2E_SERVER_MODE === 'publish-subpath'
      ? '/openscad-web/'
      : isProductionServer
        ? '/dist/'
        : '/';
const baseUrl = new URL(appBasePath, appOrigin);
const viewerSrc = new URL('viewer.html', baseUrl).toString();
const harnessUrl = new URL('__viewer_harness.html', baseUrl).toString();

// Single-line OFF header (what parseOff's first branch consumes): a tetrahedron.
const TETRAHEDRON_OFF = [
  'OFF 4 4 0',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '0 0 1',
  '3 0 1 2',
  '3 0 1 3',
  '3 0 2 3',
  '3 1 2 3',
  '',
].join('\n');

declare global {
  interface Window {
    __viewerMessages?: { type?: string; opId?: string }[];
  }
}

/** Load a same-origin harness that embeds viewer.html in an iframe and collects
 *  the messages it posts to the parent. */
async function embedViewer(page: Page): Promise<void> {
  await page.route('**/__viewer_harness.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>harness</title><body></body>',
    }),
  );
  await page.goto(harnessUrl);
  await page.evaluate((src) => {
    window.__viewerMessages = [];
    window.addEventListener('message', (e) => window.__viewerMessages!.push(e.data));
    const frame = document.createElement('iframe');
    frame.id = 'viewer-frame';
    frame.src = src;
    frame.style.cssText = 'width:400px;height:300px;border:0';
    document.body.appendChild(frame);
  }, viewerSrc);
  // The viewer announces readiness to the parent.
  await page.waitForFunction(
    () => window.__viewerMessages?.some((m) => m?.type === 'ready'),
    null,
    {
      timeout: 30_000,
    },
  );
}

async function postToViewer(page: Page, message: object): Promise<void> {
  await page.evaluate((msg) => {
    const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;
    frame.contentWindow!.postMessage(msg, window.location.origin);
  }, message);
}

test('viewer-only entry loads geometry over the host transport', async ({ page }) => {
  await embedViewer(page);

  await postToViewer(page, {
    protocolVersion: 1,
    type: 'setGeometry',
    offText: TETRAHEDRON_OFF,
    opId: 'op-1',
  });

  // The command is acknowledged (correlated by opId) and the render completes.
  await page.waitForFunction(
    () => window.__viewerMessages?.some((m) => m?.type === 'geometry-set' && m?.opId === 'op-1'),
    null,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () => window.__viewerMessages?.some((m) => m?.type === 'geometry-loaded'),
    null,
    { timeout: 30_000 },
  );

  // The viewer never echoed an error for the valid input.
  const hadError = await page.evaluate(() =>
    window.__viewerMessages?.some((m) => m?.type === 'error'),
  );
  expect(hadError).toBeFalsy();
});

test('a setCamera sent immediately on ready is not dropped (race with mount)', async ({ page }) => {
  await embedViewer(page);

  // Sent right after `ready`, before the geometry/scene is necessarily built.
  await postToViewer(page, {
    protocolVersion: 1,
    type: 'setCamera',
    camera: { position: [10, 10, 10], target: [0, 0, 0], zoom: 1 },
    opId: 'cam-1',
  });
  await postToViewer(page, {
    protocolVersion: 1,
    type: 'setGeometry',
    offText: TETRAHEDRON_OFF,
    opId: 'geo-1',
  });

  // The camera command is acknowledged (buffered then applied, not dropped) and
  // geometry still loads — no error.
  await page.waitForFunction(
    () => window.__viewerMessages?.some((m) => m?.type === 'camera-set' && m?.opId === 'cam-1'),
    null,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () => window.__viewerMessages?.some((m) => m?.type === 'geometry-loaded'),
    null,
    { timeout: 30_000 },
  );
  const hadError = await page.evaluate(() =>
    window.__viewerMessages?.some((m) => m?.type === 'error'),
  );
  expect(hadError).toBeFalsy();
});

test('viewer-only entry rejects a malformed message with a correlated error', async ({ page }) => {
  await embedViewer(page);

  // Wrong protocol version → the viewer replies with an error envelope echoing opId.
  await postToViewer(page, {
    protocolVersion: 999,
    type: 'setGeometry',
    offText: 'OFF',
    opId: 'bad',
  });

  await page.waitForFunction(
    () => window.__viewerMessages?.some((m) => m?.type === 'error' && m?.opId === 'bad'),
    null,
    { timeout: 10_000 },
  );
});
