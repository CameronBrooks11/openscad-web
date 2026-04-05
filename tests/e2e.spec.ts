import { expect, test, type ConsoleMessage, type Frame, type Page } from '@playwright/test';

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

function buildEmbedUrl({
  source,
  controls = true,
  download = false,
  parentOrigin = appOrigin,
}: {
  source?: string;
  controls?: boolean;
  download?: boolean;
  parentOrigin?: string;
} = {}): string {
  const url = new URL(appBaseUrl);
  url.searchParams.set('mode', 'embed');
  if (controls) url.searchParams.set('controls', 'true');
  if (download) url.searchParams.set('download', 'true');
  if (parentOrigin) url.searchParams.set('parentOrigin', parentOrigin);
  if (source != null) {
    url.hash = `src=${encodeURIComponent(source)}`;
  }
  return url.toString();
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

async function loadEmbedHost(page: Page, iframeUrl: string): Promise<void> {
  await page.goto(buildAppUrl('test-host.html'));
  await page.evaluate((src) => {
    (window as Window & { __embedMessages?: unknown[] }).__embedMessages = [];
    window.addEventListener('message', (event) => {
      (window as Window & { __embedMessages?: unknown[] }).__embedMessages?.push({
        origin: event.origin,
        data: event.data,
      });
    });

    const iframe = document.createElement('iframe');
    iframe.id = 'embed-frame';
    iframe.src = src;
    iframe.width = '1000';
    iframe.height = '800';
    document.body.replaceChildren(iframe);
  }, iframeUrl);
}

async function getEmbedFrame(page: Page): Promise<Frame> {
  await page.waitForSelector('#embed-frame', { timeout: renderTimeoutMs });
  const handle = await page.locator('#embed-frame').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) {
    throw new Error('Failed to resolve the embed iframe frame.');
  }
  return frame;
}

async function getEmbedMessages(page: Page) {
  return page.evaluate(() => {
    return ((window as Window & { __embedMessages?: unknown[] }).__embedMessages ?? []) as Array<{
      origin: string;
      data: Record<string, unknown>;
    }>;
  });
}

async function waitForEmbedMessage(
  page: Page,
  type: string,
  timeout = renderTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((expectedType) => {
      const messages = (
        window as Window & { __embedMessages?: Array<{ data?: { type?: string } }> }
      ).__embedMessages;
      return Boolean(messages?.some((message) => message?.data?.type === expectedType));
    }, type);
    if (found) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout ${timeout}ms waiting for embed message of type '${type}'`);
}

async function waitForEmbedMessageCount(
  page: Page,
  type: string,
  count: number,
  timeout = renderTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const actualCount = await page.evaluate(
      ([expectedType, expectedCount]) => {
        const messages = (
          window as Window & { __embedMessages?: Array<{ data?: { type?: string } }> }
        ).__embedMessages;
        return (
          messages?.filter((message) => message?.data?.type === (expectedType as string)).length ??
          0
        );
      },
      [type, count] as [string, number],
    );
    if (actualCount >= count) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout ${timeout}ms waiting for ${count}x embed message(s) of type '${type}'`);
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

async function waitForCustomizerShell(page: Page): Promise<void> {
  await page.waitForSelector('osc-customizer-shell', { timeout: renderTimeoutMs });
  await page.waitForFunction(
    () => {
      const shell = document.querySelector('osc-customizer-shell') as
        | (Element & { _st?: unknown })
        | null;
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

async function waitForEmbedViewer(frame: Frame): Promise<void> {
  // Playwright locators pierce shadow DOM; waitForSelector does as well.
  await frame.waitForSelector('[data-testid="viewer-canvas"] canvas', { timeout: renderTimeoutMs });
  await frame.waitForFunction(
    () => {
      // osc-embed-shell uses shadow DOM; reach through it to find the viewer container.
      const shell = document.querySelector('osc-embed-shell');
      const root = shell?.shadowRoot ?? shell;
      const container = root?.querySelector('[data-testid="viewer-canvas"]') as HTMLElement | null;
      return Boolean(container?.dataset.geometryLoaded === 'true');
    },
    null,
    { timeout: renderTimeoutMs },
  );
  await frame.waitForFunction(
    () => {
      const shell = document.querySelector('osc-embed-shell') as
        | (Element & { _st?: unknown })
        | null;
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

async function waitForEmbedParameter(frame: Frame, name: string, timeout = 45_000): Promise<void> {
  await frame.waitForFunction(
    (expectedName) => {
      const shell = document.querySelector('osc-embed-shell') as
        | (Element & { _st?: unknown })
        | null;
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
    // openscad-web.config.json is an optional boot config file; a 404 is expected when not present
    if (message.location?.url?.includes('openscad-web.config.json')) return false;
    return true;
  });

  expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);

  if (isProductionServer) {
    const prodDriftMessages = messages.filter(
      (message) =>
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

test.describe('boot config', () => {
  test('can select a default surface, model, and title before URL params are applied', async ({
    page,
  }) => {
    await page.route('**/openscad-web.config.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'customizer',
          model: './test-fixture.scad',
          title: 'Configured Fixture',
        }),
      });
    });

    await page.goto(appBaseUrl);
    await waitForCustomizerShell(page);

    await expect(page).toHaveTitle('Configured Fixture');
    await expect(page.locator('osc-customizer-shell')).toHaveCount(1);
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

  test('invalid syntax shows a normalized error banner and markers', async ({ page }) => {
    await loadSrc(page, 'cube(;');
    await page.waitForFunction(
      () => {
        const shell = document.querySelector('osc-app-shell') as
          | (Element & { _st?: unknown })
          | null;
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
          state &&
          !state.rendering &&
          !state.previewing &&
          typeof state.error === 'string' &&
          state.error.includes('OpenSCAD reported syntax errors') &&
          Array.isArray(markers) &&
          markers.length > 0,
        );
      },
      null,
      { timeout: renderTimeoutMs },
    );

    await expect(page.locator('[data-testid="error-banner"]')).toContainText(
      'OpenSCAD reported syntax errors',
    );
  });
});

test.describe('embed mode', () => {
  test('supports host messaging and emits the documented lifecycle events', async ({ page }) => {
    const source = 'myVar = 10;\ncube(myVar);';

    await loadEmbedHost(page, buildEmbedUrl({ source, parentOrigin: appOrigin }));
    const frame = await getEmbedFrame(page);

    await waitForEmbedViewer(frame);
    await waitForEmbedMessage(page, 'ready');
    await waitForEmbedMessage(page, 'parameterSetLoaded');
    await waitForEmbedMessage(page, 'renderComplete');
    await waitForEmbedParameter(frame, 'myVar');

    await page.evaluate(() => {
      const iframe = document.getElementById('embed-frame') as HTMLIFrameElement | null;
      iframe?.contentWindow?.postMessage(
        { type: 'setVar', name: 'myVar', value: 20 },
        window.location.origin,
      );
    });

    await waitForEmbedMessage(page, 'varsChanged');
    await waitForEmbedMessageCount(page, 'renderComplete', 2);
    await frame.waitForFunction(
      () => {
        const shell = document.querySelector('osc-embed-shell') as
          | (Element & { _st?: unknown })
          | null;
        const state =
          shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
        return (
          state?.params && (state.params as { vars?: Record<string, unknown> }).vars?.myVar === 20
        );
      },
      null,
      { timeout: renderTimeoutMs },
    );

    await page.evaluate(() => {
      const iframe = document.getElementById('embed-frame') as HTMLIFrameElement | null;
      iframe?.contentWindow?.postMessage(
        { type: 'getVars', requestId: 'checkout' },
        window.location.origin,
      );
    });

    await waitForEmbedMessage(page, 'varsSnapshot');

    const messages = await getEmbedMessages(page);
    const readyMessage = messages.find((message) => message.data?.type === 'ready');
    const parameterSetMessage = messages.find(
      (message) => message.data?.type === 'parameterSetLoaded',
    );
    const varsChangedMessage = messages
      .filter((message) => message.data?.type === 'varsChanged')
      .at(-1);
    const varsSnapshotMessage = messages
      .filter((message) => message.data?.type === 'varsSnapshot')
      .at(-1);

    expect(readyMessage).toBeDefined();
    expect(readyMessage?.data?.vars).toEqual(expect.any(Object));
    expect(parameterSetMessage).toBeDefined();
    expect(
      (
        parameterSetMessage?.data?.parameterSet as
          | { parameters?: Array<{ name?: string }> }
          | undefined
      )?.parameters?.some((parameter) => parameter?.name === 'myVar'),
    ).toBe(true);
    expect(varsChangedMessage?.data?.vars).toMatchObject({ myVar: 20 });
    expect(varsSnapshotMessage?.data?.requestId).toBe('checkout');
    expect(varsSnapshotMessage?.data?.vars).toMatchObject({ myVar: 20 });
  });

  test('rejects host messages when parentOrigin does not match the real parent origin', async ({
    page,
  }) => {
    const source = 'myVar = 10;\ncube(myVar);';

    await loadEmbedHost(page, buildEmbedUrl({ source, parentOrigin: 'https://example.com' }));
    const frame = await getEmbedFrame(page);

    await waitForEmbedViewer(frame);
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const iframe = document.getElementById('embed-frame') as HTMLIFrameElement | null;
      iframe?.contentWindow?.postMessage(
        { type: 'setVar', name: 'myVar', value: 30 },
        window.location.origin,
      );
    });

    await page.waitForTimeout(500);

    const messages = await getEmbedMessages(page);
    const vars = await frame.evaluate(() => {
      const shell = document.querySelector('osc-embed-shell') as
        | (Element & { _st?: unknown })
        | null;
      const state =
        shell && '_st' in shell ? (shell._st as Record<string, unknown> | undefined) : null;
      return (state?.params as { vars?: Record<string, unknown> } | undefined)?.vars ?? null;
    });

    expect(messages.some((message) => message.data?.type === 'ready')).toBe(false);
    expect(messages.some((message) => message.data?.type === 'varsChanged')).toBe(false);
    expect(vars).toBeNull();
  });

  test('setModel replaces the model source and triggers a re-render', async ({ page }) => {
    const initialSource = 'cube(10);';
    const replacedSource = 'sphere(5, $fn=8);';

    await loadEmbedHost(page, buildEmbedUrl({ source: initialSource, parentOrigin: appOrigin }));
    const frame = await getEmbedFrame(page);

    await waitForEmbedViewer(frame);

    await waitForEmbedMessage(page, 'ready');
    await waitForEmbedMessage(page, 'renderComplete');

    const firstMessages = await getEmbedMessages(page);
    const firstComplete = firstMessages.filter((m) => m.data?.type === 'renderComplete');
    expect(firstComplete).toHaveLength(1);

    await page.evaluate((src) => {
      const iframe = document.getElementById('embed-frame') as HTMLIFrameElement | null;
      iframe?.contentWindow?.postMessage({ type: 'setModel', source: src }, window.location.origin);
    }, replacedSource);

    await waitForEmbedMessageCount(page, 'renderComplete', 2);

    const allMessages = await getEmbedMessages(page);
    expect(allMessages.filter((m) => m.data?.type === 'renderComplete')).toHaveLength(2);
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
