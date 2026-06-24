import { expect, test, type Page } from '@playwright/test';

// Real-WASM-boot acceptance check for the compile-capable distributable
// (session.html → dist-session, #193). Unlike the headless project-contract unit
// test (which drives a FakeBackend), this plays the HOST against the actual
// bundle: a same-origin harness embeds session.html in an iframe (real embedding —
// the session posts to its parent over the BrowserParentTransport), pushes a
// project over the Layer-1 session protocol, and asserts the session boots the
// OpenSCAD WASM worker and streams back a genuine OFF artifact. It only runs under
// E2E_SERVER_MODE=session (dist-session served at root), driven by
// scripts/run-session-e2e.mjs.

const sessionServed = process.env.E2E_SERVER_MODE === 'session';

const baseUrl = new URL('http://localhost:3000/');
const sessionSrc = new URL('session.html', baseUrl).toString();
const harnessUrl = new URL('__session_harness.html', baseUrl).toString();

declare global {
  interface Window {
    __sessionMessages?: {
      type?: string;
      result?: { status?: string; artifact?: { format?: string } };
    }[];
  }
}

/** Load a same-origin harness that embeds session.html in an iframe and collects
 *  the L1 messages the session posts to the parent. */
async function embedSession(page: Page): Promise<void> {
  await page.route('**/__session_harness.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>harness</title><body></body>',
    }),
  );
  await page.goto(harnessUrl);
  await page.evaluate((src) => {
    window.__sessionMessages = [];
    window.addEventListener('message', (e) => window.__sessionMessages!.push(e.data));
    const frame = document.createElement('iframe');
    frame.id = 'session-frame';
    frame.src = src;
    frame.style.cssText = 'width:400px;height:300px;border:0';
    document.body.appendChild(frame);
  }, sessionSrc);
  // The session announces readiness to the parent once BrowserFS + the worker
  // bootstrap have resolved. Cold-boot of the bundle can take a moment.
  await page.waitForFunction(
    () => window.__sessionMessages?.some((m) => m?.type === 'ready'),
    null,
    { timeout: 60_000 },
  );
}

async function postToSession(page: Page, message: object): Promise<void> {
  await page.evaluate((msg) => {
    const frame = document.getElementById('session-frame') as HTMLIFrameElement;
    frame.contentWindow!.postMessage(msg, window.location.origin);
  }, message);
}

test.describe('session distributable (#193)', () => {
  test.skip(!sessionServed, 'requires E2E_SERVER_MODE=session (dist-session served)');

  test('boots real WASM and renders a pushed project to an OFF artifact', async ({ page }) => {
    await embedSession(page);

    await postToSession(page, {
      protocolVersion: 1,
      type: 'setProject',
      files: [{ path: 'main.scad', content: 'cube([10, 10, 10]);' }],
      entryPoint: 'main.scad',
    });

    // A genuine WASM compile fans out to a success operation-result carrying an
    // OFF artifact (the render bridge also sets it on the embedded viewer, but the
    // wire result is what proves the engine actually ran). Generous timeout for
    // cold WASM boot + first compile.
    await page.waitForFunction(
      () =>
        window.__sessionMessages?.some(
          (m) =>
            m?.type === 'operation-result' &&
            m?.result?.status === 'success' &&
            m?.result?.artifact?.format === 'off',
        ),
      null,
      { timeout: 60_000 },
    );

    // No protocol/compile error was reported for the valid project.
    const hadError = await page.evaluate(() =>
      window.__sessionMessages?.some((m) => m?.type === 'error'),
    );
    expect(hadError).toBeFalsy();
  });
});
