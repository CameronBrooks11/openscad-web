// Layer-1 session transport (ADR 0005/0009): the message set a host (a VS Code
// webview) speaks to drive an `OpenScadSession`'s `ProjectContract` — push a
// project, edit/remove files, change the entry point, cancel, dispose — and
// receive the session's compile operation results. Built on the shared envelope
// core, DOM-free, so validation is unit-testable in isolation. The session host
// (the controller in the viewer-host tier, #192) binds these messages to the
// in-process `ProjectContract` + the Model's `'operation'` event.
//
// Render is internal to the session webview (it embeds the viewer, #179), so this
// protocol carries NO geometry/artifact bytes for display. Bytes cross the wire in
// exactly two places: inbound, a project file's binary-asset `bytes` (#172), and
// outbound, the `getArtifact` → `artifact` round-trip (#197) fetching a produced
// artifact's exact bytes BY ID to save it. Bytes always travel as a `Uint8Array`
// via structured clone — never base64 (VS Code webview `postMessage` has revived
// typed arrays since ~1.57).

import { isRecord, stampOutbound, type ProtocolErrorCode } from './envelope.ts';
import type { ArtifactRef, OperationResult, ProjectFile } from './session-contract.ts';

/**
 * Bump on any breaking change to the session INBOUND/OUTBOUND message shapes. This
 * is the session WIRE version — distinct from `L1_PROTOCOL_VERSION`, which versions
 * the nested `OperationResult` payload (ADR 0005: each binding owns its version).
 *
 * v2: added the `getArtifact` command + `artifact` reply (#197), binary project
 * files (#172), and the `export` command (#216) — one bump; v2 never shipped
 * between them.
 */
export const SESSION_PROTOCOL_VERSION = 2;

// DoS pre-filter caps (the host channel is trusted, but a runaway extension must
// not OOM the worker). These mirror the engine's own caps in src/fs/project-path.ts
// (MAX_PROJECT_FILE_COUNT = 2000, MAX_PROJECT_TOTAL_BYTES = 64 MiB) — the protocol
// need not match exactly; `ProjectStore` re-validates and is the real enforcer.
// Lengths are UTF-16 code units (as MAX_OFF_LENGTH in viewer-transport.ts).
export const SESSION_MAX_FILE_LENGTH = 32 * 1024 * 1024;
export const SESSION_MAX_FILES = 2048;
export const SESSION_MAX_TOTAL_LENGTH = 64 * 1024 * 1024;
export const SESSION_MAX_PATH_LENGTH = 4096;
/** Cap for opaque ids (`artifactId` is a v4 UUID, `requestId` host-chosen). */
export const SESSION_MAX_ID_LENGTH = 256;

/** The inbound command types, advertised in `ready` so a host can feature-detect. */
export const SESSION_COMMANDS = [
  'setProject',
  'updateFile',
  'removeFile',
  'setEntryPoint',
  'export',
  'getArtifact',
  'cancel',
  'dispose',
] as const;

/** The export formats a host may request (#216) — the app's own format set.
 *  3D: stl/off/glb/3mf; 2D: svg/dxf. The session exports the CURRENT model's
 *  dimensionality; a mismatched request (e.g. `svg` for a 3D model) terminates
 *  as an export-kind failure result, never silence. */
export const SESSION_EXPORT_FORMATS = ['stl', 'off', 'glb', '3mf', 'svg', 'dxf'] as const;
export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

/** Host → session. Mirrors `ProjectContract` (src/state/project-contract.ts) 1:1,
 *  plus `export` (#216), `getArtifact` (bytes-by-id, #197), and `dispose` for
 *  worker teardown. */
export type SessionInbound =
  | { type: 'setProject'; files: ProjectFile[]; entryPoint?: string }
  | { type: 'updateFile'; path: string; content: string }
  | { type: 'removeFile'; path: string }
  | { type: 'setEntryPoint'; path: string }
  | { type: 'export'; format: SessionExportFormat }
  | { type: 'getArtifact'; artifactId: string; requestId: string }
  | { type: 'cancel' }
  | { type: 'dispose' };

export type SessionValidation =
  { ok: true; message: SessionInbound } | { ok: false; code: ProtocolErrorCode; reason: string };

function readString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function err(code: ProtocolErrorCode, reason: string): SessionValidation {
  return { ok: false, code, reason };
}

/**
 * Validate a `ProjectFile[]` payload: shape + the DoS caps. Each file is text
 * (`content`, editable) OR a binary asset (`bytes` as a `Uint8Array` via
 * structured clone, #172) — exactly one of the two. The size budget mixes
 * UTF-16 code units (text) and bytes (binary); it is a pre-filter, not the real
 * enforcer (`ProjectStore` re-validates paths; the engine owns the FS budget).
 */
function readProjectFiles(value: unknown): SessionValidation | { files: ProjectFile[] } {
  if (!Array.isArray(value)) return err('invalid-payload', 'files must be an array');
  if (value.length > SESSION_MAX_FILES) return err('too-large', 'too many files');
  const files: ProjectFile[] = [];
  let total = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return err('invalid-payload', 'each file must be an object');
    const path = readString(entry.path);
    if (path === undefined) return err('invalid-payload', 'file path must be a string');
    if (path.length > SESSION_MAX_PATH_LENGTH) return err('too-large', 'a file path is too long');
    const hasContent = entry.content !== undefined;
    const hasBytes = entry.bytes !== undefined;
    if (hasContent === hasBytes) {
      return err('invalid-payload', 'each file must have exactly one of content or bytes');
    }
    if (hasBytes) {
      const bytes = entry.bytes; // read once — validate and forward one value
      if (!(bytes instanceof Uint8Array)) {
        return err('invalid-payload', 'file bytes must be a Uint8Array');
      }
      if (bytes.byteLength > SESSION_MAX_FILE_LENGTH) {
        return err('too-large', 'a file is too large');
      }
      total += bytes.byteLength + path.length;
      if (total > SESSION_MAX_TOTAL_LENGTH) {
        return err('too-large', 'project exceeds the size limit');
      }
      files.push({ path, bytes });
      continue;
    }
    const content = readString(entry.content);
    if (content === undefined) return err('invalid-payload', 'file content must be a string');
    if (content.length > SESSION_MAX_FILE_LENGTH) return err('too-large', 'a file is too large');
    total += content.length + path.length;
    if (total > SESSION_MAX_TOTAL_LENGTH) return err('too-large', 'project exceeds the size limit');
    files.push({ path, content });
  }
  return { files };
}

/**
 * Validate an untrusted inbound session message against the L1 protocol. Returns
 * the narrowed message or a structured rejection the host can be told about. Shape
 * + size only — path safety / canonicalization is the in-process `ProjectStore`'s
 * job (and lives behind the protocol's import fence).
 */
export function validateSessionInbound(data: unknown): SessionValidation {
  if (!isRecord(data)) return err('malformed', 'message is not an object');
  if (data.protocolVersion !== SESSION_PROTOCOL_VERSION) {
    return err('unsupported-version', `expected protocolVersion ${SESSION_PROTOCOL_VERSION}`);
  }
  if (typeof data.type !== 'string') return err('malformed', 'missing message type');

  switch (data.type) {
    case 'setProject': {
      const result = readProjectFiles(data.files);
      if ('ok' in result) return result; // a rejection
      const entryPoint = data.entryPoint === undefined ? undefined : readString(data.entryPoint);
      if (data.entryPoint !== undefined && entryPoint === undefined) {
        return err('invalid-payload', 'entryPoint must be a string');
      }
      return {
        ok: true,
        message: {
          type: 'setProject',
          files: result.files,
          ...(entryPoint !== undefined ? { entryPoint } : {}),
        },
      };
    }
    case 'updateFile': {
      const path = readString(data.path);
      const content = readString(data.content);
      if (path === undefined || content === undefined) {
        return err('invalid-payload', 'path and content must be strings');
      }
      if (path.length > SESSION_MAX_PATH_LENGTH) return err('too-large', 'path is too long');
      if (content.length > SESSION_MAX_FILE_LENGTH) return err('too-large', 'file is too large');
      return { ok: true, message: { type: 'updateFile', path, content } };
    }
    case 'removeFile':
    case 'setEntryPoint': {
      const path = readString(data.path);
      if (path === undefined) return err('invalid-payload', 'path must be a string');
      if (path.length > SESSION_MAX_PATH_LENGTH) return err('too-large', 'path is too long');
      return { ok: true, message: { type: data.type, path } };
    }
    case 'export': {
      // Fire-and-observe like the mutation commands: the terminal arrives on the
      // push stream as a `kind: 'export'` OperationResult (success with an
      // ArtifactRef to then fetch via getArtifact, or a failure).
      const format = readString(data.format);
      if (format === undefined || !(SESSION_EXPORT_FORMATS as readonly string[]).includes(format)) {
        return err('invalid-payload', `format must be one of ${SESSION_EXPORT_FORMATS.join(', ')}`);
      }
      return { ok: true, message: { type: 'export', format: format as SessionExportFormat } };
    }
    case 'getArtifact': {
      // Unlike the push-stream commands, this is a correlated request/response:
      // the reply echoes `requestId`, so it is REQUIRED (a host with concurrent
      // fetches could not otherwise route the replies).
      const artifactId = readString(data.artifactId);
      const requestId = readString(data.requestId);
      if (artifactId === undefined || requestId === undefined) {
        return err('invalid-payload', 'artifactId and requestId must be strings');
      }
      if (artifactId.length > SESSION_MAX_ID_LENGTH || requestId.length > SESSION_MAX_ID_LENGTH) {
        return err('too-large', 'an id is too long');
      }
      return { ok: true, message: { type: 'getArtifact', artifactId, requestId } };
    }
    case 'cancel':
      return { ok: true, message: { type: 'cancel' } };
    case 'dispose':
      return { ok: true, message: { type: 'dispose' } };
    default:
      return err('unknown-type', `unknown type "${data.type}"`);
  }
}

// Outbound builders (session → host), version-stamped with the session WIRE version.

/** Announce readiness + the supported inbound commands (host feature-detection). */
export function sessionReady(capabilities: readonly string[]) {
  return stampOutbound(SESSION_PROTOCOL_VERSION, 'ready', { capabilities: [...capabilities] });
}

/**
 * Forward a terminal compile result. These are a PUSH STREAM, NOT 1:1 with
 * commands: one edit fans out to multiple results (syntaxCheck + preview render +
 * …), each a distinct `operationId`. The host correlates by `sourceRevision` +
 * `kind` (e.g. render the highest-revision `preview`/`render`), never by command.
 * The nested `result` keeps its own `L1_PROTOCOL_VERSION`.
 */
export function sessionOperationResult(result: OperationResult) {
  return stampOutbound(SESSION_PROTOCOL_VERSION, 'operation-result', { result });
}

/** The correlated reply to `getArtifact` — exported so a host's vendored `.d.ts`
 *  carries the exact reply shape instead of a hand-maintained mirror. */
export type SessionArtifactReply =
  | {
      protocolVersion: number;
      type: 'artifact';
      requestId: string;
      available: true;
      artifact: ArtifactRef;
      bytes: Uint8Array;
    }
  | { protocolVersion: number; type: 'artifact'; requestId: string; available: false };

/**
 * Reply to `getArtifact` (#197): the artifact's immutable identity + its EXACT
 * bytes, or `available: false` when the id is unknown, evicted from the
 * per-session store (ADR 0008), or its blob read failed. Echoes the request's
 * `requestId`. The bytes ride structured clone as a `Uint8Array` — the one place
 * bytes cross this wire (display renders in-process and never does).
 */
export function sessionArtifact(
  requestId: string,
  resolved: { artifact: ArtifactRef; bytes: Uint8Array } | undefined,
): SessionArtifactReply {
  return resolved
    ? {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: 'artifact',
        requestId,
        available: true,
        artifact: resolved.artifact,
        bytes: resolved.bytes,
      }
    : { protocolVersion: SESSION_PROTOCOL_VERSION, type: 'artifact', requestId, available: false };
}

/** A protocol-level rejection of an inbound message (validation failure). */
export function sessionError(code: ProtocolErrorCode | string, reason: string) {
  return stampOutbound(SESSION_PROTOCOL_VERSION, 'error', { code, reason });
}
