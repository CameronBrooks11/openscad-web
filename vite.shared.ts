import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { UserConfig } from 'vite';

const htmlInput = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

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
  entries = ['index.html', 'viewer.html'],
  publicDir = 'public',
}: {
  base: string;
  outDir: string;
  /**
   * The HTML entry files to build. Defaults to the full app (`index.html`) + the
   * standalone viewer (`viewer.html`). The distributable viewer-only build
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
          // Split the two heavy vendor libraries into their own named chunks so
          // they can be budgeted separately and are only fetched by the surfaces
          // that dynamically import them (editor → monaco, viewer → three).
          // rolldown-vite requires manualChunks as a function.
          manualChunks: (id: string) => {
            // Trailing slash so these match only the package itself, not a
            // future `three-*` / `monaco-*`-prefixed dependency.
            if (id.includes('node_modules/monaco-editor/')) return 'monaco';
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
