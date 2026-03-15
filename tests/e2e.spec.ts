import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

type LoggedMessage = {
  type: string;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
};

const isProductionServer = process.env.E2E_SERVER_MODE !== 'dev';
const appOrigin = isProductionServer ? 'http://localhost:3000' : 'http://localhost:4000';
const appBasePath = isProductionServer ? '/dist/' : '/';
const appBaseUrl = new URL(appBasePath, appOrigin).toString();
const renderTimeoutMs = 60_000;
const pageMessages = new WeakMap<Page, LoggedMessage[]>();

function captureConsoleMessage(message: ConsoleMessage): LoggedMessage {
  return {
    type: message.type(),
    text: message.text(),
    location: message.location(),
  };
}

function buildAppUrl(relativePath = ''): string {
  return new URL(relativePath, appBaseUrl).toString();
}

async function loadWithHash(page: Page, fragment: string): Promise<void> {
  const url = new URL(appBaseUrl);
  url.hash = fragment;
  await page.goto(url.toString());
}

async function loadSrc(page: Page, src: string): Promise<void> {
  await loadWithHash(page, `src=${encodeURIComponent(src)}`);
}

async function loadPath(page: Page, path: string): Promise<void> {
  await loadWithHash(page, `path=${encodeURIComponent(path)}`);
}

async function loadUrl(page: Page, url: string): Promise<void> {
  await loadWithHash(page, `url=${encodeURIComponent(url)}`);
}

async function getAppShellState(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
    const state =
      shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
    const output =
      state && typeof state === 'object' && 'output' in state
        ? (state.output as Record<string, unknown> | undefined)
        : undefined;
    const lastCheckerRun =
      state && typeof state === 'object' && 'lastCheckerRun' in state
        ? (state.lastCheckerRun as Record<string, unknown> | undefined)
        : undefined;
    const markers =
      lastCheckerRun && typeof lastCheckerRun === 'object' && 'markers' in lastCheckerRun
        ? (lastCheckerRun.markers as unknown[] | undefined)
        : undefined;

    return state
      ? {
          rendering: Boolean((state as Record<string, unknown>).rendering),
          previewing: Boolean((state as Record<string, unknown>).previewing),
          hasOutput: Boolean(output),
          isPreview: Boolean(output?.isPreview),
          outFileURL:
            output && typeof output.outFileURL === 'string' ? (output.outFileURL as string) : null,
          markerCount: Array.isArray(markers) ? markers.length : 0,
          error:
            state && typeof (state as Record<string, unknown>).error === 'string'
              ? ((state as Record<string, unknown>).error as string)
              : null,
        }
      : null;
  });
}

async function getOutputOffSummary(page: Page) {
  return page.evaluate(async () => {
    const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
    const state =
      shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
    const output =
      state && typeof state === 'object' && 'output' in state
        ? (state.output as Record<string, unknown> | undefined)
        : undefined;
    const outFileURL = output && typeof output.outFileURL === 'string' ? output.outFileURL : null;
    if (!outFileURL) return null;

    const text = await fetch(outFileURL).then((response) => response.text());
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    const header = lines[0] ?? '';
    const countLine =
      header === 'OFF' ? (lines[1] ?? '') : header.startsWith('OFF') ? header.slice(3).trim() : '';
    const counts = countLine
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    return {
      header,
      outFileURL,
      isPreview: Boolean(output?.isPreview),
      vertexCount: counts[0] ?? 0,
      faceCount: counts[1] ?? 0,
      edgeCount: counts[2] ?? 0,
    };
  });
}

async function expectValidOffOutput(page: Page): Promise<void> {
  const summary = await getOutputOffSummary(page);
  expect(summary).not.toBeNull();
  expect(summary?.header.startsWith('OFF')).toBe(true);
  expect(summary?.vertexCount ?? 0).toBeGreaterThan(0);
  expect(summary?.faceCount ?? 0).toBeGreaterThan(0);
}

async function waitForRenderState(page: Page): Promise<void> {
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

async function waitForAppIdle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      const output =
        state && typeof state === 'object' && 'output' in state
          ? (state.output as Record<string, unknown> | undefined)
          : undefined;
      return Boolean(
        state &&
        !state.rendering &&
        !state.previewing &&
        !state.checkingSyntax &&
        !state.exporting &&
        output,
      );
    },
    null,
    { timeout: renderTimeoutMs },
  );
}

async function waitForViewer(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="viewer-canvas"] canvas', { timeout: renderTimeoutMs });
  await page.waitForFunction(
    () => {
      const container = document.querySelector(
        '[data-testid="viewer-canvas"]',
      ) as HTMLElement | null;
      return Boolean(container && container.dataset.geometryLoaded === 'true');
    },
    null,
    { timeout: renderTimeoutMs },
  );
  await waitForRenderState(page);
}

async function waitForParameter(page: Page, name: string, timeout = 45_000): Promise<void> {
  await page.waitForFunction(
    (expectedName) => {
      const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      const parameterSet =
        state && typeof state === 'object' && 'parameterSet' in state
          ? (state.parameterSet as Record<string, unknown> | undefined)
          : undefined;
      const parameters =
        parameterSet && typeof parameterSet === 'object' && 'parameters' in parameterSet
          ? (parameterSet.parameters as Array<Record<string, unknown>> | undefined)
          : undefined;
      return (
        Array.isArray(parameters) &&
        parameters.some((parameter) => parameter?.name === expectedName)
      );
    },
    name,
    { timeout },
  );
}

async function dispatchAppShortcut(page: Page, key: 'F5' | 'F6'): Promise<void> {
  await page.evaluate((shortcut) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: shortcut,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, key);
}

test.beforeEach(async ({ page }) => {
  const messages: LoggedMessage[] = [];
  pageMessages.set(page, messages);
  page.on('console', (message) => {
    messages.push(captureConsoleMessage(message));
  });
  page.on('pageerror', (error) => {
    messages.push({ type: 'pageerror', text: error.message });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const messages = pageMessages.get(page) ?? [];
  console.log(
    `[${testInfo.title}] Messages:`,
    JSON.stringify(
      messages.map(({ text }) => text),
      null,
      2,
    ),
  );

  const errors = messages.filter((message) => {
    if (message.type !== 'error' && message.type !== 'pageerror') return false;
    if (message.text.includes('net::ERR_CONTENT_LENGTH_MISMATCH')) return false;
    if (message.text.includes('net::ERR_INCOMPLETE_CHUNKED_ENCODING')) return false;
    return true;
  });

  expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);

  if (isProductionServer) {
    const prodDriftMessages = messages.filter((message) =>
      message.text.includes('Logging is enabled!') ||
      message.text.includes('Lit is in dev mode. Not recommended for production!'),
    );
    expect(prodDriftMessages, JSON.stringify(prodDriftMessages, null, 2)).toHaveLength(0);
  }

  pageMessages.delete(page);
});

test.describe('e2e', () => {
  test('load the default page', async ({ page }) => {
    await page.goto(appBaseUrl);
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('can render cube', async ({ page }) => {
    await loadSrc(page, 'cube([10, 10, 10]);');
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('use BOSL2', async ({ page }) => {
    await loadSrc(
      page,
      `
      include <BOSL2/std.scad>;
      prismoid([40,40], [0,0], h=20);
    `,
    );
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('use NopSCADlib', async ({ page }) => {
    await loadSrc(
      page,
      `
      include <NopSCADlib/vitamins/led_meters.scad>
      meter(led_meter);
    `,
    );
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('load a demo by path', async ({ page }) => {
    await loadPath(page, '/libraries/openscad/examples/Basics/CSG.scad');
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('load a demo by url', async ({ page }) => {
    await loadUrl(page, buildAppUrl('test-fixture.scad'));
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('customizer & windows line endings work', async ({ page }) => {
    await loadSrc(page, ['myVar = 10;', 'cube(myVar);'].join('\r\n'));
    await waitForViewer(page);
    await expectValidOffOutput(page);
    await waitForParameter(page, 'myVar');

    const parameter = await page.evaluate(() => {
      const shell = document.querySelector('osc-app-shell') as (Element & { _st?: unknown }) | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      const parameterSet =
        state && typeof state === 'object' && 'parameterSet' in state
          ? (state.parameterSet as Record<string, unknown> | undefined)
          : undefined;
      const parameters =
        parameterSet && typeof parameterSet === 'object' && 'parameters' in parameterSet
          ? (parameterSet.parameters as Array<Record<string, unknown>> | undefined)
          : undefined;
      return (parameters ?? []).find((item) => item?.name === 'myVar') ?? null;
    });

    expect(parameter).not.toBeNull();
    expect(parameter?.initial).toBe(10);
  });
});

test.describe('worker integration', () => {
  test('compiles a trivial model successfully (exit code 0)', async ({ page }) => {
    await loadSrc(page, 'cube(10);');
    await waitForViewer(page);
    await expectValidOffOutput(page);
    const state = await getAppShellState(page);
    expect(state?.error ?? null).toBeNull();
    expect(state?.markerCount ?? 1).toBe(0);
  });

  test('single render produces one stable output artifact', async ({ page }) => {
    await loadSrc(page, 'cube(5);');
    await waitForViewer(page);
    const first = await getOutputOffSummary(page);
    expect(first).not.toBeNull();
    await page.waitForTimeout(1000);
    const second = await getOutputOffSummary(page);
    expect(second).not.toBeNull();
    expect(second?.outFileURL).toBe(first?.outFileURL);
  });
});

test.describe('conformance — geometry primitives', () => {
  test('cube(10) produces a PolySet', async ({ page }) => {
    await loadSrc(page, 'cube(10);');
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('sphere(5, $fn=20) produces a PolySet', async ({ page }) => {
    await loadSrc(page, 'sphere(5, $fn=20);');
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('cylinder(h=10, r=5) produces a PolySet', async ({ page }) => {
    await loadSrc(page, 'cylinder(h=10, r=5);');
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('difference of cube and sphere produces a manifold', async ({ page }) => {
    await loadSrc(page, 'difference() { cube(10); sphere(5, $fn=20); }');
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });

  test('viewer canvas is populated after compile', async ({ page }) => {
    await loadSrc(page, 'cube(10);');
    await waitForViewer(page);
    const loaded = await page.evaluate(() => {
      const container = document.querySelector(
        '[data-testid="viewer-canvas"]',
      ) as HTMLElement | null;
      return container ? container.dataset.geometryLoaded === 'true' : false;
    });
    expect(loaded).toBe(true);
  });
});

test.describe('e2e — keyboard shortcuts', () => {
  test('pressing F5 after a render triggers a new render', async ({ page }) => {
    await loadSrc(page, 'cube(5);');
    await waitForViewer(page);
    await waitForAppIdle(page);
    const before = await getAppShellState(page);
    expect(before).not.toBeNull();
    const beforeOutFileUrl = before?.outFileURL ?? null;

    await dispatchAppShortcut(page, 'F5');
    await page.waitForFunction(
      (prevUrl) => {
        const shell = document.querySelector('osc-app-shell') as
          | (Element & { _st?: unknown })
          | null;
        const state =
          shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
        const output =
          state && typeof state === 'object' && 'output' in state
            ? (state.output as Record<string, unknown> | undefined)
            : undefined;
        return Boolean(
          state && !state.rendering && !state.previewing && output && output.outFileURL !== prevUrl,
        );
      },
      beforeOutFileUrl,
      { timeout: 30_000 },
    );
    await expectValidOffOutput(page);
  });

  test('pressing F6 after a render triggers a full render', async ({ page }) => {
    await loadSrc(page, 'cube(5);');
    await waitForViewer(page);
    await waitForAppIdle(page);
    const before = await getAppShellState(page);
    expect(before).not.toBeNull();
    const beforeOutFileUrl = before?.outFileURL ?? null;

    await dispatchAppShortcut(page, 'F6');
    await page.waitForFunction(
      (prevUrl) => {
        const shell = document.querySelector('osc-app-shell') as
          | (Element & { _st?: unknown })
          | null;
        const state =
          shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
        const output =
          state && typeof state === 'object' && 'output' in state
            ? (state.output as Record<string, unknown> | undefined)
            : undefined;
        return Boolean(
          state &&
          !state.rendering &&
          !state.previewing &&
          output &&
          output.isPreview === false &&
          output.outFileURL !== prevUrl,
        );
      },
      beforeOutFileUrl,
      { timeout: 45_000 },
    );
    await waitForViewer(page);
    await expectValidOffOutput(page);
  });
});
