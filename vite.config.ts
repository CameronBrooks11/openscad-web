import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import { normalizeBasePath } from './src/runtime/base-path.ts';

type PackageJsonShape = {
  homepage?: string;
};

function getPackageHomepagePath(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
  ) as PackageJsonShape;

  if (!packageJson.homepage) {
    return '/';
  }

  return new URL(packageJson.homepage).pathname;
}

export default defineConfig(({ command }) => {
  const base =
    command === 'serve'
      ? '/'
      : normalizeBasePath(process.env.PUBLIC_URL ?? getPackageHomepagePath());

  return {
    base,
    publicDir: 'public',
    optimizeDeps: {
      entries: ['index.html'],
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
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
});
