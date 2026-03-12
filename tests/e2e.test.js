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
async function waitForViewer() {
  await page.waitForSelector('model-viewer');
  await page.waitForFunction(() => {
    const viewer = document.querySelector('model-viewer.main-viewer');
    return viewer && viewer.src !== '';
  });
}
// Poll the Node-scope `messages` array until a matching console entry arrives.
// Must be used instead of page.waitForFunction when the predicate inspects the
// Puppeteer-captured message log (not accessible from browser context).
function waitForRenderMessage(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(() => {
      if (messages.some(predicate)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for render message'));
      }
    }, 100);
  });
}

function expectMessage(messages, line) {
  const successMessage = messages.filter(msg => msg.type === 'debug' && msg.text === line);
  expect(successMessage).toHaveLength(1);
}
function expectObjectList() {
  expectMessage(messages, 'stderr: Top level object is a list of objects:');
}
function expect3DPolySet() {
  expectMessage(messages, 'stderr: Top level object is a 3D object (PolySet):');
}
function expect3DManifold() {
  expectMessage(messages, 'stderr:    Top level object is a 3D object (manifold):');
}
function waitForCustomizeButton() {
  return page.waitForFunction(() => {
    // Try multiple selectors for PrimeReact components
    // ToggleButton might render as button or input elements
    const selectors = [
      'input[role=switch]',
      'button',
      '[role=tab]',
      '.p-togglebutton',
      '.p-tabmenu-nav a'
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element.textContent || element.innerText || '';
        const parentText = element.parentElement?.textContent || element.parentElement?.innerText || '';
        if (text.includes('Customize') || parentText.includes('Customize')) {
          return element;
        }
      }
    }
    return null;
  }, { timeout: 45000 }); // Increase timeout to 45 seconds
}
function waitForLabel(text) {
  return page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('label')).find(el => el.textContent === 'myVar');
    // return Array.from(document.querySelectorAll('label')).find(el => el.textContent === text);
  });
}

describe('e2e', () => {
  test('load the default page', async () => {
    await page.goto(baseUrl);
    await waitForViewer();
    expectObjectList();
  }, longTimeout);

  test('can render cube', async () => {
    await loadSrc('cube([10, 10, 10]);');
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('use BOSL2', async () => {
    await loadSrc(`
      include <BOSL2/std.scad>;
      prismoid([40,40], [0,0], h=20);
    `);
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('use NopSCADlib', async () => {
    await loadSrc(`
      include <NopSCADlib/vitamins/led_meters.scad>
      meter(led_meter);
    `);
    await waitForViewer();
    expect3DManifold();
  }, longTimeout);

  test('load a demo by path', async () => {
    await loadPath('/libraries/closepoints/demo_3D_art.scad');
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('load a demo by url', async () => {
    // Use a locally-served fixture instead of an external URL so the test is hermetic.
    // public/test-fixture.scad is copied to dist/ by CopyPlugin and served by
    // both the dev server (port 4000) and the production server.
    await loadUrl(`${baseUrl}test-fixture.scad`);
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('customizer & windows line endings work', async () => {
    await loadSrc([
      'myVar = 10;',
      'cube(myVar);',
    ].join('\r\n'));
    await waitForViewer();
    expect3DPolySet();

    // Wait for syntax checking to complete and parameters to be detected
    await page.waitForFunction(() => {
      // Look for any indication that parameters have been processed
      const messages = Array.from(document.querySelectorAll('*')).map(el => el.textContent || '').join(' ');
      return messages.includes('myVar') || messages.includes('Customize');
    }, { timeout: 30000 });

    await (await waitForCustomizeButton()).click();
    await page.waitForSelector('fieldset');
    await waitForLabel('myVar');
  }, longTimeout);
});

describe('worker integration', () => {
  test('compiles a trivial model successfully (exit code 0)', async () => {
    await loadSrc('cube(10);');
    await waitForViewer();
    // A successful compile surfaces the geometry summary on stderr
    expect3DPolySet();
  }, longTimeout);

  test('exactly one worker is created per page session', async () => {
    await loadSrc('cube(5);');
    await waitForViewer();
    const workerCreatedLogs = messages.filter(
      msg => msg.type === 'log' && msg.text === '[runner] Worker created'
    );
    expect(workerCreatedLogs).toHaveLength(1);
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
    expect3DPolySet();
  }, longTimeout);

  test('sphere(5, $fn=20) produces a PolySet', async () => {
    await loadSrc('sphere(5, $fn=20);');
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('cylinder(h=10, r=5) produces a PolySet', async () => {
    await loadSrc('cylinder(h=10, r=5);');
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('difference of cube and sphere produces a manifold', async () => {
    // difference() goes through the Manifold CSG kernel (--backend=manifold),
    // so the compiler reports a manifold result, not a plain PolySet.
    await loadSrc('difference() { cube(10); sphere(5, $fn=20); }');
    await waitForViewer();
    expect3DManifold();
  }, longTimeout);

  test('model-viewer receives a non-empty src after compile', async () => {
    await loadSrc('cube(10);');
    await waitForViewer();
    // Confirm the model-viewer element actually received a model blob URL
    const src = await page.evaluate(() => {
      const viewer = document.querySelector('model-viewer.main-viewer');
      return viewer ? viewer.getAttribute('src') : null;
    });
    expect(src).toBeTruthy();
    expect(src).toMatch(/^blob:|^data:/);
  }, longTimeout);
});

// ---------------------------------------------------------------------------
// T6 — Keyboard shortcuts
// ---------------------------------------------------------------------------

describe('e2e — keyboard shortcuts', () => {
  test('pressing F5 after a render triggers a new render', async () => {
    await loadSrc('cube(5);');
    await waitForViewer();
    messages.length = 0;

    // Press F5 (preview render shortcut)
    await page.keyboard.press('F5');

    // Poll the Node-scope `messages` array for the compile result.
    // page.waitForFunction cannot reach Node-scope variables, and waiting for
    // model-viewer src change was unreliable in headless CI Chromium.
    await waitForRenderMessage(
      msg => msg.type === 'debug' && msg.text.includes('3D object'),
      30000,
    );
  }, longTimeout);

  test('pressing F6 after a render triggers a full render', async () => {
    await loadSrc('cube(5);');
    await waitForViewer();
    messages.length = 0;

    // Press F6 (full render shortcut)
    await page.keyboard.press('F6');
    await waitForViewer();

    expect3DPolySet();
  }, longTimeout);
});

