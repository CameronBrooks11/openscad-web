# ADR 0001 — Host-neutral diagnostics

**Status:** Accepted (#55)

## Context

Compiler diagnostics were typed as `monaco.editor.IMarkerData` throughout the
domain: `State`, the runner action contracts, and `user-facing-errors`. This
coupled the compiler/diagnostic contracts to the editor library, so any non-editor
consumer (the footer, error normalization, future hosts) inherited a Monaco
dependency, and the editor's marker shape leaked into the core.

## Decision

Introduce a host-neutral `Diagnostic` type (`src/diagnostics.ts`):
`severity: 'error' | 'warning' | 'info'`, a message, a 1-based range, and an
optional `source`. The output parser, runner contracts, `State`, and
`user-facing-errors` produce and consume `Diagnostic[]`. The editor converts to
Monaco markers via a single adapter (`src/language/diagnostic-markers.ts`); the
footer uses host-neutral severity helpers.

`src/state` and `src/runner` contain no `monaco-editor` import.

## Consequences

- Diagnostics flow as a plain data type; only the editor package knows about
  Monaco markers.
- Severity ordering (`error > warning > info`) is preserved by an explicit rank,
  matching Monaco's previous numeric ordering.
- The state field is still named `markers` (type `Diagnostic[]`); renaming it to
  `diagnostics` is deferred as cosmetic.
