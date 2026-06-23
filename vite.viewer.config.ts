import { defineConfig } from 'vite';
import { createAppViteConfig } from './vite.shared.ts';

// The DISTRIBUTABLE viewer-only build (#143/#175): just viewer.html + its chunk
// graph, with RELATIVE asset URLs so it loads under an opaque VS Code webview
// origin (the Pages build's absolute /openscad-web/ URLs would not). A separate
// config + outDir keeps it entirely out of the main `dist` graph, so the service
// worker, bundle budgets, and publish archive are untouched. The output is gated
// by `verify-viewer-bundle --dir dist-viewer` and pinned by a viewer-manifest.json.
export default defineConfig(
  createAppViteConfig({
    base: './',
    outDir: 'dist-viewer',
    entries: ['viewer.html'],
    // No public/ copy: the standalone viewer fetches none of the app's static
    // assets (libraries zips, fonts, chime, fixtures) at runtime, so the
    // distributable stays minimal — viewer.html + its chunks + the manifest.
    publicDir: false,
  }),
);
