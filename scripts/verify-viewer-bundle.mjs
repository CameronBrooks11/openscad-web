// Acceptance gate for the viewer-only entry (ADR 0005 / #126): the standalone
// geometry viewer must not pull in the editor/compiler stack. Starting from
// viewer.html's module entry, crawl the transitive chunk graph and assert none
// of the reachable chunks reaches Monaco, BrowserFS, the OpenSCAD WASM, or a
// service-worker registration.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function distRoot() {
  return path.resolve(argValue('--dir', 'dist'));
}

// Which HTML entry to gate: the postMessage viewer (`viewer.html`, default) or
// the self-loading static geometry viewer (`static.html`). Both must stay free
// of the editor/compiler stack.
const entryHtmlName = argValue('--entry', 'viewer.html');

function basename(p) {
  return p.split('/').pop();
}

function fail(message) {
  console.error(`[verify-viewer-bundle] ${message}`);
  process.exit(1);
}

const dist = distRoot();
const assetsDir = path.join(dist, 'assets');

const entryHtml = await readFile(path.join(dist, entryHtmlName), 'utf8').catch(() => {
  fail(`${entryHtmlName} not found under ${dist}`);
});
const entryMatch = entryHtml.match(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
if (!entryMatch) fail(`${entryHtmlName} has no module entry script`);
const entryFile = basename(entryMatch[1]);

// BFS the reachable chunk graph. The reference regex captures any quoted `*.js`
// basename — static `import`/`from`, dynamic `import(...)`, and vite preload dep
// lists — which over-approximates reachability (safe for a must-not-reach gate).
// Assumes vite's default hashed chunk names (`name-hash.js`, no `?query` suffix
// and no internal dots); if that naming changes this regex must be revisited.
const referenceRe = /["'`](?:[^"'`]*\/)?([\w-]+\.js)["'`]/g;
const reachable = new Set();
const queue = [entryFile];
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
  for (const m of content.matchAll(referenceRe)) {
    if (!reachable.has(m[1])) queue.push(m[1]);
  }
}

// Monaco is its own named chunk; reaching it is the cleanest signal.
const monaco = [...reachable].filter((f) => f.startsWith('monaco-'));
if (monaco.length) fail(`viewer bundle reaches Monaco chunk(s): ${monaco.join(', ')}`);

// Content markers that survive minification (Web API property names / asset
// extensions) for the other forbidden subsystems.
const forbidden = [
  { marker: 'BFSRequire', what: 'BrowserFS' },
  { marker: 'serviceWorker', what: 'a service worker' },
  { marker: '.wasm', what: 'the OpenSCAD WASM' },
];
for (const file of reachable) {
  let content;
  try {
    content = await readFile(path.join(assetsDir, file), 'utf8');
  } catch {
    continue;
  }
  for (const { marker, what } of forbidden) {
    if (content.includes(marker)) {
      fail(`viewer chunk ${file} references ${what} ("${marker}")`);
    }
  }
}

console.log(
  `[verify-viewer-bundle] OK — ${reachable.size} reachable chunks; no Monaco/BrowserFS/WASM/service-worker.`,
);
