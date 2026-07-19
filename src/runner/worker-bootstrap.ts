// How the OpenSCAD compile worker is created and configured (#196).
//
// Two host environments:
//   - Normal page: `new Worker(url, { type: 'module' })` — the worker URL is
//     same-origin, and `import.meta.url` here (the main thread) resolves the wasm.
//   - VS Code webview: worker resources are cross-origin (`*.vscode-cdn.net` ≠
//     `vscode-webview://`), so `new Worker(crossOriginUrl)` is SOP-blocked. The
//     session-entry calls `configureWorkerBootstrap()` once to instantiate the
//     worker from a same-origin `blob:` URL instead.
//
// EITHER WAY, the worker bundle no longer derives its own asset base from
// `import.meta.url`/`self.location` (which is `blob:` and unusable in a webview).
// The host resolves the asset base + the wasm URL — where `import.meta.url` is a
// real URL — and injects them via the `configure` message (see `getWorker`).

import openSCADWorkerUrl from './openscad-worker.ts?worker&url';
import { openSCADWasmUrl } from './openscad-asset-urls.ts';
import { getDefaultRuntimeBaseUrl } from '../runtime/asset-urls.ts';
import type { ConfigureRequest } from './worker-protocol.ts';

let blobWorkerUrl: string | null = null;
let assetBaseOverride: string | undefined;
let assetUrlsOverride: Record<string, string> | undefined;
let wasmUrlOverride: string | undefined;

/**
 * Configure the bootstrap for a host whose worker/asset URLs are cross-origin to
 * the document (a VS Code webview): pre-fetch the worker script (a `fetch` of the
 * cross-origin URL is permitted — only `new Worker` of it is blocked) and cache a
 * same-origin `blob:` URL to instantiate from, and pin the base the worker resolves
 * assets against. Call once, before constructing the session. Idempotent-ish: the
 * blob URL is created once and reused across worker recycles.
 *
 * `assetUrls`/`wasmUrl` (optional): a webview's blob worker can't fetch the
 * `vscode-resource` asset URLs (its fetches bypass the resource service worker,
 * #203), so the host pre-fetches each asset on the main thread and passes
 * same-origin `blob:` URLs the worker can fetch (`wasmUrl` becomes a blob too).
 */
export async function configureWorkerBootstrap(opts: {
  assetBase: string;
  assetUrls?: Record<string, string>;
  wasmUrl?: string;
}): Promise<void> {
  if (!blobWorkerUrl) {
    const source = await fetch(openSCADWorkerUrl).then((r) => r.text());
    blobWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  }
  assetBaseOverride = opts.assetBase;
  assetUrlsOverride = opts.assetUrls;
  wasmUrlOverride = opts.wasmUrl;
}

export function createOpenSCADWorker(): Worker {
  // A blob worker must be classic — the worker bundle is built as a single IIFE
  // (vite.shared.ts `worker.format: 'iife'`), so there are no ESM imports to load.
  return blobWorkerUrl
    ? new Worker(blobWorkerUrl)
    : new Worker(openSCADWorkerUrl, { type: 'module' });
}

/**
 * The `configure` message the host posts to a freshly-created worker, before any
 * compile. `wasmUrl` and `assetBase` are resolved HERE (main thread), where
 * `import.meta.url` is a real URL, then handed to the worker verbatim (#196).
 *
 * `assetBase` goes through `getDefaultRuntimeBaseUrl()` so it honors a
 * `setRuntimeAssetBase()` override — e.g. a shared-runtime thin mount pins the
 * base to the shared runtime, which is where the worker's libraries/fonts live.
 * Without that, the worker would inherit the mount's `document.baseURI`, which
 * on a thin mount has no `libraries/`.
 */
export function workerConfigPayload(): ConfigureRequest {
  return {
    type: 'configure',
    assetBase: assetBaseOverride ?? getDefaultRuntimeBaseUrl(),
    wasmUrl: wasmUrlOverride ?? openSCADWasmUrl,
    ...(assetUrlsOverride ? { assetUrls: assetUrlsOverride } : {}),
  };
}

export { openSCADWorkerUrl };
