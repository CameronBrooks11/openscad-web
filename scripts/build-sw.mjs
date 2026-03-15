#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import workboxBuild from 'workbox-build';

const { generateSW } = workboxBuild;

const distDir = path.resolve('dist');
const swDest = path.join(distDir, 'sw.js');
const obsoleteArtifacts = ['openscad.js', 'openscad.wasm'];

async function removeObsoleteArtifacts() {
  for (const artifact of obsoleteArtifacts) {
    try {
      await fs.rm(path.join(distDir, artifact), { force: true });
    } catch {
      /* ignore */
    }
  }
}

try {
  await removeObsoleteArtifacts();

  const result = await generateSW({
    mode: 'production',
    globDirectory: distDir,
    globPatterns: ['**/*'],
    swDest,
    globIgnores: ['**/.*', '**/*.map', 'manifest*.js'],
    maximumFileSizeToCacheInBytes: 200 * 1024 * 1024,
    clientsClaim: true,
    skipWaiting: true,
    // Preserve the established runtime-caching rule order to avoid behavior drift.
    runtimeCaching: [
      {
        urlPattern: ({ url }) => url.origin === self.location.origin,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'same-origin-assets',
          expiration: { maxEntries: 200, purgeOnQuotaError: true },
        },
      },
      {
        urlPattern: ({ url }) =>
          url.pathname.endsWith('.wasm') || url.pathname.includes('/libraries/'),
        handler: 'CacheFirst',
        options: {
          cacheName: 'large-assets',
          expiration: { maxEntries: 50, purgeOnQuotaError: true },
        },
      },
    ],
  });

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[build-sw] ${warning}`);
    }
  }
  console.log(
    `[build-sw] Generated ${swDest} with ${result.count} precached entries (${result.size} bytes).`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
