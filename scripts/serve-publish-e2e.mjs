#!/usr/bin/env node

import path from 'node:path';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishDirPath = path.join(repoRoot, 'dist-publish');
const fixtureRootDirPath = path.join(repoRoot, '.publish-e2e');
const serveBinPath = path.join(repoRoot, 'node_modules', 'serve', 'build', 'main.js');

function getFixtureMode() {
  const mode = process.env.E2E_SERVER_MODE;
  if (mode === 'publish-root' || mode === 'publish-subpath') {
    return mode;
  }

  throw new Error(`Unsupported E2E_SERVER_MODE for publish fixture server: ${mode ?? '<unset>'}`);
}

async function prepareFixtureRoot(mode) {
  const fixtureDirPath = path.join(fixtureRootDirPath, mode);
  await rm(fixtureDirPath, { recursive: true, force: true });
  await mkdir(fixtureDirPath, { recursive: true });

  const copyPublishContents = async (targetDirPath) => {
    await mkdir(targetDirPath, { recursive: true });
    const entryNames = await readdir(publishDirPath);
    await Promise.all(
      entryNames.map((entryName) =>
        cp(path.join(publishDirPath, entryName), path.join(targetDirPath, entryName), {
          recursive: true,
        }),
      ),
    );
  };

  if (mode === 'publish-root') {
    await copyPublishContents(fixtureDirPath);
    return fixtureDirPath;
  }

  const subpathRootDirPath = path.join(fixtureDirPath, 'openscad-web');
  await copyPublishContents(subpathRootDirPath);
  return fixtureDirPath;
}

async function main() {
  const mode = getFixtureMode();
  const fixtureServeDirPath = await prepareFixtureRoot(mode);

  console.log(`[serve-publish-e2e] Serving ${fixtureServeDirPath} for ${mode}`);

  const child = spawn(process.execPath, [serveBinPath, '-l', '3000', fixtureServeDirPath], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });

  child.on('error', (error) => {
    throw error;
  });
}

await main();
