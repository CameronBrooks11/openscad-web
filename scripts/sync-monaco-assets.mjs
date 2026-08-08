#!/usr/bin/env node
// Copy the Monaco AMD build into `public/monaco/vs`, pruned to what this app
// actually loads.
//
// We serve Monaco ourselves rather than from @monaco-editor/loader's default
// jsDelivr CDN (#267). `public/` is copied verbatim into the app and publish
// builds and skipped by the viewer/session builds (publicDir: false), which
// must not reach Monaco at all — so this lands in exactly the right artifacts.
//
// Pruning matters because the service worker precaches everything in dist
// (scripts/build-sw.mjs), so anything shipped here is downloaded on first
// visit. The full `min/vs` is ~23 MB, most of it language-service workers for
// TypeScript, CSS, HTML and JSON — which 0.56 ships in triplicate — plus
// translated UI strings. This app registers exactly one language (OpenSCAD,
// via Monarch) and never creates a model in any of those, so their workers are
// never spawned.
//
// Exclusions are matched by PATTERN, not by exact filename, because these
// assets are content-hashed and the hashes change on every Monaco release.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The heavy language-service worker bundles, for languages this app never
 * registers. `editor.worker` is deliberately not in this set — the core editor
 * needs it.
 *
 * These are pruned only under `assets/`. 0.56 also ships a ~200-byte AMD stub
 * for each at the root (`ts.worker-<hash>.js` and friends) whose whole job is
 * to resolve the `assets/` URL. Those stubs are loaded EAGERLY when the editor
 * boots, so dropping them 404s and the editor never initializes — pruning them
 * is what broke the first attempt at this upgrade. They are kept; the multi-MB
 * bundles they point at stay lazy and are never fetched.
 */
const EXCLUDED_WORKER = /^(ts|css|html|json)\.worker(-[^.]+)?\.js$/;

/**
 * Whole directories with nothing we use.
 *
 * `language/` holds the per-language mode entry points for TypeScript, CSS,
 * HTML and JSON, including a second ~6.4 MB copy of ts.worker. `nls/` holds the
 * translated UI strings for thirteen locales; the English strings are baked
 * into the editor bundle and we never call `loader.config({ 'vs/nls': ... })`.
 */
const EXCLUDED_DIRS = ['language', 'nls'];

/**
 * Files that must survive the prune. If Monaco reorganizes and one of these
 * stops matching, fail the build rather than ship a broken editor. This is not
 * theoretical: 0.56 moved the NLS bundles into `nls/` and this list caught it.
 */
const REQUIRED = [
  { label: 'AMD loader', test: (rel) => rel === 'loader.js' },
  { label: 'editor stylesheet', test: (rel) => rel === 'editor/editor.main.css' },
  { label: 'editor entry', test: (rel) => rel === 'editor/editor.main.js' },
  {
    label: 'core editor worker',
    test: (rel) => /(^|\/)editor\.worker(-[^.]+)?\.js$/.test(rel),
  },
];

/** True when `relPath` (posix, relative to `min/vs`) should be pruned. */
export function isExcluded(relPath) {
  const dir = path.posix.dirname(relPath);
  if (EXCLUDED_DIRS.includes(dir.split('/')[0])) return true;
  return dir === 'assets' && EXCLUDED_WORKER.test(path.posix.basename(relPath));
}

/** All files under `dir`, as posix paths relative to it. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

function resolveMonacoVsDir() {
  const require = createRequire(import.meta.url);
  // `./package.json` is not an exported subpath in monaco 0.56, and the bare
  // entry moved between releases, so locate the package root from whatever the
  // main entry resolves to rather than assuming a layout.
  const entry = require.resolve('monaco-editor');
  const root = entry.slice(0, entry.lastIndexOf('monaco-editor') + 'monaco-editor'.length);
  return path.join(root, 'min', 'vs');
}

export function syncMonacoAssets({ destDir, log = console.log } = {}) {
  const srcDir = resolveMonacoVsDir();
  if (!existsSync(srcDir)) {
    throw new Error(`Monaco AMD build not found at ${srcDir}. Is monaco-editor installed?`);
  }

  const files = listFiles(srcDir);
  const kept = files.filter((f) => !isExcluded(f));
  const dropped = files.filter(isExcluded);

  for (const { label, test } of REQUIRED) {
    if (!kept.some((f) => test(f))) {
      throw new Error(
        `Monaco sync would drop the ${label}. The upstream layout changed — ` +
          `review scripts/sync-monaco-assets.mjs against monaco-editor's min/vs.`,
      );
    }
  }

  rmSync(destDir, { recursive: true, force: true });
  for (const rel of kept) {
    const to = path.join(destDir, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(srcDir, rel), to);
  }

  const bytes = (list) =>
    list.reduce((sum, f) => sum + statSync(path.join(srcDir, f)).size, 0) / 1024 / 1024;
  log(
    `monaco assets: kept ${kept.length} files (${bytes(kept).toFixed(1)} MB), ` +
      `pruned ${dropped.length} (${bytes(dropped).toFixed(1)} MB)`,
  );

  return { kept, dropped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncMonacoAssets({ destDir: path.resolve('public/monaco/vs') });
}
