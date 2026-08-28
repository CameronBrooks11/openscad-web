# Performance Baseline

`perf-baseline.json` is the committed CI regression baseline.
`perf-baseline.local.json` is an ignored local-only baseline for relative workstation comparisons.

## Normal Flow

1. Generate a local candidate:

```sh
npm run perf:capture
```

If your local machine is noisy and you want a steadier candidate, run the 3-sample median capture:

```sh
npm run perf:capture:series
```

2. Compare it to the committed baseline:

```sh
npm run perf:compare
```

This compares against the committed CI baseline.
Locally it is advisory.

CI runs three captures on the same runner, aggregates them with per-metric median, compares the aggregated candidate in strict mode, and uploads `perf-baseline-candidate` as an artifact.

CI fails only on headline user-facing metrics:

- `metrics.appBootstrapMillis`
- `metrics.firstCompileFromBootstrapMillis`
- `warmMetrics.appBootstrapMillis`
- `warmMetrics.firstCompileFromBootstrapMillis`

`firstContentfulPaintMillis` (cold and warm) is measured and reported but not
CI-gating. In headless CI mode it resolves at 60–80ms where a 20% budget
(~12–16ms) is smaller than normal runner scheduler jitter, causing chronic
false failures. Meaningful FCP regressions are indirectly covered by the
bootstrap and compile metrics above.

3. For local relative checks, compare against your ignored local baseline:

```sh
npm run perf:compare:local
```

## Accepting a New Baseline

Only accept a new CI baseline after intentional perf-impacting changes or after a stable CI capture.

```sh
npm run perf:accept
```

This copies `coverage/perf/current-perf-baseline.json` to `perf-baseline.json`.

If you want to accept a downloaded CI artifact instead, pass the file path:

```sh
npm run perf:accept -- path/to/current-perf-baseline.json
```

To create or refresh your ignored local baseline from the current local capture:

```sh
npm run perf:accept:local
```

### Refreshing from many CI runs

`perf:accept` takes a single run. That is right after a deliberate,
perf-impacting change, but it is wrong for a periodic refresh: one sample of a
noisy population sets budgets the next run may not meet.

The `performance` job uploads `perf-baseline-candidate` on every run, so the
samples already exist. Harvest a dozen or more from runs on current code and
aggregate them:

```sh
for id in <run-ids>; do
  gh run download "$id" -n perf-baseline-candidate -D "harvest/$id"
done
npm run perf:refresh -- harvest/*/current-perf-baseline.json
```

Each input is one CI run's median-of-3. `refresh-baseline.mjs` takes the **p90
(nearest rank)** of those per-run medians for every metric, and records the
sample count and contributing run IDs in `notes` so the file says where its
numbers came from.

p90 rather than the median because the budget is a flat +20%: anchoring at the
median makes that budget narrower than observed CI variance for the noisier
submetrics, so they WARN on nothing and the warnings stop meaning anything.
Nearest rank rather than an interpolated percentile so every baseline value is
a number the app actually produced on a runner.

The script **refuses** inputs whose `environment.profile` is not `ci-*`. That
is the #278 root cause made unrepeatable: the 2026-06-22 baseline was captured
on a workstation, so the gate compared runner timings against laptop timings
and could not fail. Artifacts captured before the profile was stamped correctly
read `local-headless` even on CI; pass `--assume-profile ci-Linux` for those,
and only those.

Sanity-check a candidate before committing it, by comparing it against each
harvested run:

```sh
cp harvest/<id>/current-perf-baseline.json coverage/perf/current-perf-baseline.json
node scripts/perf/compare-baseline.mjs --strict
```

It should be silent on every run of current code. Then confirm it still has
teeth by comparing against runs from before a known improvement — those should
fail. A baseline that passes everything is not a gate.

Two cautions when reading the results:

- **Harvest by run, not by outcome.** A perf-gate failure sets the whole run's
  conclusion to `failure`, so collecting only successful runs censors exactly
  the slow tail you are trying to measure. Re-run attempts each keep their own
  artifact; `gh api repos/<owner>/<repo>/actions/runs/<id>/artifacts` lists all
  of them.
- **A refresh ratifies whatever it measures.** Compare the new values against
  the old before committing: any metric that got _slower_ is a regression you
  are baselining in, and it should be a conscious decision rather than a side
  effect.

## Rules

- Compare is automatic.
- Baseline updates are manual.
- `perf-baseline.json` is CI-owned and tracked.
- `perf-baseline.local.json` is developer-owned and ignored.
- Prefer CI artifact values over local machine values when updating `perf-baseline.json`.
- Local compare against the CI baseline is informational.
- Local compare against `perf-baseline.local.json` is enforcing.
- CI perf uses median aggregation across three runs, not a single sample or best-of-N.
- CI compare is enforcing only for headline startup metrics; submetrics are diagnostic.
- Check `environment.profile` before trusting a baseline: `ci-*` was measured on
  a runner, `local-headless` on someone's workstation. A locally captured
  baseline sets budgets against the wrong hardware — that is how the
  2026-06-22 baseline came to be unfailable (#278).
