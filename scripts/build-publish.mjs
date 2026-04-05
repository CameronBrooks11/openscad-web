#!/usr/bin/env node

import AdmZip from 'adm-zip';
import path from 'node:path';
import { access, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBinPath = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const verifyBuildScriptPath = path.join(repoRoot, 'scripts', 'verify-production-build.mjs');
const verifyArchiveScriptPath = path.join(repoRoot, 'scripts', 'verify-publish-archive.mjs');
const publishConfigPath = path.join(repoRoot, 'vite.publish.config.ts');
const publishDirPath = path.join(repoRoot, 'dist-publish');
const publishArchivePath = path.join(repoRoot, 'openscad-web-publish.zip');

function runNodeCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed with exit code ${code}: ${args.join(' ')}`));
    });

    child.on('error', reject);
  });
}

async function writePublishArchive() {
  await rm(publishArchivePath, { force: true });

  const archive = new AdmZip();
  archive.addLocalFolder(publishDirPath);
  archive.writeZip(publishArchivePath);

  console.log(`[build-publish] Wrote ${publishArchivePath}`);
}

async function assertPublishDirHasNoServiceWorker() {
  try {
    await access(path.join(publishDirPath, 'sw.js'));
  } catch {
    return;
  }

  throw new Error('dist-publish must not include sw.js.');
}

async function main() {
  await runNodeCommand([viteBinPath, 'build', '--config', publishConfigPath]);
  await runNodeCommand([verifyBuildScriptPath, '--dir', publishDirPath]);
  await assertPublishDirHasNoServiceWorker();
  await writePublishArchive();
  await runNodeCommand([verifyArchiveScriptPath, '--zip', publishArchivePath]);
}

await main();
