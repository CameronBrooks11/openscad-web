import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const forbiddenMarkers = [
  'Logging is enabled!',
  'Lit is in dev mode. Not recommended for production!',
];

function getAssetsDirPath() {
  const dirFlagIndex = process.argv.indexOf('--dir');
  const buildDirPath =
    dirFlagIndex === -1 ? path.resolve('dist') : path.resolve(process.argv[dirFlagIndex + 1] ?? '');

  if (dirFlagIndex !== -1 && !process.argv[dirFlagIndex + 1]) {
    throw new Error('Missing path after --dir');
  }

  return path.join(buildDirPath, 'assets');
}

async function listJavaScriptAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(directory, entry.name));
}

async function main() {
  const distAssetsDir = getAssetsDirPath();
  const assetFiles = await listJavaScriptAssets(distAssetsDir);
  if (assetFiles.length === 0) {
    throw new Error(`No JavaScript assets found under ${distAssetsDir}`);
  }

  for (const filePath of assetFiles) {
    const contents = await readFile(filePath, 'utf8');
    for (const marker of forbiddenMarkers) {
      if (contents.includes(marker)) {
        throw new Error(`Production bundle contains dev-only marker "${marker}" in ${filePath}`);
      }
    }
  }
}

await main();
