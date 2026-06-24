// Layer-1 compile contract (ADR 0008): the in-process scheduler COMMAND shapes and
// the result CONSTRUCTORS, sitting ABOVE the CompileBackend boundary. The DOM-free
// result/payload TYPES (`OperationResult` family, `Diagnostic`, `ArtifactRef`,
// `OperationKind`, `L1_PROTOCOL_VERSION`) now live in src/protocol/session-contract.ts
// so the protocol stays distributable; they are re-exported here for existing
// importers, who are unaffected.

import {
  L1_PROTOCOL_VERSION,
  type ArtifactRef,
  type OperationBase,
  type OperationCancelled,
  type OperationFailure,
  type OperationKind,
  type OperationSuccess,
} from '../protocol/session-contract.ts';

export {
  L1_PROTOCOL_VERSION,
  type ArtifactRef,
  type OperationBase,
  type OperationCancelled,
  type OperationFailure,
  type OperationKind,
  type OperationResult,
  type OperationSuccess,
} from '../protocol/session-contract.ts';

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

/** Coarse failure code pending a real taxonomy when the MCP binding needs to
 *  branch on it; `reason` carries the user-facing message today. */
export const OPERATION_FAILED = 'operation_failed';

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
