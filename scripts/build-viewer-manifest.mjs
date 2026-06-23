// Emit dist-viewer/viewer-manifest.json (#143/#175): a versioned, hashed
// integrity manifest for the distributable viewer artifact, so the consuming VS
// Code extension can pin and verify exactly what it vendors. The extension, on
// ingest, asserts: protocolVersion matches what it compiled against, every shipped
// file is on the allowlist, and every sha256 recomputes.

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist-viewer');
const MANIFEST_NAME = 'viewer-manifest.json';

function fail(message) {
  console.error(`[build-viewer-manifest] ${message}`);
  process.exit(1);
}

// The single source of truth for the protocol version — read, never hand-copied,
// so the manifest and the runtime `validateViewerInbound` guard cannot disagree.
function protocolVersion() {
  const src = readFileSync('src/protocol/viewer-transport.ts', 'utf8');
  const m = src.match(/VIEWER_PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!m) fail('could not read VIEWER_PROTOCOL_VERSION from src/protocol/viewer-transport.ts');
  return Number(m[1]);
}

function viewerVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

function sourceCommit() {
  try {
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    // A build from a dirty tree doesn't correspond to `commit`; mark it so the
    // manifest's provenance is honest (CI builds from a clean checkout).
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return 'unknown';
  }
}

// Every file under dist-viewer relative to it, excluding the manifest itself.
function listFiles(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, relPath));
    else if (relPath !== MANIFEST_NAME) out.push(relPath);
  }
  return out;
}

const sha256 = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

const relFiles = listFiles(DIST).sort();
if (!relFiles.includes('viewer.html'))
  fail('dist-viewer/viewer.html missing — run build:viewer first');

const files = {};
for (const rel of relFiles) {
  const abs = path.join(DIST, rel);
  files[rel] = { bytes: statSync(abs).size, sha256: sha256(abs) };
}

// Top-level entries the extension should expect (dirs with a trailing slash).
const topLevel = [
  ...new Set(relFiles.map((f) => (f.includes('/') ? `${f.split('/')[0]}/` : f))),
].sort();
const allowlist = [...topLevel, MANIFEST_NAME];

const manifest = {
  schemaVersion: 1,
  viewerVersion: viewerVersion(),
  protocolVersion: protocolVersion(),
  sourceCommit: sourceCommit(),
  builtAt: new Date().toISOString(),
  files,
  allowlist,
};

writeFileSync(path.join(DIST, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[build-viewer-manifest] wrote dist-viewer/${MANIFEST_NAME} ` +
    `(${relFiles.length} files, viewer v${manifest.viewerVersion}, protocol v${manifest.protocolVersion})`,
);
