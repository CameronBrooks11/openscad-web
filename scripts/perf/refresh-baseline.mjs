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

import { gatedMetricKeys, isConfiguredMetric } from './compare-baseline.mjs';

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
  // Integer arithmetic: `Math.ceil((p / 100) * n)` disagrees with the exact
  // rank for some (n, p) pairs because p/100 is not representable in binary.
  // Not reachable at the default p90, but --percentile is user-facing.
  const scaled = p * sorted.length;
  const rank = Math.floor(scaled / 100) + (scaled % 100 === 0 ? 0 : 1);
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
  const dropped = [];
  for (const name of names) {
    const values = runs
      .map((run) => run[section]?.[name])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    // A metric missing (or null -- aggregate-baseline.mjs writes null when no
    // run produced it) from any input cannot be aggregated. Treating it as 0
    // would pin the budget to the 5ms floor and fail every later run.
    if (values.length !== runs.length) {
      dropped.push(name);
      continue;
    }
    out[name] = round(nearestRankPercentile(values, percentile));
  }
  return { metrics: out, dropped };
}

/**
 * Every gated metric must survive into the baseline. `compare-baseline.mjs`
 * iterates *baseline* metrics, so one that is absent is never compared again --
 * recreating the exact blindness #278 was filed about, through a new door.
 *
 * Stated as a positive presence check rather than "nothing dropped was gated".
 * The negative form missed the worse case: a metric absent from *every* input
 * never enters the dropped set at all, because that set is built from the union
 * of observed keys. It would then vanish silently, and a 3.3x bootstrap
 * regression passed the resulting gate.
 */
export function assertGatedMetricsPresent({ metrics, warmMetrics }) {
  // `name in obj` would only prove presence. compare-baseline.mjs skips a
  // metric that is present but not *usable* (negative, NaN, non-numeric), so
  // asserting presence alone still lets a gated metric stop being compared.
  // Reuse the consumer's predicate so the two cannot drift.
  const missing = [...gatedMetricKeys].filter((key) => {
    const [section, name] = key.split('.');
    const values = section === 'warmMetrics' ? warmMetrics : metrics;
    return !isConfiguredMetric((values ?? {})[name]);
  });
  if (missing.length > 0) {
    throw new Error(
      `Refusing to write a baseline missing gated metric(s): ${missing.join(', ')}.\n` +
        'These drive CI pass/fail; a baseline without them silently stops gating.\n' +
        'At least one input run did not report them -- re-harvest, or drop that run.',
    );
  }
}

/**
 * The committed baseline is compared against CI runs, so it must be built from
 * CI runs. A workstation-captured baseline is what made the gate unfailable for
 * two months (#278), and nothing surfaced it — so refuse rather than warn.
 */
export function assertCiProfiles(runs, { assumeProfile } = {}) {
  const profiles = [...new Set(runs.map((run) => run.environment?.profile ?? 'unknown'))];
  if (assumeProfile) {
    // The flag exists for artifacts captured before the profile was stamped
    // correctly -- not to relabel a workstation capture as CI. Without this it
    // fully inverts the guard it is attached to.
    if (!/^ci-/.test(assumeProfile)) {
      throw new Error(
        `--assume-profile must name a CI profile (ci-*); got '${assumeProfile}'.\n` +
          'It cannot be used to record a local capture as a CI one.',
      );
    }
    return [assumeProfile];
  }
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
  const observedProfiles = [...new Set(runs.map((run) => run.environment?.profile ?? 'unknown'))];
  const profiles = assertCiProfiles(runs, { assumeProfile });
  if (assumeProfile) {
    process.stderr.write(
      `Recording profile '${assumeProfile}' for inputs stamped ` +
        `'${observedProfiles.join(', ')}'; noted in notes.profileAssumed.\n`,
    );
  }

  const cold = aggregateSection(runs, 'metrics', percentile);
  const warm = aggregateSection(runs, 'warmMetrics', percentile);
  assertGatedMetricsPresent({ metrics: cold.metrics, warmMetrics: warm.metrics });
  const dropped = [
    ...cold.dropped.map((name) => `metrics.${name}`),
    ...warm.dropped.map((name) => `warmMetrics.${name}`),
  ];
  if (dropped.length > 0) {
    process.stderr.write(
      `Dropped ${dropped.length} metric(s) not reported by every input run: ` +
        `${dropped.join(', ')}. These will not be compared at all.\n`,
    );
  }

  const baseline = {
    version: 1,
    capturedAt: new Date().toISOString(),
    environment: {
      ...(runs[0].environment ?? {}),
      profile: profiles.length === 1 ? profiles[0] : profiles.join('+'),
    },
    metrics: cold.metrics,
    warmMetrics: warm.metrics,
    notes: {
      aggregation: `p${percentile} (nearest rank) of per-run medians`,
      sampleCount: runs.length,
      generatedBy: 'scripts/perf/refresh-baseline.mjs',
      inputs: inputs.map((input) => path.basename(path.dirname(path.resolve(repoRoot, input)))),
      // Recorded so a reader can audit the file's provenance. `profile` alone
      // would claim a CI capture with nothing saying the label was asserted
      // rather than measured.
      ...(assumeProfile
        ? { profileAssumed: { assumed: assumeProfile, observed: observedProfiles } }
        : {}),
      ...(dropped.length > 0 ? { droppedMetrics: dropped } : {}),
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
