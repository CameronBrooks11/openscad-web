import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const captureScript = path.resolve(__dirname, 'capture-baseline.mjs');
const aggregateScript = path.resolve(__dirname, 'aggregate-baseline.mjs');

function parseArgs(argv) {
  let runs = Number.parseInt(process.env.PERF_RUNS ?? '3', 10);
  let runsDirArg = 'coverage/perf/runs';
  let outputArg = 'coverage/perf/current-perf-baseline.json';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs') {
      runs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === '--runs-dir') {
      runsDirArg = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--output') {
      outputArg = argv[i + 1];
      i += 1;
    }
  }

  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`Invalid run count: ${runs}`);
  }

  return {
    runs,
    runsDir: path.resolve(repoRoot, runsDirArg),
    outputPath: path.resolve(repoRoot, outputArg),
  };
}

function runNodeScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: process.env,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.basename(scriptPath)} exited with code=${code ?? 'null'} signal=${
            signal ?? 'null'
          }`,
        ),
      );
    });
  });
}

async function main() {
  const { runs, runsDir, outputPath } = parseArgs(process.argv.slice(2));
  await fs.mkdir(runsDir, { recursive: true });

  const runPaths = [];
  for (let i = 1; i <= runs; i += 1) {
    const runPath = path.join(runsDir, `run-${i}.json`);
    runPaths.push(runPath);
    await runNodeScript(captureScript, ['--output', path.relative(repoRoot, runPath)]);
  }

  await runNodeScript(aggregateScript, [
    '--output',
    path.relative(repoRoot, outputPath),
    ...runPaths.map((runPath) => path.relative(repoRoot, runPath)),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
