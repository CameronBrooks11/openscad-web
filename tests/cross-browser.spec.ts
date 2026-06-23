import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

// A small cross-browser smoke suite (#124). Chromium runs it alongside the full
// e2e suite; the @firefox-tagged tests also run under the Firefox project (see
// playwright.config.ts) to cover the WASM worker, Blob/File, and the BrowserFS
// fallback used when the File System Access API is absent (Firefox/Safari).
//
// These assert on functional outcomes (a settled WASM render output + valid OFF)
// rather than the WebGL viewer or console cleanliness, since headless Firefox in
// CI has no WebGL and benign console/network message strings differ across
// browsers — the strict console-error gate lives in e2e.spec.ts.

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
const appBaseUrl = new URL(appBasePath, appOrigin).toString();
const renderTimeoutMs = 60_000;

async function loadSrc(page: Page, src: string): Promise<void> {
  const url = new URL(appBaseUrl);
  url.hash = `src=${encodeURIComponent(src)}`;
  await page.goto(url.toString());
}

/**
 * Wait until the WASM worker produces a settled render output. Deliberately does
 * NOT wait on the Three.js `viewer-canvas`: headless Firefox in CI has no WebGL,
 * so the canvas never paints — but the compile pipeline (worker + WASM + Blob)
 * still runs, which is what this cross-browser smoke verifies.
 */
async function waitForRenderOutput(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      const output =
        state && typeof state === 'object' && 'output' in state
          ? (state.output as Record<string, unknown> | undefined)
          : undefined;
      return Boolean(state && !state.rendering && !state.previewing && output);
    },
    null,
    { timeout: renderTimeoutMs },
  );
}

/** Read the OFF output and assert it is a non-empty mesh. */
async function expectValidOff(page: Page): Promise<void> {
  const summary = await page.evaluate(async () => {
    const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
    const state =
      shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
    const output =
      state && typeof state === 'object' && 'output' in state
        ? (state.output as Record<string, unknown> | undefined)
        : undefined;
    const outFileURL = output && typeof output.outFileURL === 'string' ? output.outFileURL : null;
    if (!outFileURL) return null;
    const text = await fetch(outFileURL).then((r) => r.text());
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    const header = lines[0] ?? '';
    const countLine =
      header === 'OFF' ? (lines[1] ?? '') : header.startsWith('OFF') ? header.slice(3).trim() : '';
    const counts = countLine.split(/\s+/).map(Number).filter(Number.isFinite);
    return { header, vertexCount: counts[0] ?? 0, faceCount: counts[1] ?? 0 };
  });
  expect(summary).not.toBeNull();
  expect(summary?.header.startsWith('OFF')).toBe(true);
  expect(summary?.vertexCount ?? 0).toBeGreaterThan(0);
  expect(summary?.faceCount ?? 0).toBeGreaterThan(0);
}

test('loads and renders the default model @firefox', async ({ page }) => {
  await page.goto(appBaseUrl);
  await waitForRenderOutput(page);
  await expectValidOff(page);
});

test('compiles a model from the URL fragment via the WASM worker @firefox', async ({ page }) => {
  await loadSrc(page, 'cube([10, 10, 10]);');
  await waitForRenderOutput(page);
  await expectValidOff(page);
});

test('reports a syntax error with markers @firefox', async ({ page }) => {
  await loadSrc(page, 'cube(;');
  await page.waitForFunction(
    () => {
      const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      const lastCheckerRun =
        state && typeof state === 'object' && 'lastCheckerRun' in state
          ? (state.lastCheckerRun as Record<string, unknown> | undefined)
          : undefined;
      const markers =
        lastCheckerRun && typeof lastCheckerRun === 'object' && 'markers' in lastCheckerRun
          ? (lastCheckerRun.markers as unknown[] | undefined)
          : undefined;
      return Boolean(
        state && typeof state.error === 'string' && Array.isArray(markers) && markers.length > 0,
      );
    },
    null,
    { timeout: renderTimeoutMs },
  );
});

test('imports a nested-dir ZIP project, lists the nested file, and compiles @firefox', async ({
  page,
}) => {
  await page.goto(appBaseUrl);
  await waitForRenderOutput(page); // default model loaded first

  // Build a multi-directory project archive: main.scad includes lib/part.scad.
  const zip = new JSZip();
  zip.file('main.scad', 'include <lib/part.scad>\npart();\n');
  zip.file('lib/part.scad', 'module part() { cube(7); }\n');
  const bytes = await zip.generateAsync({ type: 'uint8array' });

  // No UI affordance imports a project yet (the editor's "Upload" item is
  // disabled), so drive the model's importProjectZip directly. This still
  // exercises the real ZIP decode → BrowserFS write → mkdir -p → dropdown →
  // compile path in the browser.
  await page.evaluate(async (data) => {
    const shell = document.querySelector('osc-app-shell') as
      | (Element & { _model?: { importProjectZip(buf: ArrayBuffer): Promise<void> } })
      | null;
    const buf = new Uint8Array(data).buffer;
    await shell?._model?.importProjectZip(buf);
  }, Array.from(bytes));

  // The nested file is offered in the editor's file dropdown (issue #119).
  const select = page.locator('.osc-editor-file-select');
  await expect(select.locator('option', { hasText: 'lib/part.scad' })).toHaveCount(1);

  // main.scad is the active entry and compiles — the include resolved, so the
  // cube(7) from the nested file is in the output mesh.
  await waitForRenderOutput(page);
  await expectValidOff(page);

  // Navigating to the nested file makes it the active source.
  await page.evaluate(() => {
    const shell = document.querySelector('osc-app-shell') as
      | (Element & { _model?: { openFile(path: string): void } })
      | null;
    shell?._model?.openFile('/home/lib/part.scad');
  });
  await page.waitForFunction(
    () => {
      const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      const params =
        state && typeof state === 'object' && 'params' in state
          ? (state.params as Record<string, unknown> | undefined)
          : undefined;
      return params?.activePath === '/home/lib/part.scad';
    },
    null,
    { timeout: renderTimeoutMs },
  );
});
