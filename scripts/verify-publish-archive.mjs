#!/usr/bin/env node

import AdmZip from 'adm-zip';
import path from 'node:path';

function getArchivePath() {
  const zipFlagIndex = process.argv.indexOf('--zip');
  if (zipFlagIndex === -1) {
    return path.resolve('openscad-web-publish.zip');
  }

  const zipArg = process.argv[zipFlagIndex + 1];
  if (!zipArg) {
    throw new Error('Missing path after --zip');
  }

  return path.resolve(zipArg);
}

function assertArchiveHas(entries, entryPath) {
  if (!entries.has(entryPath)) {
    throw new Error(`Publish archive is missing required entry: ${entryPath}`);
  }
}

function assertArchiveHasPrefix(entryNames, prefix) {
  if (!entryNames.some((entryName) => entryName.startsWith(prefix))) {
    throw new Error(`Publish archive is missing required subtree: ${prefix}`);
  }
}

async function main() {
  const archivePath = getArchivePath();
  const archive = new AdmZip(archivePath);
  const entryNames = archive
    .getEntries()
    .map((entry) => entry.entryName)
    .filter(Boolean);
  const entrySet = new Set(entryNames);

  assertArchiveHas(entrySet, 'index.html');
  assertArchiveHasPrefix(entryNames, 'assets/');
  assertArchiveHasPrefix(entryNames, 'libraries/');

  if (entrySet.has('sw.js')) {
    throw new Error('Publish archive must not include sw.js.');
  }

  console.log(`[verify-publish-archive] Verified ${archivePath}`);
}

await main();
