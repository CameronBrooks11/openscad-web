import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Plugin, UserConfig } from 'vite';

// @ts-expect-error -- plain .mjs build script, no type declarations.
import { syncMonacoAssets } from './scripts/sync-monaco-assets.mjs';

const htmlInput = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/**
 * Populate `public/monaco/vs` before the build reads `public/`.
 *
 * Monaco is loaded at runtime by @monaco-editor/loader from our own origin
 * rather than a CDN (#267), so the AMD build has to be part of the artifact.
 * Only surfaces that copy `public/` get it — the viewer and session builds pass
 * `publicDir: false` and must never reach Monaco at all.
 */
function syncMonacoAssetsPlugin(): Plugin {
  return {
    name: 'sync-monaco-assets',
    buildStart() {
      syncMonacoAssets({
        destDir: fileURLToPath(new URL('./public/monaco/vs', import.meta.url)),
        log: (message: string) => this.info(message),
      });
    },
  };
}

type PackageJsonShape = {
  homepage?: string;
};

export function getPackageHomepagePath(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
  ) as PackageJsonShape;

  if (!packageJson.homepage) {
    return '/';
  }

  return new URL(packageJson.homepage).pathname;
}

export function createAppViteConfig({
  base,
  outDir,
  entries = ['index.html', 'viewer.html', 'static.html'],
  publicDir = 'public',
}: {
  base: string;
  outDir: string;
  /**
   * The HTML entry files to build. Defaults to the full app (`index.html`), the
   * postMessage-driven standalone viewer (`viewer.html`), and the self-loading
   * static geometry viewer (`static.html`). The distributable viewer-only build
   * (`vite.viewer.config.ts`) passes just `['viewer.html']`. Each entry's chunk is
   * keyed by its base name, so `index.html` keeps the `index-*` chunk name the
   * bundle budgets / tooling rely on.
   */
  entries?: string[];
  /**
   * The static-assets dir copied verbatim into the build. Defaults to `public`
   * (favicon, the OpenSCAD `libraries/` zips, fonts, …). The distributable viewer
   * passes `false`: the standalone viewer fetches none of those at runtime, so the
   * artifact stays small (just `viewer.html` + its chunks).
   */
  publicDir?: string | false;
}): UserConfig {
  const input = Object.fromEntries(
    entries.map((name) => [name.replace(/\.html$/, ''), htmlInput(name)]),
  );
  return {
    base,
    publicDir,
    // Only the surfaces that ship `public/` carry the editor; the viewer and
    // session builds opt out of both in one move.
    plugins: publicDir === false ? [] : [syncMonacoAssetsPlugin()],
    optimizeDeps: {
      entries,
    },
    build: {
      outDir,
      target: 'es2022',
      emptyOutDir: true,
      rollupOptions: {
        // The HTML entries (see `entries` above). The viewer entry pulls in only
        // Lit + Three + the OFF viewer — no Monaco, BrowserFS, OpenSCAD WASM,
        // Model, or service worker (asserted by scripts/verify-viewer-bundle.mjs).
        input,
        output: {
          // Split the heavy vendor library into its own named chunk so it can be
          // budgeted separately and is only fetched by the surface that
          // dynamically imports it (viewer → three).
          // rolldown-vite requires manualChunks as a function.
          //
          // Monaco is deliberately absent: it is no longer part of the module
          // graph at all. `src/` imports it for types only, and the editor is
          // fetched at runtime from the AMD build in `public/monaco/vs`
          // (#254, #267).
          manualChunks: (id: string) => {
            // Trailing slash so this matches only the package itself, not a
            // future `three-*`-prefixed dependency.
            if (id.includes('node_modules/three/')) return 'three';
            return undefined;
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 4000,
      strictPort: true,
    },
    worker: {
      format: 'iife',
    },
  };
}
