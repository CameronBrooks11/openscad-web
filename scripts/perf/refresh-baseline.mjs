#!/usr/bin/env node

// Rebuild `perf-baseline.json` from many harvested CI runs.
//
// `perf:accept` takes a single run, which is right after a deliberate,
// perf-impacting change. It is wrong for a periodic refresh: one sample of a
// noisy population sets budgets the next run may not meet. This aggregates
// across runs instead.
//
// Usage:
//   gh run download <id> -n perf-baseline-candidate -D harvest/<id>   # xN
//   node scripts/perf/refresh-baseline.mjs harvest/*/current-perf-baseline.json
//
// Each input is one CI run's median-of-3 (what `perf:capture:series` writes).
//
// Emits the new baseline to --out (default perf-baseline.json).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Nearest-rank percentile: the smallest observed value at or above which `p`
 * percent of the sample falls. Deliberately an *observed* value, never an
 * interpolation between two — a baseline should be a number the app actually
 * produced on a runner.
 *
 * Spelled out because the previous refresh was a hand computation described in
 * prose as "p90"; several defensible estimators disagree by a few percent, so
 * the next person recomputing it would not have reproduced the file (#278).
 */
export function nearestRankPercentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('nearestRankPercentile: empty sample');
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** Round to one decimal, matching what the capture pipeline writes. */
const round = (value) => Math.round(value * 10) / 10;

/**
 * Aggregate one metric section across runs. A metric missing from any run is
 * dropped rather than treated as zero, which would silently set a budget of
 * 5ms (the floor) and fail every subsequent run.
 */
export function aggregateSection(runs, section, percentile) {
  const names = new Set(runs.flatMap((run) => Object.keys(run[section] ?? {})));
  const out = {};
  for (const name of names) {
    const values = runs
      .map((run) => run[section]?.[name])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (values.length !== runs.length) continue;
    out[name] = round(nearestRankPercentile(values, percentile));
  }
  return out;
}

/**
 * The committed baseline is compared against CI runs, so it must be built from
 * CI runs. A workstation-captured baseline is what made the gate unfailable for
 * two months (#278), and nothing surfaced it — so refuse rather than warn.
 */
export function assertCiProfiles(runs, { assumeProfile } = {}) {
  const profiles = [...new Set(runs.map((run) => run.environment?.profile ?? 'unknown'))];
  if (assumeProfile) return [assumeProfile];
  const local = profiles.filter((profile) => !profile.startsWith('ci-'));
  if (local.length > 0) {
    throw new Error(
      `Refusing to build a CI baseline from non-CI captures: ${local.join(', ')}.\n` +
        'The committed baseline gates CI runs and must be measured on a runner.\n' +
        "Runs captured before this repo stamped the profile correctly read 'local-headless' " +
        'even on CI. If you know the inputs are genuinely CI artifacts, re-run with\n' +
        '  --assume-profile ci-Linux\n' +
        'which records that profile in the output. Do not use it to launder local captures.',
    );
  }
  return profiles;
}

function parseArgs(argv) {
  const inputs = [];
  let out = 'perf-baseline.json';
  let percentile = 90;
  let assumeProfile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[i + 1];
      i += 1;
    } else if (arg === '--percentile') {
      percentile = Number.parseFloat(argv[i + 1]);
      i += 1;
    } else if (arg === '--assume-profile') {
      assumeProfile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) throw new Error('Provide at least one candidate JSON path.');
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error(`--percentile must be in (0, 100]; got ${percentile}`);
  }
  return { inputs, out, percentile, assumeProfile };
}

async function main() {
  const { inputs, out, percentile, assumeProfile } = parseArgs(process.argv.slice(2));
  const runs = await Promise.all(
    inputs.map(async (input) =>
      JSON.parse(await fs.readFile(path.resolve(repoRoot, input), 'utf8')),
    ),
  );

  if (runs.length < 5) {
    process.stderr.write(
      `Warning: aggregating only ${runs.length} run(s). A dozen or more gives a ` +
        'usable picture of runner variance; fewer risks anchoring on an outlier.\n',
    );
  }
  const profiles = assertCiProfiles(runs, { assumeProfile });
  if (assumeProfile) {
    process.stderr.write(
      `Recording profile '${assumeProfile}' for inputs stamped ` +
        `'${[...new Set(runs.map((r) => r.environment?.profile))].join(', ')}'.\n`,
    );
  }

  const baseline = {
    version: 1,
    capturedAt: new Date().toISOString(),
    environment: {
      ...(runs[0].environment ?? {}),
      profile: profiles.length === 1 ? profiles[0] : profiles.join('+'),
    },
    metrics: aggregateSection(runs, 'metrics', percentile),
    warmMetrics: aggregateSection(runs, 'warmMetrics', percentile),
    notes: {
      aggregation: `p${percentile} (nearest rank) of per-run medians`,
      sampleCount: runs.length,
      generatedBy: 'scripts/perf/refresh-baseline.mjs',
      inputs: inputs.map((input) => path.basename(path.dirname(path.resolve(repoRoot, input)))),
    },
  };

  await fs.writeFile(path.resolve(repoRoot, out), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const count = Object.keys(baseline.metrics).length + Object.keys(baseline.warmMetrics).length;
  process.stdout.write(
    `Wrote ${out} from ${runs.length} CI run(s): ${count} metrics at p${percentile}.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
