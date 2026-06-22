# ADR 0004 — Defer the `Source` discriminated union

**Status:** Implemented — the decomposed effort the decision called for has
landed. The `ProjectSource` union is the canonical state type with byte-compatible
flat-shape conversions at the fragment/`state.json`/worker boundaries, and source
revisions are stamped onto compile requests/results and checked before applying
(#56 closed; revision stamping in #99). Binary _project_ assets remain out of
scope (the byte path is hardened, but the import feature is deferred — see #121).

## Context

`Source` (`{ path; url?; content? }`) allows ambiguous states (both `content` and
`url` set, or neither; a directory implied only by a trailing `/`). The cleanup
goal is an explicit discriminated union (text / binary / remote / archive) so no
ambiguous state is representable, plus a project revision stamped onto compile
requests/results.

Two facts make this risky to land as one change:

1. **Blast radius** — the `Source` shape (the `sources` field and the `Source`
   type) is referenced at ~70+ sites across ~15 files (model, runner, worker
   protocol, url-mode, fragment-state, persistence).
2. **Serialization backward-compat under live deploy** — `fragment-state`
   serializes `Source`'s flat shape into shareable model URLs and persisted
   state. Adding a `kind` discriminator changes that on-the-wire shape. Merges to
   `main` auto-deploy to the live site, and CI has no legacy-URL backward-compat
   test, so a subtle regression would ship live and silently break existing
   shared/bookmarked URLs.

## Decision

Defer the union to a deliberate, decomposed effort rather than a one-shot rewrite:

1. Introduce the `ProjectSource` union plus `toWire`/`fromWire` and
   `toFragment`/`fromFragment` conversion helpers, keeping both serialized
   boundaries (worker protocol, URL fragment) in their current flat shapes. Add a
   **legacy-URL fixture test** that deserializes an old-format fragment — this
   closes the CI gap before any migration.
2. Migrate the worker/runner boundary, then `Model`/state, in separate PRs.
3. Add the project-revision request/result stamping (note: largely overlaps the
   staleness guards already in place from #47 and #48, so it is contract
   groundwork rather than a new correctness fix).

`#57` (extract `ProjectStore`) can proceed against the current `Source` type and
adopt the union later, so it is only softly blocked.

## Consequences

- Ambiguous source states remain representable for now.
- The migration, when done, must preserve the URL/persistence wire format and
  prove it with a fixture test.
