import { readFileSync } from 'node:fs';

import type { UserConfig } from 'vite';

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
      entries: ['index.html'],
    },
    build: {
      outDir,
      target: 'es2022',
      emptyOutDir: true,
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
