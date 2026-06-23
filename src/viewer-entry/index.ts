// Viewer-only entry: a standalone, read-only <osc-geometry-viewer> driven
// entirely by the Layer-0 host transport (ADR 0005). It deliberately pulls in
// NOTHING from the app shell — no Model, BrowserFS, OpenSCAD WASM, Monaco, or
// service worker — so it can run inside a VS Code webview or any iframe host.
// scripts/verify-viewer-bundle.mjs enforces that exclusion at build time.

import '../components/elements/osc-geometry-viewer.ts';
import { isTrustedOrigin } from '../protocol/envelope.ts';
import {
  validateViewerInbound,
  viewerCameraChange,
  viewerCameraSet,
  viewerDisposed,
  viewerError,
  viewerGeometryLoaded,
  viewerGeometrySet,
  viewerReady,
  viewerSettingsSet,
} from '../protocol/viewer-transport.ts';
import type { CameraState } from '../components/viewer/ThreeScene.ts';

type GeometryViewer = HTMLElement & {
  offText: string | null;
  color: string;
  showAxes: boolean;
  active: boolean;
  generateThumbnails: boolean;
  setCamera(camera: CameraState): void;
};

const selfOrigin = window.location.origin;
// A trusted parent origin may be injected via ?parentOrigin=…; parse it as a URL
// and keep only the origin, rejecting malformed values and unsupported schemes
// (and never the wildcard). A bad value falls back to same-origin-only trust.
function canonicalOrigin(raw: string | null): string | null {
  if (raw == null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}
const parentOrigin = canonicalOrigin(
  new URLSearchParams(window.location.search).get('parentOrigin'),
);
const targetOrigin = parentOrigin ?? selfOrigin;
// The viewer is meant to be embedded (iframe / webview): the host is the parent
// frame. When opened top-level there is no host — don't post to ourselves (that
// would re-enter our own inbound handler).
const host: Window | null = window.parent !== window ? window.parent : null;

const root = document.getElementById('viewer-root')!;
const viewer = document.createElement('osc-geometry-viewer') as GeometryViewer;
// Host-display only — no preview placeholder, so skip thumbnail hashing.
viewer.generateThumbnails = false;
root.appendChild(viewer);

function post(message: object): void {
  host?.postMessage(message, targetOrigin);
}

// Forward viewer events to the host.
viewer.addEventListener('camera-change', (e) => {
  post(viewerCameraChange((e as CustomEvent<CameraState>).detail));
});
viewer.addEventListener('geometry-loaded', (e) => {
  post(viewerGeometryLoaded((e as CustomEvent<{ thumbhash?: string }>).detail.thumbhash));
});
viewer.addEventListener('viewer-error', (e) => {
  // A render/parse failure of host-supplied geometry — distinct from a protocol
  // validation rejection. Not opId-correlated: geometry loading is async and
  // decoupled from the setGeometry message that triggered it.
  post(viewerError('render-error', String((e as CustomEvent).detail)));
});

const onMessage = (event: MessageEvent): void => {
  // Trust both the origin AND the sender window: a same-origin sibling frame
  // must not be able to drive the viewer. When embedded, only the host frame.
  if (host !== null && event.source !== host) return;
  if (!isTrustedOrigin(event.origin, parentOrigin, selfOrigin)) return;
  const result = validateViewerInbound(event.data);
  if (!result.ok) {
    post(viewerError(result.code, result.reason, result.opId));
    return;
  }
  const msg = result.message;
  switch (msg.type) {
    case 'setGeometry':
      viewer.offText = msg.offText;
      post(viewerGeometrySet(msg.opId));
      break;
    case 'setViewerSettings':
      if (msg.color !== undefined) viewer.color = msg.color;
      if (msg.showAxes !== undefined) viewer.showAxes = msg.showAxes;
      if (msg.active !== undefined) viewer.active = msg.active;
      post(viewerSettingsSet(msg.opId));
      break;
    case 'setCamera':
      viewer.setCamera(msg.camera);
      post(viewerCameraSet(msg.opId));
      break;
    case 'dispose':
      // Tear down fully: remove the element (disposes the GL scene) and stop
      // listening, so no further messages are silently swallowed.
      viewer.remove();
      window.removeEventListener('message', onMessage);
      post(viewerDisposed(msg.opId));
      break;
  }
};
window.addEventListener('message', onMessage);

// Announce readiness and the supported inbound commands.
post(viewerReady(['setGeometry', 'setViewerSettings', 'setCamera', 'dispose']));
