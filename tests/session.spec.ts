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

test.describe('session distributable (#193)', () => {
  test.skip(!sessionServed, 'requires E2E_SERVER_MODE=session (dist-session served)');

  test('boots real WASM and renders a pushed project to an OFF artifact', async ({ page }) => {
    await embedSession(page);

    // Pin the wire version from the served manifest — the same way a real host
    // obtains it (EMBEDDING-VSCODE.md §6) — so this test tracks protocol bumps
    // instead of hardcoding one.
    const manifest = await page.request.get(new URL('session-manifest.json', baseUrl).toString());
    const { protocolVersion } = (await manifest.json()) as { protocolVersion: number };

    // The project includes a (unreferenced) binary asset (#172), so the push
    // exercises the bytes branch — wire validation, BrowserFS writeBytes, and
    // the local-source bookkeeping — against the real artifact. The Uint8Array
    // must be constructed IN PAGE: Playwright's evaluate-arg serialization would
    // mangle a Node-side one before it ever reached postMessage.
    await page.evaluate((v) => {
      const frame = document.getElementById('session-frame') as HTMLIFrameElement;
      frame.contentWindow!.postMessage(
        {
          protocolVersion: v,
          type: 'setProject',
          files: [
            { path: 'main.scad', content: 'cube([10, 10, 10]);' },
            { path: 'assets/blob.bin', bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
          ],
          entryPoint: 'main.scad',
        },
        window.location.origin,
      );
    }, protocolVersion);

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
