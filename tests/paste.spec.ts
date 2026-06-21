import { expect, test, type Page } from '@playwright/test';

// Regression coverage for issue #38: pasting copied code into the editor.
// In this Monaco setup the browser's native Ctrl/Cmd+V does not reach the
// editor, so paste is bound explicitly to the async Clipboard API. These tests
// exercise the real key path in a browser with a real system clipboard.

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

async function loadSrc(page: Page, src: string): Promise<void> {
  const url = new URL(appBaseUrl);
  url.hash = `src=${encodeURIComponent(src)}`;
  await page.goto(url.toString());
}

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

async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = document.querySelector('osc-editor-panel') as
      | (Element & { _editor?: { getValue(): string } })
      | null;
    return p?._editor?.getValue() ?? '<no-editor>';
  });
}

test.describe('editor paste (#38)', () => {
  // grantPermissions for the clipboard is Chromium-only; skip elsewhere.
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'clipboard permission grant is Chromium-only',
  );

  test('Ctrl/Cmd+V pastes clipboard text into the editor', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await loadSrc(page, 'cube(1);');
    await waitForEditor(page);

    const marker = 'PASTED_VIA_CTRL_V_OK';
    await page.evaluate((t) => navigator.clipboard.writeText(t), marker);

    await page.locator('.osc-editor-monaco .monaco-editor').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');

    await expect.poll(() => editorValue(page)).toContain(marker);
  });

  test('editor menu "Paste" inserts clipboard text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await loadSrc(page, 'cube(1);');
    await waitForEditor(page);

    const marker = 'PASTED_VIA_MENU_OK';
    await page.evaluate((t) => navigator.clipboard.writeText(t), marker);

    await page.locator('.osc-editor-monaco .monaco-editor').click();
    await page.getByRole('button', { name: 'Editor menu' }).click();
    await page.getByRole('menuitem', { name: 'Paste' }).click();

    await expect.poll(() => editorValue(page)).toContain(marker);
  });
});
