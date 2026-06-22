#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import workboxBuild from 'workbox-build';

const { generateSW } = workboxBuild;

const distDir = path.resolve('dist');
const swDest = path.join(distDir, 'sw.js');
const obsoleteArtifacts = ['openscad.js', 'openscad.wasm', 'fonts/InterVariable.woff2'];

async function removeObsoleteArtifacts() {
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

try {
  await removeObsoleteArtifacts();

  const result = await generateSW({
    mode: 'production',
    globDirectory: distDir,
    // Precache EVERYTHING in dist, including the ~9.6 MB WASM binary and the
    // library zips under libraries/. This is deliberate, despite the apparent
    // size: Workbox keys every precache entry by url + content-revision in one
    // shared cache, so a new service-worker version (from any deploy) reuses the
    // unchanged entries via cacheMatch with NO network and re-fetches ONLY the
    // entries whose content actually changed — there is no "re-download the whole
    // bundle on every deploy" behaviour. The payoff: the app (compile + bundled
    // libraries) is fully offline-ready after the FIRST visit, warm loads serve
    // these large assets from cache instead of refetching, and the unhashed
    // library zips get correct content-revisioned invalidation when they change.
    // (Excluding them in favour of a lazy runtime CacheFirst route was tried and
    // reverted: it regressed warm-load bootstrap and left stale library zips
    // served forever, in exchange for a per-deploy cost that does not exist.
    // See PR #113.) The high maximumFileSizeToCacheInBytes below exists so the
    // WASM binary clears Workbox's default 2 MB precache size limit.
    globPatterns: ['**/*'],
    swDest,
    globIgnores: ['**/.*', '**/*.map', 'manifest*.js'],
    maximumFileSizeToCacheInBytes: 200 * 1024 * 1024,
    // A new worker WAITS instead of taking over the open page: skipWaiting/
    // clientsClaim would swap the controller mid-session (risking 404s on hashed
    // chunks removed by the new deploy). The app surfaces an "update available"
    // signal instead, and the new worker activates on the next load. See #53.
    clientsClaim: false,
    skipWaiting: false,
    // Runtime caching only applies to requests NOT served by the precache above
    // (which already covers the WASM binary and library zips). These rules are a
    // fallback for any same-origin request that misses the precache.
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
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
