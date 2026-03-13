import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const sourceArg = process.argv[2];
const sourcePath = path.resolve(repoRoot, sourceArg ?? 'coverage/perf/current-perf-baseline.json');
const baselinePath = path.resolve(repoRoot, process.env.PERF_BASELINE ?? 'perf-baseline.json');

function assertMetricSection(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid perf baseline payload: missing ${name} object.`);
  }
}

async function main() {
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
