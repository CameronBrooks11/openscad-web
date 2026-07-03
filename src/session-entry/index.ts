// Compile-capable session entry (#193, part of #179): the distributable counterpart
// to the read-only viewer-entry. It boots the OpenSCAD WASM engine + an embedded
// <osc-geometry-viewer> in ONE webview and binds them to the Layer-1 session
// transport via the SessionController (#192). Geometry renders IN-PROCESS — the
// controller sets the viewer's `offText` locally; nothing but the L1 protocol
// crosses the wire (bytes only via the `getArtifact` reply, #197).
//
// Deliberately omits the app shell: no Monaco/editor, no service worker, no state
// persistence. The host (a VS Code webview) owns the project lifecycle and drives
// it over the transport; `vite.session.config.ts` builds this to `dist-session`
// with relative URLs so it loads under an opaque webview origin.

import '../components/elements/osc-geometry-viewer.ts';
import { SessionController } from '../session-host/controller.ts';
import { sessionHostOf } from '../session-host/session-host.ts';
import { OpenScadSession } from '../state/session.ts';
import { createInitialState } from '../state/initial-state.ts';
import { createEditorFS } from '../fs/filesystem.ts';
import { ensureBrowserFSLoaded } from '../runtime/browserfs-runtime.ts';
import { configureWorkerBootstrap } from '../runner/worker-bootstrap.ts';
import { openSCADWasmUrl } from '../runner/openscad-asset-urls.ts';
import {
  normalizeAssetSpecifier,
  resolveRuntimeAssetUrl,
  setRuntimeAssetUrls,
} from '../runtime/asset-urls.ts';
import { fetchAssetBytes } from '../runtime/fetch-asset.ts';
import { zipArchives } from '../fs/zip-archives.generated.ts';
import { selectViewerTransport } from '../viewer-host/transports/select.ts';
import { WebHostAdapter } from '../state/web-host-adapter.ts';
import type { GeometryViewer } from '../viewer-host/controller.ts';

/**
 * Pre-fetch every runtime asset the compile worker needs (the WASM binary, fonts,
 * and all bundled library zips) and wrap each in a same-origin `blob:` URL (#203).
 *
 * Why: under a VS Code webview the compile worker is a `blob:` dedicated worker
 * whose `vscode-resource` fetches bypass the webview's resource service worker
 * (they 408). The main thread CAN fetch those resources (the SW serves them), so
 * we fetch here and hand the worker blob: URLs it can fetch instead. The worker
 * demand-loads libraries asynchronously but can't ask the host mid-compile (the FS
 * is synchronous), so every candidate asset is pre-fetched up front. Used on a
 * normal page too (harmless — same-origin), so the served acceptance test exercises
 * this exact path.
 */
async function prefetchAssetBlobs(): Promise<{
  assetUrls: Record<string, string>;
  wasmUrl: string;
}> {
  const specs = ['libraries/fonts.zip', ...zipArchives.map((a) => a.zipPath)];
  const toBlobUrl = async (url: string, type: string): Promise<string> =>
    URL.createObjectURL(new Blob([await fetchAssetBytes(url)], { type }));

  const [wasmUrl, ...zipUrls] = await Promise.all([
    toBlobUrl(openSCADWasmUrl, 'application/wasm'),
    ...specs.map((spec) => toBlobUrl(resolveRuntimeAssetUrl(spec), 'application/zip')),
  ]);
  const assetUrls = Object.fromEntries(
    specs.map((spec, i) => [normalizeAssetSpecifier(spec), zipUrls[i]]),
  );
  return { assetUrls, wasmUrl };
}

async function main(): Promise<void> {
  const root = document.getElementById('session-root')!;
  const viewer = document.createElement('osc-geometry-viewer') as GeometryViewer;
  // Host-display only — no preview placeholder, so skip thumbnail hashing.
  viewer.generateThumbnails = false;
  root.appendChild(viewer);

  // Pre-fetch the runtime assets into same-origin blob: URLs the worker can fetch
  // in a webview (#203), in parallel with BrowserFS init.
  const [{ assetUrls, wasmUrl }] = await Promise.all([
    prefetchAssetBlobs(),
    ensureBrowserFSLoaded(),
  ]);
  // The main thread's own createEditorFS resolves the same specs — reuse the blobs.
  setRuntimeAssetUrls(assetUrls);

  // Resolve the same-origin blob worker + asset base (#196) and the blob asset URLs
  // (#203) BEFORE the first compile: the worker is created lazily on the first
  // compile, so configuring before the session is constructed is sufficient.
  const [, { fs }] = await Promise.all([
    configureWorkerBootstrap({ assetBase: document.baseURI, assetUrls, wasmUrl }),
    createEditorFS({ allowPersistence: false }),
  ]);

  // No `init()`: the embedded-session lifecycle is host-driven (#179). The viewer
  // stays empty until the host's first `setProject`, which drives the first real
  // compile — calling `init()` would compile the default state and flash unwanted
  // geometry. Construct the controller LAST; its ctor subscribes then announces
  // `ready`, so the host can send a command the instant it sees readiness.
  //
  // Host-driven export (#216) deltas vs the app: the HOST saves bytes (via
  // getArtifact), so the in-page download side effect is a no-op — a webview
  // can't meaningfully service an <a download> click anyway — and the 3MF
  // multimaterial picker must never block (there is no UI here; default colors
  // apply).
  const state = createInitialState(null);
  state.params.skipMultimaterialPrompt = true;
  const host = new (class extends WebHostAdapter {
    override download(): void {}
    override downloadBlob(): void {}
    override playCompletionChime(): void {}
  })();
  const session = new OpenScadSession(fs, state, undefined, undefined, host);
  new SessionController(sessionHostOf(session), viewer, selectViewerTransport());
}

void main();
