#!/usr/bin/env node

import path from 'node:path';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishDirPath = path.join(repoRoot, 'dist-publish');
const publishArchivePath = path.join(repoRoot, 'openscad-web-publish.zip');
const deployConfigureScriptPath = path.join(repoRoot, 'scripts', 'deploy-configure.mjs');
const fixtureRootDirPath = path.join(repoRoot, '.publish-e2e');
const serveBinPath = path.join(repoRoot, 'node_modules', 'serve', 'build', 'main.js');

// A valid single-line-header OFF (a tetrahedron) for the static target.
const FIXTURE_OFF = [
  'OFF 4 4 0',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '0 0 1',
  '3 0 1 2',
  '3 0 1 3',
  '3 0 2 3',
  '3 1 2 3',
  '',
].join('\n');

function getFixtureMode() {
  const mode = process.env.E2E_SERVER_MODE;
  if (mode === 'publish-root' || mode === 'publish-subpath' || mode === 'publish-assembled') {
    return mode;
  }

  throw new Error(`Unsupported E2E_SERVER_MODE for publish fixture server: ${mode ?? '<unset>'}`);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`node ${args.join(' ')} failed (${code})`)),
    );
    child.on('error', reject);
  });
}

// Assemble a real multi-target site with deploy-configure: two compile surfaces
// (which share one runtime) plus a static surface. Exercises the shared-runtime
// thin mounts (#240) and the self-contained static mount (#241) in a browser.
async function prepareAssembledFixture() {
  const fixtureDirPath = path.join(fixtureRootDirPath, 'publish-assembled');
  await rm(fixtureDirPath, { recursive: true, force: true });

  const inputDirPath = path.join(fixtureDirPath, 'input');
  const serveDirPath = path.join(fixtureDirPath, 'site');
  await mkdir(inputDirPath, { recursive: true });

  await writeFile(path.join(inputDirPath, 'model.scad'), 'cube(10);\n');
  await writeFile(path.join(inputDirPath, 'model.off'), FIXTURE_OFF);
  await writeFile(
    path.join(inputDirPath, 'openscad-publish.yml'),
    `site:
  outDir: ${serveDirPath}
targets:
  - source: ./model.scad
    surface: viewer
    mountPath: /viewer/
  - source: ./model.scad
    surface: customizer
    mountPath: /customizer/
  - surface: static
    geometry: ./model.off
    mountPath: /static/
`,
  );

  await runNode([
    deployConfigureScriptPath,
    '--config',
    path.join(inputDirPath, 'openscad-publish.yml'),
    '--artifact-path',
    publishArchivePath,
  ]);

  return serveDirPath;
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
  const fixtureServeDirPath =
    mode === 'publish-assembled' ? await prepareAssembledFixture() : await prepareFixtureRoot(mode);

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
