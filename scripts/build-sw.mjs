#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import workboxBuild from 'workbox-build';

const { generateSW } = workboxBuild;

const obsoleteArtifacts = ['openscad.js', 'openscad.wasm', 'fonts/InterVariable.woff2'];

/**
 * Build the Workbox `generateSW` config. Pure (no I/O) so it can be asserted in
 * tests — the precache excludes and runtime-route order are correctness-critical.
 */
export function buildWorkboxConfig({ distDir, swDest }) {
  return {
    mode: 'production',
    globDirectory: distDir,
    globPatterns: ['**/*'],
    swDest,
    // The WASM binary (~9.6 MB) and the library zips (~tens of MB total) are
    // deliberately kept OUT of the precache: precaching them would force the
    // whole bundle to re-download atomically on every deploy (a new precache
    // revision invalidates the lot), even when only an app chunk changed. They
    // are instead fetched lazily and persisted by the CacheFirst runtime rule
    // below, so they survive deploys and only download when first needed.
    globIgnores: ['**/.*', '**/*.map', 'manifest*.js', '**/*.wasm', 'libraries/**'],
    maximumFileSizeToCacheInBytes: 200 * 1024 * 1024,
    // A new worker WAITS instead of taking over the open page: skipWaiting/
    // clientsClaim would swap the controller mid-session (risking 404s on hashed
    // chunks removed by the new deploy). The app surfaces an "update available"
    // signal instead, and the new worker activates on the next load. See #53.
    clientsClaim: false,
    skipWaiting: false,
    // Order matters: Workbox uses the FIRST matching route. The CacheFirst rule
    // for the large WASM/library assets must come before the broad same-origin
    // StaleWhileRevalidate, or the latter would swallow every same-origin request
    // and the large assets would be re-validated (re-fetched) on every load.
    runtimeCaching: [
      {
        urlPattern: ({ url }) =>
          url.pathname.endsWith('.wasm') || url.pathname.includes('/libraries/'),
        handler: 'CacheFirst',
        options: {
          cacheName: 'large-assets',
          expiration: { maxEntries: 50, purgeOnQuotaError: true },
        },
      },
      {
        urlPattern: ({ url }) => url.origin === self.location.origin,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'same-origin-assets',
          expiration: { maxEntries: 200, purgeOnQuotaError: true },
        },
      },
    ],
  };
}

async function removeObsoleteArtifacts(distDir) {
  for (const artifact of obsoleteArtifacts) {
    try {
      await fs.rm(path.join(distDir, artifact), { force: true });
    } catch {
      /* ignore */
    }
  }

  try {
    await fs.rmdir(path.join(distDir, 'fonts'));
  } catch {
    /* ignore */
  }
}

export async function runBuildSW({ distDir = path.resolve('dist') } = {}) {
  const swDest = path.join(distDir, 'sw.js');
  await removeObsoleteArtifacts(distDir);

  const result = await generateSW(buildWorkboxConfig({ distDir, swDest }));

  // generateSW already emits a `SKIP_WAITING` message listener in the worker,
  // so the app can let the user apply a waiting update on demand (see
  // applyServiceWorkerUpdate / osc-update-banner, #78) even though
  // skipWaiting:false keeps it from auto-activating. The update banner depends
  // on that handler — fail the build if a Workbox change ever drops it.
  const swContents = await fs.readFile(swDest, 'utf8');
  if (!swContents.includes('SKIP_WAITING')) {
    throw new Error(
      '[build-sw] generated sw.js has no SKIP_WAITING handler; the update-on-reload flow (#78) would break.',
    );
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`[build-sw] ${warning}`);
    }
  }
  console.log(
    `[build-sw] Generated ${swDest} with ${result.count} precached entries (${result.size} bytes).`,
  );
  return result;
}

const isEntrypoint =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    await runBuildSW();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
