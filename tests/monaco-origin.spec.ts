import { expect, test, type Page } from '@playwright/test';

// Regression coverage for issue #267: Monaco must load from our own build
// output, never from a third-party CDN.
//
// @monaco-editor/loader defaults to `https://cdn.jsdelivr.net/npm/monaco-editor@<v>/min/vs`,
// which pinned a version chosen by the loader's release rather than our
// package.json, broke the offline PWA and air-gapped/self-hosted deployments,
// and put third-party script on the page. openscad-register-language.ts now
// calls `loader.config({ paths: { vs } })` with a same-origin URL.

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

async function waitForEditor(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = document.querySelector('osc-editor-panel') as
        | (Element & { _editor?: { getValue(): string } })
        | null;
      return Boolean(p && p._editor);
    },
    null,
    { timeout: 30_000 },
  );
}

test.describe('Monaco asset origin (#267)', () => {
  test('loads Monaco from this origin and never from a CDN', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (req) => requested.push(req.url()));

    const url = new URL(appBaseUrl);
    url.hash = `src=${encodeURIComponent('cube(10);')}`;
    await page.goto(url.toString());
    await waitForEditor(page);

    // The editor is up, so Monaco resolved. It must have come from us.
    const monacoRequests = requested.filter((u) => /\/monaco\/vs\//.test(u));
    expect(
      monacoRequests.length,
      'expected the editor to fetch Monaco from <base>/monaco/vs/',
    ).toBeGreaterThan(0);

    for (const u of monacoRequests) {
      expect(new URL(u).origin, `Monaco asset served cross-origin: ${u}`).toBe(appOrigin);
    }

    // Nothing at all may go to a package CDN — not Monaco, not anything else.
    const cdnRequests = requested.filter((u) => /jsdelivr|unpkg|cdnjs|esm\.sh/i.test(u));
    expect(cdnRequests, 'third-party CDN requests are not allowed').toEqual([]);
  });

  test('does not fetch the pruned language-service workers', async ({ page }) => {
    // scripts/sync-monaco-assets.mjs drops the TypeScript/CSS/HTML/JSON worker
    // bundles (~8.7 MB) because this app registers only OpenSCAD. If Monaco ever
    // starts reaching for them, this fails instead of 404ing in a user's browser.
    const failed: string[] = [];
    page.on('requestfailed', (req) => failed.push(req.url()));
    page.on('response', (res) => {
      if (res.status() >= 400 && /\/monaco\/vs\//.test(res.url())) {
        failed.push(`${res.status()} ${res.url()}`);
      }
    });

    const url = new URL(appBaseUrl);
    url.hash = `src=${encodeURIComponent('cube(10);')}`;
    await page.goto(url.toString());
    await waitForEditor(page);

    expect(failed.filter((u) => /monaco/.test(u))).toEqual([]);
  });
});
