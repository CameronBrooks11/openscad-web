import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

import { createAppViteConfig } from './vite.shared.ts';

// The DISTRIBUTABLE compile-capable build (#193, part of #179): session.html + its
// chunk graph (BrowserFS + OpenSCAD WASM worker + the embedded viewer), with
// RELATIVE asset URLs so it loads under an opaque VS Code webview origin — the
// same relocation the read-only `dist-viewer` solved, but compile-capable.
//
// Unlike the viewer, this MUST ship the runtime assets the compile path fetches:
// the OpenSCAD library zips + fonts. The WASM and worker auto-bundle into the
// graph (`openscad.wasm?url`, `openscad-worker.ts?worker&url`); only the zips live
// in `public/` and must be copied. We copy ONLY `public/libraries/` (not the rest
// of `public/` — logos, sounds, test fixtures) to keep the vendored artifact lean;
// #194 will hash every shipped file into a session-manifest, so dead weight there
// is real cost.
function copySessionLibraries(outDir: string): Plugin {
  return {
    name: 'session-copy-libraries',
    apply: 'build',
    closeBundle() {
      cpSync(
        fileURLToPath(new URL('./public/libraries', import.meta.url)),
        fileURLToPath(new URL(`./${outDir}/libraries`, import.meta.url)),
        { recursive: true },
      );
    },
  };
}

const outDir = 'dist-session';

export default defineConfig({
  ...createAppViteConfig({
    base: './',
    outDir,
    entries: ['session.html'],
    // No verbatim `public/` copy — the curated `libraries/` copy below ships
    // exactly the runtime assets the compile path fetches, nothing else.
    publicDir: false,
  }),
  plugins: [copySessionLibraries(outDir)],
});
