// Compile-capable session entry (#193, part of #179): the distributable counterpart
// to the read-only viewer-entry. It boots the OpenSCAD WASM engine + an embedded
// <osc-geometry-viewer> in ONE webview and binds them to the Layer-1 session
// transport via the SessionController (#192). Geometry renders IN-PROCESS — the
// controller sets the viewer's `offText` locally; nothing but the L1 protocol
// crosses the wire (bytes only later, for export — #197).
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
import { selectViewerTransport } from '../viewer-host/transports/select.ts';
import type { GeometryViewer } from '../viewer-host/controller.ts';

async function main(): Promise<void> {
  const root = document.getElementById('session-root')!;
  const viewer = document.createElement('osc-geometry-viewer') as GeometryViewer;
  // Host-display only — no preview placeholder, so skip thumbnail hashing.
  viewer.generateThumbnails = false;
  root.appendChild(viewer);

  // Resolve the same-origin blob worker + asset base (#196) BEFORE the first
  // compile: under a webview the worker/asset URLs are cross-origin, so the worker
  // must be instantiated from a same-origin blob and told its asset base. The
  // worker is created lazily on the first compile, so configuring before the
  // session is constructed is sufficient. Run it alongside FS init.
  const [, { fs }] = await Promise.all([
    configureWorkerBootstrap({ assetBase: document.baseURI }),
    ensureBrowserFSLoaded().then(() => createEditorFS({ allowPersistence: false })),
  ]);

  // No `init()`: the embedded-session lifecycle is host-driven (#179). The viewer
  // stays empty until the host's first `setProject`, which drives the first real
  // compile — calling `init()` would compile the default state and flash unwanted
  // geometry. Construct the controller LAST; its ctor subscribes then announces
  // `ready`, so the host can send a command the instant it sees readiness.
  const session = new OpenScadSession(fs, createInitialState(null));
  new SessionController(sessionHostOf(session), viewer, selectViewerTransport());
}

void main();
