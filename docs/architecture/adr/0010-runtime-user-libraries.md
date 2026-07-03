# ADR 0010 — Runtime user libraries over the session wire

**Status:** Proposed — the design for #195 (runtime user libraries /
OPENSCADPATH beyond the bundled zips). Adversarially design-reviewed
2026-07-03; the review's findings are folded in below.

## Context

Libraries today are exclusively the 21 build-time bundled zips
(`src/fs/zip-archives.generated.ts`, generated from `libs-config.json`): the
worker mounts referenced archives as ZipFS under `/libraries/<name>` and
symlinks `/<name> → /libraries/<name>` into each job's fresh WASM FS
(`symlinkLibraries`); with CWD `/`, `use <BOSL2/std.scad>` resolves through the
symlink. There is **no `-I`/`OPENSCADPATH`** anywhere — the root symlink IS the
resolution mechanism. A project referencing the user's own library
(`use <MyLib/foo.scad>` against a local checkout) cannot resolve: unknown names
no-op in `LibraryMounter.fetchAndMount`, and pushing library files through the
project contract is triple-walled (paths canonicalize under `/home`;
`materializeBinarySources` and the worker's source-write loop both skip
`/libraries`).

Hosts need to supply libraries at runtime — concretely the VS Code extension
(an `openscadWeb.libraryPaths` setting over the user's local library
directories), and eventually whatever installs libraries on the user's machine.
Notably, the OpenSCAD project is prototyping a **library/package manager**;
its manifest format, versioning, and install layout are not settled. This
design must serve today's "directory of `.scad` files" reality without
inventing competing package semantics — and without needing a wire redesign
when a real manager exists.

Constraints established by code (see #195's scoping trace):

- The compile worker is **terminated and recreated** on timeout/crash; only the
  configure-time payload is replayed. Anything the worker must keep knowing has
  to be retained host-side and replayed.
- Mounting a user-supplied **zip** as ZipFS would bypass the per-entry
  zip-slip/normalization guards our own ZIP import applies (#75–#77), and
  whether the ZipFS→EmscriptenFS bridge is escape-proof against hostile entry
  names is unestablished. Consumers would also need zip tooling (the extension
  has zero runtime dependencies).
- Bytes already ride the wire safely as `Uint8Array` via structured clone
  (#172), with per-entry validation precedent.

## Decision

### 1. Provenance-agnostic library sets

One new Layer-1 command:

```ts
setLibraries({ libraries: SessionLibrary[], requestId? })   // declarative: the FULL set

SessionLibrary = {
  name: string;               // the `use <Name/…>` token — identity
  files: LibraryFile[];       // relative paths INSIDE the library
  meta?: { version?: string; source?: string };  // passthrough only
}
LibraryFile = { path: string; content: string } | { path: string; bytes: Uint8Array }
```

Where the files come from is the producer's business: today the extension
walks the user's directories; a future library manager (the OpenSCAD org's, an
app-side UI, or a registry-resolving host) is just **another producer of the
same payload**. `meta` is opaque passthrough (logging/display) — the session
assigns it no semantics.

### 2. Identity and (non-)package semantics

`name` is exactly the directive token. We define **no** manifests, version
constraints, or dependency resolution: the language admits exactly one binding
per name (`use <Name/…>`), so any manager must resolve to **one version per
name** before producing the payload — versioned side-by-side copies are
intentionally unrepresentable (`@` is excluded from the name charset, so
`Name@2.1`-style disambiguation is foreclosed on purpose). A manager's
resolved install maps as `installed package dir → { name, files,
meta.version }`, dependencies as sibling `SessionLibrary` entries — which work
because of the unconditional per-job symlinking in §5.

An archive-bearing `SessionLibrary` variant MAY be added later for a manager
that distributes zips — additively engine-side, but note: (a) it requires the
ZipFS→EmscriptenFS bridge to first be established escape-proof under the
#75–#77 posture, and (b) wire-side it needs a capability signal, since strict
validators reject unknown shapes.

### 3. Precedence: runtime shadows bundled, by WHOLE library name

A runtime `BOSL2` fully replaces the bundled zip for that name. Mechanics
(these are the load-bearing details — the naive "consult a second registry"
does not implement them):

- `mountDemandLibraries`/`fetchAndMount` check the runtime registry **before**
  `zipArchives`: a shadowed name never fetches/mounts its bundled ZipFS.
- If the bundled archive was **already demand-mounted** in this worker when the
  shadow arrives, applying the set **unmounts** it (`LibraryMounter` gains an
  unmount; today it has none) — and removing the shadow later restores the
  name's demand-mount eligibility.
- `symlinkLibraries` consults the runtime registry first and gives runtime
  libraries **exactly the default `/​<name>` directory symlink** — a bundled
  archive's custom `symlinks` map (the seven flat-include libraries such as
  `smooth-prim`) is NEVER applied to runtime files; shadowing such a name
  changes its include style, and the apply reports a per-name diagnostic
  saying so.
- Shadowing is **whole-library**: unlike native OpenSCAD's per-file
  OPENSCADPATH fallthrough, a sparse runtime copy does NOT merge with the
  bundled one (a 3-file runtime BOSL2 hides all ~99 bundled files). This is a
  deliberate divergence — per-file merge across a ZipFS and loose files is
  complexity without a driving consumer — and hosts should surface which
  bundled names their push shadows.
- Matching is exact and case-sensitive.

### 4. Lifecycle: a revision-bumping Model mutation

`setLibraries` is a **Model mutation like `setProject`**: it funnels through
one `mutate` (one `sourceRevision` bump, one `'state'` event — though the set
itself lives OUTSIDE `params`/the durable slice, see §7) and then drives
`processSource`. That single decision buys, via existing machinery:

- **Recompile**: a project already pushed — and failing on the missing
  library — recompiles when the libraries arrive; declarative
  order-independence (`setProject`/`setLibraries` in either order) is real,
  not aspirational.
- **Stale-drop**: an in-flight compile against the OLD set terminates via the
  standard revision-stale-drop; its result cannot masquerade as the new set's.
- **Ack**: the optional `requestId` is answered with the #227 ack pattern
  (`libraries-ack { requestId, sourceRevision }`, same semantics as
  `project-ack` including rejected-push detection by non-advancing revision).
- Validation failures reject the whole command atomically (nothing mounted).

### 5. Worker application: job boundaries, subtree replace, unconditional symlinks

- The runner retains the validated set host-side and replays it to the worker
  on every (re)creation via a **dedicated worker-level message** (sent after
  `configure`; `configure` itself stays a one-shot asset-URL handshake).
- The worker applies a set only at **job boundaries** (never during a job's
  async setup — a mid-setup apply would give that job a torn set; each job
  snapshots the set version it starts with).
- Applying a set first **deletes the `/libraries/<name>` subtrees of every
  previously runtime-owned name**, then writes the new files — replacing v1
  with v2 cannot leave v1-only files resolvable, and removing a library
  removes its tree (and un-shadows the bundled name, §3).
- **Every runtime library is registered and symlinked on every job**,
  regardless of the directive scan (symlinks are per-job and cheap). This is
  what makes sibling-dependency payloads work: the project may reference only
  `A` while `A` references `B`. Runtime libraries' text files also JOIN the
  directive-scan corpus, so a runtime library that does
  `include <BOSL2/std.scad>` still demand-mounts the bundled BOSL2.
- A failed root symlink for a runtime name (currently console-swallowed for
  bundled libs) is surfaced as a per-name diagnostic — the user explicitly
  pushed it; silence would be a dead library.

### 6. Validation (per entry — no archive trust)

- **Name**: `[A-Za-z0-9._-]+`, additionally rejecting `.` and `..` outright,
  and a reserved list (`fonts`, `home`, `tmp`, `libraries`, `locale`, `dev`,
  `proc`) — the name becomes a root symlink verbatim and root-symlink failures
  are otherwise silent.
- **Paths**: relative, normalized, no traversal/absolute/control characters
  (the `normalizeProjectPath` posture); bytes at text-suffix paths must be
  valid UTF-8 (#172 semantics).
- **Duplicates**: duplicate names in one payload, or duplicate paths within
  one library, reject atomically. Case-variant names/paths are permitted (the
  VFS is case-sensitive) — a documented divergence from native Windows
  OpenSCAD, where wrong-case directives resolve.
- **Budgets**: a **separate pool** from the project push, with the same
  constants (per-file 32 MiB, total 64 MiB). Note the retention multiplier:
  Model copy + runner replay copy + worker copy ≈ 3× the payload, in addition
  to the project's own budget.

### 7. Scope and non-goals

- **Session tier only.** The main-thread editor-mode `LibraryMounter`
  (browse/preload in the full app) stays unaware of runtime libraries.
  Accepted risk: if the full app ever adopts runtime libraries on a shared
  Model, editor browse and worker compile would show divergent copies —
  revisit this ADR at that point. (Root-symlink collisions with project files
  are a non-issue in the session tier — project paths canonicalize under
  `/home` — but become one in the app tier, where sources can sit at `/`.)
- **Not persisted.** The set lives outside `params` and the durable slice —
  explicitly, so a later persistence refactor cannot accidentally write tens
  of MB of library bytes into IndexedDB. Hosts re-push per session
  (the extension already re-pushes on every `ready`).
- **Feature detection.** `setLibraries` joins `SESSION_COMMANDS` advertised in
  `ready`; `SESSION_PROTOCOL_VERSION` stays 2 (additive). Hosts MUST
  feature-detect before sending (the #226/#227 lesson: additive features
  degrade silently against an older bundle — here to an `unknown-type` error
  and silently-absent libraries).

## Consequences

- The extension gains user libraries with zero new dependencies (directory
  walk → `SessionLibrary[]`); BOSL2-scale sets (~99 files / ~4.8 MB) fit well
  under the budget. Worker recycle re-sends the set — an accepted cost, capped
  by the budgets.
- A future library manager integrates as a producer, not a protocol change; we
  never migrate stored package semantics because we stored none.
- Whole-library shadowing means a stale or sparse user copy can mask a bundled
  library — mitigated by hosts surfacing shadowed names, and by the per-name
  apply diagnostics (§5).
- The e2e/EDH suites gain a real-WASM case: push a user library, compile
  `use <MyLib/util.scad>`, assert resolution — pinning the registry/symlink
  seam that today only bundled libraries exercise; plus shadow/unshadow and
  replace-removes-stale-files cases at the unit tier.
