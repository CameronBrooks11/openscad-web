// Layer-1 session contract — the DOM-free data types a host and an OpenScadSession
// exchange (ADR 0008/0009). They live in the protocol layer because they ARE the
// wire payloads: a host (a VS Code webview) pushes a project and receives compile
// operation results. Kept import-free so the protocol stays distributable
// (lint-fenced). The in-process result CONSTRUCTORS and the scheduler command
// shapes (OperationCommand/CancelCommand) stay in src/runner/compile-contract.ts,
// the diagnostic UTILITIES stay in src/diagnostics.ts, and the ProjectStore stays
// in src/state — each re-exports the types it owned from here.

/**
 * Layer-1 result-payload version (ADR 0005 axis). Distinct from the session WIRE
 * version (`SESSION_PROTOCOL_VERSION`, src/protocol/session-transport.ts) and the
 * embed wire (`EMBED_PROTOCOL_VERSION`): this versions the `OperationResult` shape.
 */
export const L1_PROTOCOL_VERSION = 1;

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  // 1-based line/column range (compatible with common editor marker APIs).
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  /** Optional source/tool that produced the diagnostic. */
  source?: string;
  /**
   * File the diagnostic belongs to, as reported by the compiler (e.g.
   * `/home/playground.scad`), so a host routes the marker to the right editor
   * model instead of dumping every file's diagnostics on the active one.
   */
  path?: string;
}

/**
 * A source file in a host-supplied project (#123/#172): editable text, or a
 * binary asset's exact bytes (e.g. an `.stl`/`.png` referenced via `import()` /
 * `surface()`). Bytes ride structured clone as a `Uint8Array` — never base64 —
 * and land as a content-less `local` source whose bytes live on the session FS
 * (ADR 0006). Exactly one of `content`/`bytes` per file. `bytes` at a
 * text-suffix path must be valid UTF-8 and are treated as `content` (so a host
 * may read every workspace file as a buffer and push uniformly).
 */
export type ProjectFile =
  | { path: string; content: string; bytes?: never }
  | { path: string; bytes: Uint8Array; content?: never };

export type OperationKind = 'syntaxCheck' | 'preview' | 'render' | 'export';

/**
 * An immutable handle to a produced artifact's exact bytes. `artifactId` keys a
 * per-session store so the bytes can be fetched by id (#197) — not a racy
 * "current output".
 */
export interface ArtifactRef {
  artifactId: string; // v4 UUID; immutable
  operationId: string;
  sourceRevision: number;
  format: string; // 'off' | 'svg' | 'stl' | '3mf' | 'glb' | …
  mediaType: string;
  size: number;
  name: string;
}

interface OperationResultBase {
  protocolVersion: number;
  sessionId: string;
  operationId: string;
  /** Echoed from the command; the #56/#99 stale-drop is unchanged. */
  sourceRevision: number;
  kind: OperationKind;
  elapsedMillis: number;
  /** Host-neutral markers (ADR 0001). */
  diagnostics: Diagnostic[];
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

/** Exactly one terminal result per `operationId`. */
export type OperationResult = OperationSuccess | OperationFailure | OperationCancelled;

/** The shared, version-independent fields of a terminal result (constructor input). */
export type OperationBase = Omit<OperationResultBase, 'protocolVersion'>;
