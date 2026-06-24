#!/usr/bin/env node

// Real-WASM-boot acceptance check for the dist-session distributable (#193).
// Builds the relative-base session bundle, then runs the session spec against it
// under a static `serve` of dist-session. Unlike the headless project-contract
// unit test (which uses a FakeBackend), this boots the actual OpenSCAD WASM in a
// real browser worker and asserts a genuine OFF artifact comes back — proving the
// vendored bundle compiles. Mirrors run-publish-e2e.mjs.

import { spawn } from 'node:child_process';

function resolveCommand(baseName) {
  return process.platform === 'win32' ? `${baseName}.cmd` : baseName;
}

function runCommand(command, args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`));
    });

    child.on('error', reject);
  });
}

async function main() {
  if (process.env.E2E_SESSION_SKIP_BUILD !== 'true') {
    await runCommand(resolveCommand('npm'), ['run', 'build:session']);
  }

  // Filter to the session spec: dist-session has no viewer.html/index.html, so the
  // other specs (which load those) would fail under this server mode.
  await runCommand(resolveCommand('npx'), ['playwright', 'test', 'session.spec.ts'], {
    E2E_SERVER_MODE: 'session',
  });
}

await main();
