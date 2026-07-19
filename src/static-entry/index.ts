// Static geometry entry: a standalone, read-only <osc-geometry-viewer> that
// fetches a PRE-RENDERED OFF file named in the boot config and displays it —
// no host transport, no compiler, no WASM. This powers the `static` publish
// surface: a docs page embeds it to show a model with no in-browser render.
//
// Like viewer-entry it deliberately pulls in NOTHING from the app shell — no
// Model, BrowserFS, OpenSCAD WASM, Monaco, or service worker — so it stays
// small; scripts/verify-viewer-bundle.mjs enforces that exclusion.

import '../components/elements/osc-geometry-viewer.ts';
import type { GeometryViewer } from '../viewer-host/controller.ts';
import { loadBootConfig } from '../runtime/boot-config.ts';

function showMessage(root: HTMLElement, text: string): void {
  const message = document.createElement('div');
  message.style.cssText =
    'padding:1rem;font-family:system-ui,sans-serif;color:#d2dbc5;font-size:0.9rem;';
  message.textContent = text;
  root.replaceChildren(message);
}

window.addEventListener('load', async () => {
  const root = document.getElementById('viewer-root')!;
  const config = await loadBootConfig();

  if (typeof config.title === 'string' && config.title.trim() !== '') {
    document.title = config.title;
  }

  if (typeof config.geometry !== 'string' || config.geometry.trim() === '') {
    showMessage(root, 'No geometry configured for this model.');
    return;
  }

  const viewer = document.createElement('osc-geometry-viewer') as GeometryViewer;
  // Display-only: no preview-thumbnail hashing (needs a GL readback we don't use).
  viewer.generateThumbnails = false;
  // A parse/render failure of the geometry surfaces as a `viewer-error` event
  // rather than rejecting the fetch — show it instead of a blank viewport.
  viewer.addEventListener('viewer-error', (event) => {
    const detail = (event as CustomEvent).detail;
    showMessage(
      root,
      `Failed to render geometry: ${detail instanceof Error ? detail.message : String(detail)}`,
    );
  });
  root.replaceChildren(viewer);

  const geometryUrl = new URL(config.geometry, document.baseURI).toString();
  try {
    const response = await fetch(geometryUrl, { cache: 'no-store' });
    if (!response.ok) {
      showMessage(root, `Failed to load geometry (HTTP ${response.status}).`);
      return;
    }
    viewer.offText = await response.text();
  } catch (error) {
    showMessage(
      root,
      `Failed to load geometry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
