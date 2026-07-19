// #196: the worker bootstrap picks a same-origin blob worker for a cross-origin
// (webview) host and injects a host-resolved asset base + wasm URL. Module state
// is per-file in vitest, so this file owns the bootstrap's one-shot config.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  configureWorkerBootstrap,
  createOpenSCADWorker,
  workerConfigPayload,
} from '../worker-bootstrap.ts';
import { setRuntimeAssetBase } from '../../runtime/asset-urls.ts';

const workerArgs: { url: unknown; opts: unknown }[] = [];
const origCreateObjectURL = URL.createObjectURL;

beforeAll(() => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor(url: unknown, opts?: unknown) {
        workerArgs.push({ url, opts });
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ text: async () => '/* worker iife */' })),
  );
  URL.createObjectURL = vi.fn(() => 'blob:fake-uuid') as typeof URL.createObjectURL;
});

afterAll(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = origCreateObjectURL;
});

describe('worker bootstrap (#196)', () => {
  it('default → a module worker from the asset URL; the config payload host-resolves base + wasm', () => {
    const payload = workerConfigPayload();
    expect(payload.type).toBe('configure');
    expect(typeof payload.assetBase).toBe('string');
    expect(payload.assetBase.length).toBeGreaterThan(0);
    expect(typeof payload.wasmUrl).toBe('string');

    createOpenSCADWorker();
    expect(workerArgs.at(-1)).toMatchObject({ opts: { type: 'module' } });
    expect(String(workerArgs.at(-1)!.url)).not.toMatch(/^blob:/);
  });

  // Regression (#240): on a shared-runtime thin mount (no webview configure),
  // setRuntimeAssetBase pins the main-thread base to the shared runtime. The
  // worker's configure payload must carry THAT base, not the mount's
  // document.baseURI — the thin mount has no libraries/fonts of its own.
  it('shared-runtime override → the config payload carries the shared base', () => {
    setRuntimeAssetBase('https://site.example/_openscad-web/v0.4.0/');
    try {
      expect(workerConfigPayload().assetBase).toBe('https://site.example/_openscad-web/v0.4.0/');
    } finally {
      setRuntimeAssetBase(null);
    }
  });

  it('after configure → a classic blob worker, and the payload carries the injected base', async () => {
    await configureWorkerBootstrap({ assetBase: 'https://abc.vscode-cdn.net/mount/' });

    createOpenSCADWorker();
    // classic worker: a blob: URL and no `{ type: 'module' }`.
    expect(workerArgs.at(-1)).toEqual({ url: 'blob:fake-uuid', opts: undefined });

    expect(workerConfigPayload().assetBase).toBe('https://abc.vscode-cdn.net/mount/');
  });

  it('configure with blob asset URLs → the payload carries them + the blob wasm (#203)', async () => {
    await configureWorkerBootstrap({
      assetBase: 'https://abc.vscode-cdn.net/mount/',
      assetUrls: { 'libraries/fonts.zip': 'blob:fonts' },
      wasmUrl: 'blob:wasm',
    });
    const payload = workerConfigPayload();
    expect(payload.wasmUrl).toBe('blob:wasm');
    expect(payload.assetUrls).toEqual({ 'libraries/fonts.zip': 'blob:fonts' });
  });
});
