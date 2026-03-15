import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const distAssetsDir = path.resolve('dist/assets');
const forbiddenMarkers = [
  'Logging is enabled!',
  'Lit is in dev mode. Not recommended for production!',
];

async function listJavaScriptAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(directory, entry.name));
}

async function main() {
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
