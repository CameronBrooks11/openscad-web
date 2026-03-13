import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const baselinePath = path.resolve(repoRoot, process.env.PERF_BASELINE ?? 'perf-baseline.json');
const currentPath = path.resolve(
  repoRoot,
  process.env.PERF_OUTPUT ?? 'coverage/perf/current-perf-baseline.json',
);
const budgetPct = Number.parseFloat(process.env.PERF_BUDGET_PCT ?? '20');
const budgetMultiplier = 1 + budgetPct / 100;
const minimumBudgetMs = Number.parseFloat(process.env.PERF_MIN_BUDGET_MS ?? '5');
const isStrict = process.env.CI === 'true' || process.env.PERF_STRICT === 'true';

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function main() {
  const [baseline, current] = await Promise.all([readJson(baselinePath), readJson(currentPath)]);

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
  for (const metric of configuredBaselineMetrics) {
    const currentValue = currentMetrics.get(metric.key);
    if (!isConfiguredMetric(currentValue)) {
      failures.push(
        `${metric.key}: missing current metric (baseline ${formatMetric(metric.value)})`,
      );
      continue;
    }

    const maxAllowed = getMaxAllowed(metric.value);
    const status = currentValue <= maxAllowed ? 'PASS' : 'FAIL';
    console.log(
      `${status} ${metric.key}: baseline ${formatMetric(metric.value)}, current ${formatMetric(
        currentValue,
      )}, budget ${formatMetric(maxAllowed)}`,
    );

    if (currentValue > maxAllowed) {
      failures.push(
        `${metric.key}: current ${formatMetric(currentValue)} exceeds budget ${formatMetric(
          maxAllowed,
        )} (baseline ${formatMetric(metric.value)})`,
      );
    }
  }

  if (failures.length > 0) {
    const message = `Performance regression detected:\n${failures.join('\n')}`;
    if (isStrict) {
      throw new Error(message);
    }

    console.warn(
      `${message}\nLocal compare is advisory against the committed CI baseline. Set PERF_STRICT=true to enforce locally.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
