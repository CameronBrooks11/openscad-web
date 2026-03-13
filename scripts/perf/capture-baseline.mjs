import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const serveEntrypoint = require.resolve('serve/build/main.js');
const captureMetaKey = '__OSC_PERF_CAPTURE_CONTEXT__';

const port = Number.parseInt(process.env.PERF_PORT ?? '4173', 10);
const outputPath = path.resolve(
  repoRoot,
  process.env.PERF_OUTPUT ?? 'coverage/perf/current-perf-baseline.json',
);
const baseUrl = new URL(process.env.PERF_BASE_PATH ?? '/', `http://127.0.0.1:${port}`).toString();

function round(value) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

function latestDuration(snapshot, name) {
  const matches = (snapshot?.metrics ?? []).filter(
    (metric) => metric?.name === name && metric?.kind === 'duration' && metric?.duration != null,
  );
  if (matches.length === 0) {
    return null;
  }
  return round(matches[matches.length - 1].duration);
}

function summarizeRun(payload) {
  const firstContentfulPaint = payload.paintEntries.find(
    (entry) => entry.name === 'first-contentful-paint',
  );

  return {
    firstContentfulPaintMillis: round(firstContentfulPaint?.startTime ?? null),
    appBootstrapMillis: latestDuration(payload.snapshot, 'osc:app-bootstrap'),
    mainFsInitMillis: latestDuration(payload.snapshot, 'osc:main-fs-init'),
    librariesPreloadMillis: latestDuration(payload.snapshot, 'osc:libraries-preload'),
    languageRegisterMillis: latestDuration(payload.snapshot, 'osc:language-register'),
    editorMountMillis: latestDuration(payload.snapshot, 'osc:editor-mount'),
    firstCompileFromBootstrapMillis: latestDuration(
      payload.snapshot,
      'osc:first-compile-from-bootstrap',
    ),
    firstCompileRoundtripMillis: latestDuration(payload.snapshot, 'osc:first-compile-roundtrip'),
    workerFsInitMillis: latestDuration(payload.snapshot, 'osc:worker-fs-init'),
    workerLibraryMountMillis: latestDuration(payload.snapshot, 'osc:worker-library-mount'),
    workerWasmInitMillis: latestDuration(payload.snapshot, 'osc:worker-wasm-init'),
    workerJobTotalMillis: latestDuration(payload.snapshot, 'osc:worker-job-total'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok || response.status === 304) {
        return;
      }
      lastError = new Error(`Unexpected HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function waitForServerReady(server, url) {
  await Promise.race([
    waitForServer(url),
    new Promise((_, reject) => {
      server.once('error', reject);
      server.once('exit', (code, signal) => {
        reject(
          new Error(
            `Static server exited before becoming ready (code=${code ?? 'null'}, signal=${
              signal ?? 'null'
            })`,
          ),
        );
      });
    }),
  ]);
}

async function stopServer(server) {
  if (server.exitCode != null || server.signalCode != null) {
    server.stdout?.destroy();
    server.stderr?.destroy();
    return;
  }

  const exitPromise = waitForProcessExit(server);
  server.kill();

  const exited = await Promise.race([exitPromise.then(() => true), sleep(5_000).then(() => false)]);

  if (!exited && server.pid) {
    if (process.platform === 'win32') {
      const killer = spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      await waitForProcessExit(killer);
    } else {
      server.kill('SIGKILL');
    }

    await Promise.race([exitPromise, sleep(5_000)]);
  }

  server.stdout?.destroy();
  server.stderr?.destroy();
}

async function clearOriginState(page, origin) {
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.clearBrowserCache');
  await client.send('Storage.clearDataForOrigin', {
    origin,
    storageTypes: 'all',
  });
}

async function createPerfPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((key) => {
    globalThis[key] = {
      loadStartedControlled: !!navigator.serviceWorker?.controller,
    };
  }, captureMetaKey);
  return page;
}

async function waitForServiceWorkerReady(page) {
  await Promise.race([
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return false;
      }
      await navigator.serviceWorker.ready;
      return true;
    }),
    sleep(60_000).then(() => {
      throw new Error('Timed out waiting for service worker readiness.');
    }),
  ]);
}

async function waitForPerfReady(page) {
  await page.waitForFunction(
    () => {
      const shell = document.querySelector('osc-app-shell');
      const state = shell?._st;
      const perf = globalThis.__OSC_PERF__;
      const compileFinished =
        Array.isArray(perf?.metrics) &&
        perf.metrics.some((metric) => metric?.name === 'osc:first-compile-from-bootstrap');
      return !!state && (!!state.error || compileFinished);
    },
    { timeout: 120_000 },
  );
}

async function collectRun(page) {
  await waitForPerfReady(page);

  const payload = await page.evaluate((key) => {
    const shell = document.querySelector('osc-app-shell');
    const state = shell?._st;
    const snapshot = globalThis.__OSC_PERF__ ?? null;
    const captureMeta = globalThis[key] ?? null;
    const paintEntries = performance.getEntriesByType('paint').map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
    }));

    return {
      error: state?.error ?? null,
      loadStartedControlled: captureMeta?.loadStartedControlled ?? null,
      serviceWorkerControlledAtCapture: !!navigator.serviceWorker?.controller,
      snapshot,
      paintEntries,
    };
  }, captureMetaKey);

  if (payload.error) {
    throw new Error(`App entered an error state during perf capture: ${payload.error}`);
  }
  if (!payload.snapshot) {
    throw new Error('Performance snapshot was not initialized.');
  }

  return {
    loadStartedControlled: payload.loadStartedControlled,
    serviceWorkerControlledAtCapture: payload.serviceWorkerControlledAtCapture,
    metrics: summarizeRun(payload),
  };
}

async function main() {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const server = spawn(process.execPath, [serveEntrypoint, '-s', 'dist', '-l', String(port)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServerReady(server, baseUrl);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await createPerfPage(browser);
      const origin = new URL(baseUrl).origin;

      await clearOriginState(page, origin);
      await page.setCacheEnabled(false);
      await page.setBypassServiceWorker(true);

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      const cold = await collectRun(page);

      await waitForServiceWorkerReady(page);
      await sleep(1_500);
      await page.setBypassServiceWorker(false);
      await page.setCacheEnabled(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 60_000 });
      const warm = await collectRun(page);

      if (cold.loadStartedControlled) {
        throw new Error('Cold perf run started under service worker control.');
      }
      if (!warm.loadStartedControlled) {
        throw new Error('Warm perf run did not start under service worker control.');
      }

      const result = {
        version: 1,
        capturedAt: new Date().toISOString(),
        environment: {
          mode: 'production',
          browser: 'chrome',
          profile: 'local-headless',
        },
        metrics: cold.metrics,
        warmMetrics: warm.metrics,
        notes: {
          coldLoadStartedControlled: cold.loadStartedControlled,
          coldServiceWorkerControlledAtCapture: cold.serviceWorkerControlledAtCapture,
          coldServiceWorkerBypassed: true,
          warmLoadStartedControlled: warm.loadStartedControlled,
          warmServiceWorkerControlledAtCapture: warm.serviceWorkerControlledAtCapture,
          warmServiceWorkerBypassed: false,
        },
      };

      await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.log(`Wrote perf baseline candidate to ${outputPath}`);
    } finally {
      await browser.close();
    }
  } catch (error) {
    throw new Error(`Perf capture failed.\n${serverOutput}\n${error}`);
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
