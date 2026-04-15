import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  let baselineArg = process.env.PERF_BASELINE ?? 'perf-baseline.json';
  let currentArg = process.env.PERF_OUTPUT ?? 'coverage/perf/current-perf-baseline.json';
  let strict = process.env.CI === 'true' || process.env.PERF_STRICT === 'true';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') {
      baselineArg = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--current') {
      currentArg = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
  }

  return {
    baselinePath: path.resolve(repoRoot, baselineArg),
    currentPath: path.resolve(repoRoot, currentArg),
    strict,
  };
}

const budgetPct = Number.parseFloat(process.env.PERF_BUDGET_PCT ?? '20');
const budgetMultiplier = 1 + budgetPct / 100;
const minimumBudgetMs = Number.parseFloat(process.env.PERF_MIN_BUDGET_MS ?? '5');
const gatedMetricKeys = new Set([
  // firstContentfulPaintMillis is excluded from gating: in CI headless mode it
  // measures at 60-80ms where 20% budget (~12-16ms) is smaller than run-to-run
  // scheduler jitter. Real FCP regressions are covered by appBootstrapMillis
  // and firstCompileFromBootstrapMillis. FCP is still measured and reported.
  'metrics.appBootstrapMillis',
  'metrics.firstCompileFromBootstrapMillis',
  'warmMetrics.appBootstrapMillis',
  'warmMetrics.firstCompileFromBootstrapMillis',
]);

function isConfiguredMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function collectMetrics(prefix, section) {
  return Object.entries(section ?? {}).map(([name, value]) => ({
    key: `${prefix}.${name}`,
    value,
  }));
}

function formatMetric(value) {
  return typeof value === 'number' ? `${value.toFixed(2)}ms` : 'unset';
}

function getMaxAllowed(baselineValue) {
  return Math.max(baselineValue * budgetMultiplier, baselineValue + minimumBudgetMs);
}

function isGatedMetric(key) {
  return gatedMetricKeys.has(key);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function main() {
  const { baselinePath, currentPath, strict } = parseArgs(process.argv.slice(2));
  let baseline;
  let current;
  try {
    [baseline, current] = await Promise.all([readJson(baselinePath), readJson(currentPath)]);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      if (String(error.path ?? '') === baselinePath) {
        throw new Error(
          `Baseline file not found: ${baselinePath}\nCreate it with npm run perf:accept${
            baselinePath.endsWith('perf-baseline.local.json') ? ':local' : ''
          }.`,
        );
      }
      if (String(error.path ?? '') === currentPath) {
        throw new Error(
          `Current perf candidate not found: ${currentPath}\nGenerate it with npm run perf:capture.`,
        );
      }
    }
    throw error;
  }

  const baselineMetrics = [
    ...collectMetrics('metrics', baseline.metrics),
    ...collectMetrics('warmMetrics', baseline.warmMetrics),
  ];
  const currentMetrics = new Map(
    [
      ...collectMetrics('metrics', current.metrics),
      ...collectMetrics('warmMetrics', current.warmMetrics),
    ].map((entry) => [entry.key, entry.value]),
  );

  const configuredBaselineMetrics = baselineMetrics.filter((entry) =>
    isConfiguredMetric(entry.value),
  );
  if (configuredBaselineMetrics.length === 0) {
    console.log(`No populated baseline metrics found in ${baselinePath}; skipping perf gate.`);
    return;
  }

  const failures = [];
  const diagnostics = [];
  for (const metric of configuredBaselineMetrics) {
    const currentValue = currentMetrics.get(metric.key);
    const gated = isGatedMetric(metric.key);
    if (!isConfiguredMetric(currentValue)) {
      const message = `${metric.key}: missing current metric (baseline ${formatMetric(
        metric.value,
      )})`;
      if (gated) {
        failures.push(message);
      } else {
        diagnostics.push(message);
      }
      continue;
    }

    const maxAllowed = getMaxAllowed(metric.value);
    const withinBudget = currentValue <= maxAllowed;
    const status = withinBudget ? 'PASS' : gated ? 'FAIL' : 'WARN';
    console.log(
      `${status} ${metric.key}: baseline ${formatMetric(metric.value)}, current ${formatMetric(
        currentValue,
      )}, budget ${formatMetric(maxAllowed)}`,
    );

    if (!withinBudget) {
      const message = `${metric.key}: current ${formatMetric(currentValue)} exceeds budget ${formatMetric(
        maxAllowed,
      )} (baseline ${formatMetric(metric.value)})`;
      if (gated) {
        failures.push(message);
      } else {
        diagnostics.push(message);
      }
    }
  }

  if (diagnostics.length > 0) {
    console.warn(
      `Diagnostic perf regressions detected (not CI-gating):\n${diagnostics.join('\n')}`,
    );
  }

  if (failures.length > 0) {
    const message = `Performance regression detected:\n${failures.join('\n')}`;
    if (strict) {
      throw new Error(message);
    }

    console.warn(
      `${message}\nLocal compare against the committed CI baseline is advisory. Use --strict or perf:compare:local for enforcement.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
