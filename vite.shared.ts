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
}: {
  base: string;
  outDir: string;
}): UserConfig {
  return {
    base,
    publicDir: 'public',
    optimizeDeps: {
      entries: ['index.html', 'viewer.html'],
    },
    build: {
      outDir,
      target: 'es2022',
      emptyOutDir: true,
      rollupOptions: {
        // Two HTML entries: the full app (index.html) and a standalone, read-only
        // geometry viewer (viewer.html) for host/webview embedding. The viewer
        // entry pulls in only Lit + Three + the OFF viewer — no Monaco, BrowserFS,
        // OpenSCAD WASM, Model, or service worker (asserted by
        // scripts/verify-viewer-bundle.mjs).
        // The `index` key keeps the app entry chunk named `index-*` (the bundle
        // budgets and the existing tooling key off that).
        input: {
          index: htmlInput('index.html'),
          viewer: htmlInput('viewer.html'),
        },
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
