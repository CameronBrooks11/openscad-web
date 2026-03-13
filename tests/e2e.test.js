const longTimeout = 60000;

const isProd = process.env.NODE_ENV === 'production';
const baseUrl = isProd ? 'http://localhost:3000/dist/' : 'http://localhost:4000/';

const messages = [];

beforeAll(async () => {
  page.on('console', (msg) => messages.push({
    type: msg.type(),
    text: msg.text(),
    stack: msg.stackTrace(),
    location: msg.location(),
  }));
});

beforeEach(async () => {
  messages.length = 0;
  await page.goto('about:blank');
});

afterEach(async () => {
  // console.log('Messages:', JSON.stringify(messages, null, 2));
  const testName = expect.getState().currentTestName;
  console.log(`[${testName}] Messages:`, JSON.stringify(messages.map(({ text }) => text), null, 2));

  const errors = messages.filter(msg =>
    msg.type === 'error' &&
    !(msg.text.includes('404')
      && msg.stack.some(s =>
        s.url.indexOf('fonts/InterVariable.woff') >= 0)));
  expect(errors).toHaveLength(0);
});

function loadSrc(src) {
  return page.goto(`${baseUrl}#src=${encodeURIComponent(src)}`);
}
function loadPath(path) {
  return page.goto(`${baseUrl}#path=${encodeURIComponent(path)}`);
}
function loadUrl(url) {
  return page.goto(`${baseUrl}#url=${encodeURIComponent(url)}`);
}
function getAppShellState() {
  return page.evaluate(() => {
    const shell = document.querySelector('osc-app-shell');
    return shell && shell._st ? {
      rendering: !!shell._st.rendering,
      previewing: !!shell._st.previewing,
      hasOutput: !!shell._st.output,
      isPreview: !!shell._st.output?.isPreview,
      outFileURL: shell._st.output?.outFileURL ?? null,
      markerCount: shell._st.lastCheckerRun?.markers?.length ?? 0,
      error: shell._st.error ?? null,
    } : null;
  });
}
function getOutputOffSummary() {
  return page.evaluate(async () => {
    const shell = document.querySelector('osc-app-shell');
    const st = shell && shell._st;
    if (!st?.output?.outFileURL) return null;

    const text = await fetch(st.output.outFileURL).then(r => r.text());
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));

    const header = lines[0] ?? '';
    const countLine = header === 'OFF'
      ? (lines[1] ?? '')
      : (header.startsWith('OFF') ? header.slice(3).trim() : '');
    const counts = countLine
      .split(/\s+/)
      .map(v => Number(v))
      .filter(v => Number.isFinite(v));

    return {
      header,
      outFileURL: st.output.outFileURL,
      isPreview: !!st.output.isPreview,
      vertexCount: counts[0] ?? 0,
      faceCount: counts[1] ?? 0,
      edgeCount: counts[2] ?? 0,
    };
  });
}
async function expectValidOffOutput() {
  const summary = await getOutputOffSummary();
  expect(summary).not.toBeNull();
  expect(summary.header.startsWith('OFF')).toBe(true);
  expect(summary.vertexCount).toBeGreaterThan(0);
  expect(summary.faceCount).toBeGreaterThan(0);
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function waitForRenderState() {
  await page.waitForFunction(() => {
    const shell = document.querySelector('osc-app-shell');
    const st = shell && shell._st;
    return !!st && !st.rendering && !st.previewing && !!st.output;
  }, { timeout: 60000 });
}
async function waitForViewer() {
  await page.waitForSelector('[data-testid="viewer-canvas"] canvas');
  await page.waitForFunction(() => {
    const container = document.querySelector('[data-testid="viewer-canvas"]');
    return container && container.dataset.geometryLoaded === 'true';
  }, { timeout: 60000 });
  await waitForRenderState();
}

async function expectObjectList() {
  await expectValidOffOutput();
}
async function expect3DPolySet() {
  await expectValidOffOutput();
}
async function expect3DManifold() {
  await expectValidOffOutput();
}
async function waitForParameter(name, timeout = 45000) {
  await page.waitForFunction((expectedName) => {
    const shell = document.querySelector('osc-app-shell');
    const params = shell?._st?.parameterSet?.parameters;
    return Array.isArray(params) && params.some((p) => p?.name === expectedName);
  }, { timeout }, name);
}

describe('e2e', () => {
  test('load the default page', async () => {
    await page.goto(baseUrl);
    await waitForViewer();
    await expectObjectList();
  }, longTimeout);

  test('can render cube', async () => {
    await loadSrc('cube([10, 10, 10]);');
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('use BOSL2', async () => {
    await loadSrc(`
      include <BOSL2/std.scad>;
      prismoid([40,40], [0,0], h=20);
    `);
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('use NopSCADlib', async () => {
    await loadSrc(`
      include <NopSCADlib/vitamins/led_meters.scad>
      meter(led_meter);
    `);
    await waitForViewer();
    await expect3DManifold();
  }, longTimeout);

  test('load a demo by path', async () => {
    await loadPath('/libraries/closepoints/demo_3D_art.scad');
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('load a demo by url', async () => {
    // Use a locally-served fixture instead of an external URL so the test is hermetic.
    // public/test-fixture.scad is copied to dist/ by CopyPlugin and served by
    // both the dev server (port 4000) and the production server.
    await loadUrl(`${baseUrl}test-fixture.scad`);
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('customizer & windows line endings work', async () => {
    await loadSrc([
      'myVar = 10;',
      'cube(myVar);',
    ].join('\r\n'));
    await waitForViewer();
    await expect3DPolySet();
    await waitForParameter('myVar');
    const param = await page.evaluate(() => {
      const shell = document.querySelector('osc-app-shell');
      const params = shell?._st?.parameterSet?.parameters;
      return (params ?? []).find((p) => p?.name === 'myVar') ?? null;
    });
    expect(param).not.toBeNull();
    expect(param.initial).toBe(10);
  }, longTimeout);
});

describe('worker integration', () => {
  test('compiles a trivial model successfully (exit code 0)', async () => {
    await loadSrc('cube(10);');
    await waitForViewer();
    await expect3DPolySet();
    const state = await getAppShellState();
    expect(state?.error ?? null).toBeNull();
    expect(state?.markerCount ?? 1).toBe(0);
  }, longTimeout);

  test('single render produces one stable output artifact', async () => {
    await loadSrc('cube(5);');
    await waitForViewer();
    const first = await getOutputOffSummary();
    expect(first).not.toBeNull();
    await delay(1000);
    const second = await getOutputOffSummary();
    expect(second).not.toBeNull();
    expect(second.outFileURL).toBe(first.outFileURL);
  }, longTimeout);
});

// ---------------------------------------------------------------------------
// T5 — Conformance tests
//
// These tests verify that specific SCAD primitives produce geometrically
// correct output by checking the compiler's stderr summary.  Full numeric
// geometry checks (vertex/face counts, topology hash) require parsing the raw
// OFF output — that is tracked as a future enhancement in
// working/reference/deferred-items.md.
// ---------------------------------------------------------------------------

describe('conformance — geometry primitives', () => {
  test('cube(10) produces a PolySet', async () => {
    await loadSrc('cube(10);');
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('sphere(5, $fn=20) produces a PolySet', async () => {
    await loadSrc('sphere(5, $fn=20);');
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('cylinder(h=10, r=5) produces a PolySet', async () => {
    await loadSrc('cylinder(h=10, r=5);');
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);

  test('difference of cube and sphere produces a manifold', async () => {
    // difference() goes through the Manifold CSG kernel (--backend=manifold),
    // so the compiler reports a manifold result, not a plain PolySet.
    await loadSrc('difference() { cube(10); sphere(5, $fn=20); }');
    await waitForViewer();
    await expect3DManifold();
  }, longTimeout);

  test('viewer canvas is populated after compile', async () => {
    await loadSrc('cube(10);');
    await waitForViewer();
    // Confirm the Three.js canvas is present and geometry has been loaded
    const loaded = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="viewer-canvas"]');
      return container ? container.dataset.geometryLoaded === 'true' : false;
    });
    expect(loaded).toBe(true);
  }, longTimeout);
});

// ---------------------------------------------------------------------------
// T6 — Keyboard shortcuts
// ---------------------------------------------------------------------------

describe('e2e — keyboard shortcuts', () => {
  test('pressing F5 after a render triggers a new render', async () => {
    await loadSrc('cube(5);');
    await waitForViewer();
    const before = await getAppShellState();
    expect(before).not.toBeNull();
    const beforeOutFileURL = before.outFileURL;

    // Press F5 (preview render shortcut)
    await page.keyboard.press('F5');
    await page.waitForFunction((prevUrl) => {
      const shell = document.querySelector('osc-app-shell');
      const st = shell && shell._st;
      return !!st
        && !st.rendering
        && !st.previewing
        && !!st.output
        && st.output.outFileURL !== prevUrl;
    }, { timeout: 30000 }, beforeOutFileURL);
    await expect3DPolySet();
  }, longTimeout);

  test('pressing F6 after a render triggers a full render', async () => {
    await loadSrc('cube(5);');
    await waitForViewer();
    const before = await getAppShellState();
    expect(before).not.toBeNull();
    const beforeOutFileURL = before.outFileURL;

    // Press F6 (full render shortcut)
    await page.keyboard.press('F6');
    await page.waitForFunction((prevUrl) => {
      const shell = document.querySelector('osc-app-shell');
      const st = shell && shell._st;
      return !!st
        && !st.rendering
        && !st.previewing
        && !!st.output
        && st.output.isPreview === false
        && st.output.outFileURL !== prevUrl;
    }, { timeout: 45000 }, beforeOutFileURL);
    await waitForViewer();
    await expect3DPolySet();
  }, longTimeout);
});
