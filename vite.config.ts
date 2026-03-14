import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

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

function normalizeBasePath(rawBasePath: string): string {
  if (/^[a-z]+:\/\//i.test(rawBasePath)) {
    const url = new URL(rawBasePath);
    return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
  }

  const trimmed = rawBasePath.trim();
  if (trimmed === '' || trimmed === '.') {
    return '/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export default defineConfig(({ command, mode }) => {
  const base =
    command === 'serve'
      ? '/'
      : normalizeBasePath(process.env.PUBLIC_URL ?? getPackageHomepagePath());

  return {
    base,
    publicDir: 'public',
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    },
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
    preview: {
      host: '127.0.0.1',
      port: 3000,
      strictPort: true,
    },
    worker: {
      format: 'iife',
    },
  };
});
