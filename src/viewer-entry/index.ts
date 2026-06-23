// Viewer-only entry: a standalone, read-only <osc-geometry-viewer> driven
// entirely by the Layer-0 host transport (ADR 0005). It deliberately pulls in
// NOTHING from the app shell — no Model, BrowserFS, OpenSCAD WASM, Monaco, or
// service worker — so it can run inside a VS Code webview or any iframe host.
// scripts/verify-viewer-bundle.mjs enforces that exclusion at build time.
//
// This is just the composition root: create the viewer element, pick a transport
// for the host environment, and let the ViewerController wire them together.

import '../components/elements/osc-geometry-viewer.ts';
import { ViewerController, type GeometryViewer } from '../viewer-host/controller.ts';
import { BrowserParentTransport } from '../viewer-host/transports/browser-parent.ts';

const root = document.getElementById('viewer-root')!;
const viewer = document.createElement('osc-geometry-viewer') as GeometryViewer;
// Host-display only — no preview placeholder, so skip thumbnail hashing.
viewer.generateThumbnails = false;
root.appendChild(viewer);

new ViewerController(viewer, new BrowserParentTransport());
