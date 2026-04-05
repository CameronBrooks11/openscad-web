#!/usr/bin/env node

import { spawn } from 'node:child_process';

function resolveCommand(baseName) {
  return process.platform === 'win32' ? `${baseName}.cmd` : baseName;
}

function runCommand(command, args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
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
  const playwrightArgs = ['playwright', 'test', ...process.argv.slice(2)];

  if (process.env.E2E_PUBLISH_SKIP_BUILD !== 'true') {
    await runCommand(resolveCommand('npm'), ['run', 'build:publish']);
  }

  await runCommand(resolveCommand('npx'), playwrightArgs, { E2E_SERVER_MODE: 'publish-root' });
  await runCommand(resolveCommand('npx'), playwrightArgs, { E2E_SERVER_MODE: 'publish-subpath' });
}

await main();
