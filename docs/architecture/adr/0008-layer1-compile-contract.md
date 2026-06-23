# ADR 0008 — Layer-1 compile contract and immutable artifact identity

**Status:** Accepted — the deferred Layer-1 item of #123 / ADR 0007. Full contract
built now as forward scaffolding for the MCP / native-backend bindings; revised
after an adversarial design review (correctness + scope fixes folded in).

## Context

ADR 0005 sketched a Layer-1 session protocol on a shared versioned envelope and
marked the L1 ops (`syntaxCheck`/`preview`/`render`/`export`/`cancel`) as a
**non-binding** sketch to be finalized here. ADR 0007 shipped session isolation
(`OpenScadSession` owns a per-session `WasmWorkerBackend implements
CompileBackend`) and deferred "Layer-1 contract + immutable artifact identity" to
this ADR, leaving a note: per-session worker ids are safe today but identity must
be globally unique once artifact identity lands.

Today (grounded in code):

- **Worker correlation.** `CompileRequest.id` is a per-backend serial counter,
  internal to one backend's serial queue; `revision` is echoed back unchanged
  (the #56/#99 source-revision stale-drop).
- **No operation id.** The host disambiguates with `_previewSeq`/`_renderSeq`/
  `_syntaxSeq` + the revision stale-drop; export adds `_exportSeq` + an
  `_activeRender` kill-handle (#125/#149).
- **Artifacts.** `FileOutput { outFile, outFileURL, … }` is committed into
  `state.output`/`state.export`, each minting a blob URL and revoking the previous
  one (#145). Some export artifacts have **no** worker job — 3MF/GLB are produced
  in-browser from the OFF (`export-service.ts:121-148`).
- **Embed (shipped public surface, protocol v2).** `getArtifact` carries no
  artifact id and returns "whatever is current"; `renderComplete` sends only
  `{name,size,format}`; it correlates with `requestId`. Inbound validation
  (`embed/protocol.ts:58-133`) reads known fields and **ignores extras** (not
  strict-reject).

The gap #123 closes: a deterministic, correlated **terminal** result per
operation, and a stable artifact identity so `getArtifact(artifactId)` returns the
_exact_ bytes a given operation produced — fixing the race where a render landing
between the host's `renderComplete` and its `getArtifact` returns the wrong bytes.

## Decision

A **host-side Layer-1 contract above `CompileBackend` and below the embed/MCP
bindings.** The worker protocol and the `CompileBackend` boundary do **not**
change — the entire contract is derived host-side from the existing
`OpenSCADInvocationResults`. Types live in a new DOM-free module
`src/runner/compile-contract.ts`; the per-session **artifact store** is owned by
`OpenScadSession` and reached through `ServiceContext`.

### 1. Identity model (review-corrected)

- **`operationId` is minted per scheduler invocation** — one per
  `coordinator.render()` / `coordinator.checkSyntax()` / `exportService.export()`
  call. It is **not** the worker `CompileRequest.id` (which stays the per-backend
  serial token, unchanged and never escaping). One operation maps to **0 or 1**
  worker spawns: in-browser 3MF/GLB export is an operation with **zero** worker
  jobs but still one terminal result; the **2D/3D dimension retry**
  (`compile-coordinator.ts:342-360`) is a **distinct second operation**, not
  "several jobs under one id" — so the "exactly one terminal result per
  operationId" invariant holds trivially. (Earlier framing of "0..N jobs per op"
  was wrong and is dropped.)
- **`operationId` / `artifactId` are bare v4 UUIDs** via a `randomId()` helper
  with a `crypto.getRandomValues` fallback (`crypto.randomUUID` needs a secure
  context + Safari ≥ 15.4; a LAN-IP dev preview / old Safari would otherwise
  throw). A UUID is already globally unique, so **no `sessionId:` prefix** is used
  for uniqueness.
- **`OpenScadSession` gains `readonly id`** (a UUID, minted in its constructor),
  surfaced on `ServiceContext`, so the contract's `sessionId` field has a real
  source. This is for routing/debug correlation, not uniqueness.
- Relationship to ADR 0005: the **viewer** transport already uses an analogous
  `opId` pattern (`protocol/viewer-transport.ts`), but that correlates host→viewer
  geometry, not compiles. This `operationId` is the **new** compile-layer
  correlation; the envelope itself does not pre-reserve it.

### 2. Command / result shapes (`src/runner/compile-contract.ts`)

Named `Operation*` to avoid colliding with the worker protocol's existing
`CompileRequest`/`CompileResult` (`worker-protocol.ts:2,35`).

```ts
export type OperationKind = 'syntaxCheck' | 'preview' | 'render' | 'export';

export interface OperationCommand {
  protocolVersion: number; // shared envelope (ADR 0005)
  sessionId: string;
  operationId: string; // v4 UUID
  sourceRevision: number; // model._sourceRevision at submit
  kind: OperationKind;
  // kind-specific payload (entry path, vars, features, format) → the EXISTING
  // buildOpenScadArgs builds the actual args; unchanged.
}

export interface CancelCommand {
  protocolVersion: number;
  sessionId: string;
  operationId: string; // the operation to cancel
}

interface OperationResultBase {
  protocolVersion: number;
  sessionId: string;
  operationId: string;
  sourceRevision: number; // echoed (the #56/#99 stale-drop is unchanged)
  kind: OperationKind;
  elapsedMillis: number;
  diagnostics: Diagnostic[]; // host-neutral markers (ADR 0001)
  logText: string;
}
export interface OperationSuccess extends OperationResultBase {
  status: 'success';
  artifact?: ArtifactRef;
}
export interface OperationFailure extends OperationResultBase {
  status: 'error';
  code: string;
  reason: string;
}
export interface OperationCancelled extends OperationResultBase {
  status: 'cancelled';
}

// Exactly ONE terminal result per operationId.
export type OperationResult = OperationSuccess | OperationFailure | OperationCancelled;
```

`syntaxCheck` → `success` with no `artifact`; `preview`/`render`/`export` →
`success` with one `ArtifactRef`. `code` reuses the existing `user-facing-errors`
taxonomy.

**Supersession is unchanged — emit is _added_, not substituted.** Today a
superseded/stale op hits `if (!isCurrent()) return;` and returns with no commit
(`compile-coordinator.ts:178,191,331`; `export-service.ts:182,202`). The contract
adds a `status:'cancelled'` emit _alongside_ those returns; the guards' UI-commit
**decisions** are byte-identical (which result the UI commits is unchanged). Note:
`cancelled` collapses both revision-stale-drop and user/priority supersession into
one status — acceptable; an MCP consumer that needs to distinguish them can read
`sourceRevision`.

### 3. Immutable artifact identity

```ts
export interface ArtifactRef {
  artifactId: string; // v4 UUID; immutable
  operationId: string;
  sourceRevision: number;
  format: string; // 'off' | 'svg' | 'stl' | '3mf' | 'glb' | …
  mediaType: string; // derived via a format→mime map (3MF/GLB Files have no .type)
  size: number;
  name: string;
}
```

**The artifact store holds only `artifactId → File` (canonical bytes). It does NOT
own or revoke the viewer's object URL.** (Review fix: an LRU that revoked URLs
could revoke one the SVG `<img src>` / a pending download still references —
`osc-viewer-panel.ts:178`, `export-service.ts:92` — a regression.) So:

- `FileOutput` keeps `outFile`/`outFileURL` and the **existing #145 revoke logic
  unchanged** (`compile-coordinator.ts:313`, `export-service.ts:187`). The viewer
  and downloads are byte-identical.
- `FileOutput` **gains** `artifactId`, `operationId`, `sourceRevision` (so embed
  events can carry correlation without the terminal-result machinery).
- A small per-session bounded `Map<artifactId, File>` (last-N) is the store.
  `getArtifact(artifactId)` returns those exact bytes; an evicted/unknown id →
  `{available:false}`. The **no-arg** `getArtifact` path is unchanged (returns the
  current output), so nothing regresses for legacy embedders.

There are **three** `FileOutput` write sites: the render commit
(`compile-coordinator.ts:317`), the export commit (`export-service.ts:190`), and
the pass-through alias `s.export = s.output` (`export-service.ts:91`). The first
two **mint** ids and `put()` the File; the pass-through **inherits** the existing
id (same bytes — must not mint a fresh one).

## Consequences

- Deterministic `getArtifact(id)` — exact bytes for an operation, fixing the
  current race. Correlated, terminal, host-neutral results ready for the MCP
  binding (`operationId` ↔ tool-call id) and a native backend.
- Cost: a small per-session `Map<artifactId, File>` (last-N); the current output's
  bytes are already retained by `state.output.outFile`, so marginal.
- No worker-protocol change; no deploy-critical worker-boundary edit.

## Migration & deploy safety

**Byte-identical:** worker protocol, `CompileBackend`, `buildOpenScadArgs` + the
emitted args, the produced `File` bytes, the viewer reading
`state.output.outFile/outFileURL`, the #145 revoke (unchanged), the #56/#99
stale-drop, the #125/#149 export token, and the persisted/fragment shape
(`FileOutput` is transient — `persisted-state.ts:41`, `fragment-state.ts:70`).
Same deploy bar as ADR 0004/0006/0007.

**Embed (public surface) — additive, backward-compatible:**

- `getArtifact{requestId, artifactId?}` — `artifactId` optional; **absent ⇒
  current output**, byte-identical. Present ⇒ exact bytes from the store; unknown
  ⇒ `{available:false}`.
- `renderComplete`/`artifact` gain `artifactId`/`operationId`/`sourceRevision`/
  `mediaType` alongside `{name,size,format}`. Inbound validation ignores extras;
  embedders ignoring unknown fields are unaffected.
- **No `EMBED_PROTOCOL_VERSION` bump** (additive, ignorable), BUT add an
  `artifactIdentity` capability to the `ready` message so an embedder can
  feature-detect id-addressed retrieval.
- Keep `requestId` (shipped); carry `operationId`/`artifactId` in the payload. Do
  not rename `requestId`→`operationId`.
- Known test churn: `embed/__tests__/protocol.test.ts:173-176` asserts the
  `getArtifact` parse result by exact `.toEqual` — slice 3 extends it for the new
  field.

## Alternatives considered

- **Reuse the worker `request.id` as `operationId`.** Rejected: per-backend, not
  globally unique, and one operation can have 0 worker jobs (in-browser export).
- **Registry owns/revokes the object URL (LRU eviction).** Rejected (review):
  premature-revoke regression; `FileOutput` keeps owning the URL.
- **`sessionId:`-prefixed ids.** Rejected: a UUID is already unique; `sessionId`
  is a separate field.
- **One big PR.** Rejected: unreviewable on the compile path.

## Implementation strategy — behavior-preserving slices

Each is a separately-reviewable, merge-on-green PR; the single-session default
stays byte-identical throughout.

1. **Types + identity plumbing.** Add `compile-contract.ts` (the `Operation*` /
   `ArtifactRef` types), the `randomId()` helper (+ fallback), `OpenScadSession.id`
   on the session and `ServiceContext`, and the format→mime map. Add `artifactId`/
   `operationId`/`sourceRevision` to `FileOutput`, minted at the two fresh-commit
   sites (pass-through inherits). Nothing consumes them yet. No worker, no embed
   change. _Lowest risk._
2. **Per-session artifact store + `getArtifact(artifactId)` resolution.** Add the
   `Map<artifactId, File>` store on `OpenScadSession` via `ServiceContext`;
   `put()` write-through at the two commits. UI still reads `FileOutput`; the #145
   URL logic is untouched. De-risk: assert committed `output`/`export` byte-identical.
3. **Wire embed `getArtifact{artifactId}` + enrich events + `ready` capability.**
   Additive, no version bump; no-arg = current. De-risk: back-compat test +
   exact-bytes-by-id test; update `protocol.test.ts:173-176`. _Riskiest for
   external embedders, but fully backward-compatible._
4. **Emit terminal `OperationResult` from the coordinator/export** (depends on 1).
   Build the typed terminal result per operation as the internal representation the
   UI commit and embed events derive from; add the `cancelled` emit alongside the
   existing guard returns. Supersession decisions + revision stale-drop unchanged.
   _Highest internal risk (deploy-critical commit path); behind the single-session
   default so live behavior is unchanged._
