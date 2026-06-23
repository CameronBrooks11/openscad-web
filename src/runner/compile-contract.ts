// Layer-1 compile contract (ADR 0008): a host-side, DOM-free description of a
// compile operation and its result, sitting ABOVE the CompileBackend boundary.
// The worker protocol is unchanged; these types are derived host-side and are the
// unit the host / embed / (future) MCP correlate on.

import type { Diagnostic } from '../diagnostics.ts';

export type OperationKind = 'syntaxCheck' | 'preview' | 'render' | 'export';

export interface OperationCommand {
  /** Shared envelope version (ADR 0005). */
  protocolVersion: number;
  sessionId: string;
  /** v4 UUID minted per scheduler invocation (render / checkSyntax / export). */
  operationId: string;
  /** The source/project revision the operation was submitted at (#56/#99). */
  sourceRevision: number;
  kind: OperationKind;
  // Kind-specific payload (entry path, vars, features, format) is turned into the
  // actual OpenSCAD args by the existing buildOpenScadArgs — unchanged.
}

export interface CancelCommand {
  protocolVersion: number;
  sessionId: string;
  /** The operation to cancel. */
  operationId: string;
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

/**
 * Layer-1 envelope version (ADR 0005 axis). Distinct from `EMBED_PROTOCOL_VERSION`
 * — that versions the embed *wire*; this versions the host-side operation result.
 */
export const L1_PROTOCOL_VERSION = 1;

/** Coarse failure code pending a real taxonomy when the MCP binding needs to
 *  branch on it; `reason` carries the user-facing message today. */
export const OPERATION_FAILED = 'operation_failed';

/** The shared, status-independent fields of a terminal result. */
export type OperationBase = Omit<OperationResultBase, 'protocolVersion'>;

export function operationSuccess(base: OperationBase, artifact?: ArtifactRef): OperationSuccess {
  // Omit the key entirely when artifact-less (e.g. a syntax check), so `'artifact'
  // in result` is a reliable "has bytes" probe rather than always-true.
  return {
    protocolVersion: L1_PROTOCOL_VERSION,
    status: 'success',
    ...base,
    ...(artifact ? { artifact } : {}),
  };
}

export function operationFailure(
  base: OperationBase,
  code: string,
  reason: string,
): OperationFailure {
  return { protocolVersion: L1_PROTOCOL_VERSION, status: 'error', ...base, code, reason };
}

export function operationCancelled(base: OperationBase): OperationCancelled {
  return { protocolVersion: L1_PROTOCOL_VERSION, status: 'cancelled', ...base };
}

/**
 * An immutable handle to a produced artifact's exact bytes. `artifactId` keys a
 * per-session store so `getArtifact(artifactId)` returns those exact bytes — not a
 * racy "current output".
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

/**
 * A globally-unique id (v4 UUID). Uses `crypto.randomUUID` when available, falling
 * back to `getRandomValues` — `randomUUID` requires a secure context and Safari
 * ≥ 15.4, which a LAN-IP dev preview or an older browser may not satisfy.
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // RFC 4122 v4 from 16 random bytes.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

const MEDIA_TYPES: Record<string, string> = {
  off: 'text/plain',
  svg: 'image/svg+xml',
  dxf: 'image/vnd.dxf',
  stl: 'model/stl',
  '3mf': 'model/3mf',
  glb: 'model/gltf-binary',
  amf: 'application/octet-stream',
};

/** The media type for an output format; opaque bytes when unknown. The exported
 *  Files for 3MF/GLB carry no `File.type`, so this is the source of truth. */
export function mediaTypeForFormat(format: string): string {
  return MEDIA_TYPES[format.toLowerCase()] ?? 'application/octet-stream';
}

/** The output format (lower-cased extension) of an artifact file name. */
export function formatOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}
