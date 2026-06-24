// Inverse acceptance gate for the compile-capable session bundle (#194, part of
// #179). The READ-ONLY viewer gate (verify-viewer-bundle.mjs) fails if the bundle
// reaches BrowserFS / WASM / a service worker — the opposite of what a compiler
// needs. A session bundle MUST carry the OpenSCAD WASM + worker + BrowserFS, and
// MUST NOT leak the editor shell (Monaco) or register a service worker. Crawl
// session.html's transitive chunk graph and assert both directions.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function distRoot() {
  const i = process.argv.indexOf('--dir');
  return path.resolve(i === -1 ? 'dist-session' : (process.argv[i + 1] ?? 'dist-session'));
}

function basename(p) {
  return p.split('/').pop();
}

function fail(message) {
  console.error(`[verify-session-bundle] ${message}`);
  process.exit(1);
}

const dist = distRoot();
const assetsDir = path.join(dist, 'assets');

const sessionHtml = await readFile(path.join(dist, 'session.html'), 'utf8').catch(() => {
  fail(`session.html not found under ${dist}`);
});
const entryMatch = sessionHtml.match(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
if (!entryMatch) fail('session.html has no module entry script');
const entryFile = basename(entryMatch[1]);

// BFS the reachable chunk graph (same reference regex as the viewer gate: any
// quoted `*.js` basename — static/dynamic import + vite preload lists — which
// over-approximates reachability, safe for both the must-reach and must-not-reach
// assertions below). Accumulate the concatenated reachable source for marker scans.
const referenceRe = /["'`](?:[^"'`]*\/)?([\w-]+\.js)["'`]/g;
const reachable = new Set();
const queue = [entryFile];
let reachableSource = '';
while (queue.length) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  reachable.add(file);
  let content;
  try {
    content = await readFile(path.join(assetsDir, file), 'utf8');
  } catch {
    continue; // not an emitted assets chunk
  }
  reachableSource += content;
  for (const m of content.matchAll(referenceRe)) {
    if (!reachable.has(m[1])) queue.push(m[1]);
  }
}

// --- Must NOT leak the editor shell or a service worker ---
const monaco = [...reachable].filter((f) => f.startsWith('monaco-'));
if (monaco.length) fail(`session bundle reaches Monaco chunk(s): ${monaco.join(', ')}`);

const forbidden = [
  { marker: 'serviceWorker', what: 'a service worker registration' },
  { marker: 'osc-editor-panel', what: 'the editor panel (app-shell leak)' },
  { marker: 'osc-app-shell', what: 'the app shell (app-shell leak)' },
];
for (const { marker, what } of forbidden) {
  if (reachableSource.includes(marker)) {
    fail(`session bundle references ${what} ("${marker}")`);
  }
}

// --- Must carry the compiler: WASM + worker + BrowserFS ---
const assets = await readdir(assetsDir).catch(() => fail(`no assets/ under ${dist}`));
if (!assets.some((f) => f.endsWith('.wasm'))) fail('no OpenSCAD WASM (*.wasm) in assets/');
if (!assets.some((f) => /worker.*\.js$/.test(f)))
  fail('no compile worker (*worker*.js) in assets/');
if (!reachableSource.includes('BFSRequire'))
  fail('reachable graph does not wire in BrowserFS ("BFSRequire")');
if (!reachableSource.includes('.wasm'))
  fail('reachable graph does not reference the OpenSCAD WASM (".wasm")');

// The runtime library assets the compile path fetches must ship (fonts.zip is
// always loaded; the rest are mounted on demand).
const libs = await readdir(path.join(dist, 'libraries')).catch(() => []);
if (!libs.includes('fonts.zip'))
  fail('libraries/fonts.zip missing — the curated zips did not ship');

console.log(
  `[verify-session-bundle] OK — ${reachable.size} reachable chunks; WASM + worker + BrowserFS present, ` +
    `no Monaco/service-worker/app-shell leak.`,
);
