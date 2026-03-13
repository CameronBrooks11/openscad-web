import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  let sourceArg = null;
  let baselineArg = process.env.PERF_BASELINE ?? 'perf-baseline.json';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') {
      baselineArg = argv[i + 1];
      i += 1;
      continue;
    }
    if (!sourceArg) {
      sourceArg = arg;
    }
  }

  return {
    sourcePath: path.resolve(repoRoot, sourceArg ?? 'coverage/perf/current-perf-baseline.json'),
    baselinePath: path.resolve(repoRoot, baselineArg),
  };
}

function assertMetricSection(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid perf baseline payload: missing ${name} object.`);
  }
}

async function main() {
  const { sourcePath, baselinePath } = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  assertMetricSection('metrics', payload.metrics);
  assertMetricSection('warmMetrics', payload.warmMetrics);

  await fs.writeFile(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Accepted perf baseline from ${sourcePath} -> ${baselinePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
