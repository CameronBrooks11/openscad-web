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
      result?: {
        status?: string;
        kind?: string;
        requestId?: string;
        artifact?: { format?: string; artifactId?: string };
      };
      requestId?: string;
      sourceRevision?: number;
      available?: boolean;
      artifact?: { format?: string };
      bytes?: Uint8Array;
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
          requestId: 'e2e-push-1',
        },
        window.location.origin,
      );
    }, protocolVersion);

    // The push is acked with its assigned revision (#227) before any results.
    await page.waitForFunction(
      () =>
        window.__sessionMessages?.some(
          (m) =>
            m?.type === 'project-ack' &&
            m?.requestId === 'e2e-push-1' &&
            typeof m?.sourceRevision === 'number',
        ),
      null,
      { timeout: 30_000 },
    );

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

    // Full render (#219): trigger a render-quality compile over the wire and
    // await its kind:'render' terminal (echoing our requestId). Its output is
    // what the export below converts — render-quality, not preview-quality.
    await postToSession(page, { protocolVersion, type: 'render', requestId: 'e2e-render-1' });
    await page.waitForFunction(
      () =>
        window.__sessionMessages?.some(
          (m) =>
            m?.type === 'operation-result' &&
            m?.result?.kind === 'render' &&
            m?.result?.status === 'success' &&
            m?.result?.requestId === 'e2e-render-1',
        ),
      null,
      { timeout: 60_000 },
    );

    // Export round-trip (#216 + #197): trigger a real STL export over the wire,
    // then fetch the produced artifact's exact bytes by id. This is the flow a
    // VS Code host uses to save STL/3MF to disk.
    await postToSession(page, {
      protocolVersion,
      type: 'export',
      format: 'stl',
      requestId: 'e2e-export-1',
    });
    await page.waitForFunction(
      () =>
        window.__sessionMessages?.some(
          (m) =>
            m?.type === 'operation-result' &&
            m?.result?.kind === 'export' &&
            m?.result?.status === 'success' &&
            m?.result?.requestId === 'e2e-export-1' &&
            m?.result?.artifact?.format === 'stl',
        ),
      null,
      { timeout: 60_000 },
    );
    const artifactId = await page.evaluate(
      () =>
        window.__sessionMessages?.find(
          (m) =>
            m?.type === 'operation-result' &&
            m?.result?.kind === 'export' &&
            m?.result?.status === 'success',
        )?.result?.artifact?.artifactId,
    );
    expect(artifactId).toBeTruthy();

    await postToSession(page, {
      protocolVersion,
      type: 'getArtifact',
      artifactId,
      requestId: 'e2e-stl',
    });
    await page.waitForFunction(
      () =>
        window.__sessionMessages?.some(
          (m) => m?.type === 'artifact' && m?.requestId === 'e2e-stl' && m?.available === true,
        ),
      null,
      { timeout: 30_000 },
    );
    // The bytes arrived as a genuine byte payload with STL content ("solid ..."
    // ASCII or the binary layout — both start beyond zero length).
    const byteProbe = await page.evaluate(() => {
      const reply = window.__sessionMessages?.find(
        (m) => m?.type === 'artifact' && m?.requestId === 'e2e-stl',
      );
      const bytes = reply?.bytes;
      return bytes instanceof Uint8Array
        ? { isU8: true, length: bytes.byteLength, head: Array.from(bytes.slice(0, 5)) }
        : { isU8: false, length: 0, head: [] as number[] };
    });
    expect(byteProbe.isU8).toBe(true);
    expect(byteProbe.length).toBeGreaterThan(0);
  });
});
