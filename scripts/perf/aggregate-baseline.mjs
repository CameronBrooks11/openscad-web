import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  let outputArg = 'coverage/perf/current-perf-baseline.json';
  const inputArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') {
      outputArg = argv[i + 1];
      i += 1;
      continue;
    }
    inputArgs.push(arg);
  }

  if (inputArgs.length === 0) {
    throw new Error('No perf run inputs provided. Pass one or more JSON files to aggregate.');
  }

  return {
    outputPath: path.resolve(repoRoot, outputArg),
    inputPaths: inputArgs.map((input) => path.resolve(repoRoot, input)),
  };
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateMetricSection(runs, key) {
  const metricNames = new Set();
  for (const run of runs) {
    for (const name of Object.keys(run[key] ?? {})) {
      metricNames.add(name);
    }
  }

  const result = {};
  for (const name of metricNames) {
    const values = runs.map((run) => run[key]?.[name]).filter(isNumber);
    result[name] = values.length > 0 ? round(median(values)) : null;
  }
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function main() {
  const { outputPath, inputPaths } = parseArgs(process.argv.slice(2));
  const runs = await Promise.all(inputPaths.map(readJson));

  const aggregate = {
    version: 1,
    capturedAt: new Date().toISOString(),
    environment: runs[0]?.environment ?? {
      mode: 'production',
      browser: 'chrome',
      profile: 'local-headless',
    },
    metrics: aggregateMetricSection(runs, 'metrics'),
    warmMetrics: aggregateMetricSection(runs, 'warmMetrics'),
    notes: {
      aggregation: 'median',
      sampleCount: runs.length,
      inputs: inputPaths.map((input) => path.relative(repoRoot, input)),
    },
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  console.log(`Wrote aggregated perf baseline candidate to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
