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

## Rules

- Compare is automatic.
- Baseline updates are manual.
- `perf-baseline.json` is CI-owned and tracked.
- `perf-baseline.local.json` is developer-owned and ignored.
- Prefer CI artifact values over local machine values when updating `perf-baseline.json`.
- Local compare against the CI baseline is informational.
- Local compare against `perf-baseline.local.json` is enforcing.
- CI perf uses median aggregation across three runs, not a single sample or best-of-N.
- CI compare is enforcing.
