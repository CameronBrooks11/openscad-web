# Performance Baseline

`perf-baseline.json` is the committed regression baseline.

## Normal Flow

1. Generate a candidate:

```sh
npm run perf:capture
```

2. Compare it to the committed baseline:

```sh
npm run perf:compare
```

Locally this is advisory because the committed baseline is CI-sourced.

CI runs the same comparison in strict mode and uploads `perf-baseline-candidate` as an artifact.

## Accepting a New Baseline

Only accept a new baseline after intentional perf-impacting changes or after the first stable CI capture.

```sh
npm run perf:accept
```

This copies `coverage/perf/current-perf-baseline.json` to `perf-baseline.json`.

If you want to accept a downloaded CI artifact instead, pass the file path:

```sh
npm run perf:accept -- path/to/current-perf-baseline.json
```

## Rules

- Compare is automatic.
- Baseline updates are manual.
- Prefer CI artifact values over local machine values when re-baselining.
- Local compare is informational by default.
- CI compare is enforcing.
