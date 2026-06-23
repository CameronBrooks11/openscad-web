// Layer-0 viewer transport (ADR 0005): the message set for a read-only,
// host-embedded geometry viewer. A host (iframe / VS Code webview) sends OFF
// geometry and viewer settings; the viewer reports ready/camera/errors. No
// compile and no artifacts — pure display. Built on the shared envelope core,
// DOM-free so the validation is unit-testable in isolation.

import { isRecord, stampOutbound, type ProtocolErrorCode } from './envelope.ts';

/** Bump on any breaking change to the L0 inbound/outbound shapes. */
export const VIEWER_PROTOCOL_VERSION = 1;

// OFF geometry text from a (trusted) host can be large; cap it as DoS hygiene.
// Measured in UTF-16 code units.
export const MAX_OFF_LENGTH = 64 * 1024 * 1024;

/** A camera pose, host-neutral (matches the viewer's CameraState shape). */
export type CameraPose = {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
};

/** Fields every inbound message may carry for correlation (ADR 0005 envelope). */
type Correlated = { opId?: string; sessionId?: string };

export type ViewerInbound =
  | ({ type: 'setGeometry'; offText: string } & Correlated)
  | ({
      type: 'setViewerSettings';
      color?: string;
      showAxes?: boolean;
      active?: boolean;
    } & Correlated)
  | ({ type: 'setCamera'; camera: CameraPose } & Correlated)
  | ({ type: 'dispose' } & Correlated);

export type ViewerValidation =
  | { ok: true; message: ViewerInbound }
  | { ok: false; code: ProtocolErrorCode; reason: string; opId?: string };

function readString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function readTriple(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber)
    ? [v[0] as number, v[1] as number, v[2] as number]
    : null;
}

function readCameraPose(v: unknown): CameraPose | null {
  if (!isRecord(v)) return null;
  const position = readTriple(v.position);
  const target = readTriple(v.target);
  if (!position || !target || !isFiniteNumber(v.zoom)) return null;
  return { position, target, zoom: v.zoom };
}

function correlation(data: Record<string, unknown>): Correlated {
  const opId = readString(data.opId);
  const sessionId = readString(data.sessionId);
  return { ...(opId ? { opId } : {}), ...(sessionId ? { sessionId } : {}) };
}

/**
 * Validate an untrusted inbound viewer message against the L0 protocol. Returns
 * the narrowed message or a structured rejection the host can be told about.
 */
export function validateViewerInbound(data: unknown): ViewerValidation {
  if (!isRecord(data)) {
    return { ok: false, code: 'malformed', reason: 'message is not an object' };
  }
  const opId = readString(data.opId);
  if (data.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'unsupported-version',
      reason: `expected protocolVersion ${VIEWER_PROTOCOL_VERSION}`,
      opId,
    };
  }
  if (typeof data.type !== 'string') {
    return { ok: false, code: 'malformed', reason: 'missing message type', opId };
  }
  const corr = correlation(data);

  switch (data.type) {
    case 'setGeometry': {
      if (typeof data.offText !== 'string') {
        return { ok: false, code: 'invalid-payload', reason: 'offText must be a string', opId };
      }
      if (data.offText.length > MAX_OFF_LENGTH) {
        return { ok: false, code: 'too-large', reason: 'offText exceeds the size limit', opId };
      }
      return { ok: true, message: { type: 'setGeometry', offText: data.offText, ...corr } };
    }
    case 'setViewerSettings': {
      const color = data.color === undefined ? undefined : readString(data.color);
      if (data.color !== undefined && color === undefined) {
        return { ok: false, code: 'invalid-payload', reason: 'color must be a string', opId };
      }
      if (data.showAxes !== undefined && typeof data.showAxes !== 'boolean') {
        return { ok: false, code: 'invalid-payload', reason: 'showAxes must be a boolean', opId };
      }
      if (data.active !== undefined && typeof data.active !== 'boolean') {
        return { ok: false, code: 'invalid-payload', reason: 'active must be a boolean', opId };
      }
      return {
        ok: true,
        message: {
          type: 'setViewerSettings',
          ...(color !== undefined ? { color } : {}),
          ...(data.showAxes !== undefined ? { showAxes: data.showAxes as boolean } : {}),
          ...(data.active !== undefined ? { active: data.active as boolean } : {}),
          ...corr,
        },
      };
    }
    case 'setCamera': {
      const camera = readCameraPose(data.camera);
      if (!camera) {
        return { ok: false, code: 'invalid-payload', reason: 'invalid camera pose', opId };
      }
      return { ok: true, message: { type: 'setCamera', camera, ...corr } };
    }
    case 'dispose':
      return { ok: true, message: { type: 'dispose', ...corr } };
    default:
      return { ok: false, code: 'unknown-type', reason: `unknown type "${data.type}"`, opId };
  }
}

// Outbound builders (viewer → host), version-stamped.

export function viewerReady(capabilities: string[]) {
  return stampOutbound(VIEWER_PROTOCOL_VERSION, 'ready', { capabilities });
}

export function viewerGeometryLoaded(thumbhash?: string, opId?: string) {
  return stampOutbound(VIEWER_PROTOCOL_VERSION, 'geometry-loaded', {
    ...(thumbhash !== undefined ? { thumbhash } : {}),
    ...(opId !== undefined ? { opId } : {}),
  });
}

export function viewerCameraChange(camera: CameraPose) {
  return stampOutbound(VIEWER_PROTOCOL_VERSION, 'camera-change', { camera });
}

export function viewerError(code: ProtocolErrorCode | string, reason: string, opId?: string) {
  return stampOutbound(VIEWER_PROTOCOL_VERSION, 'error', {
    code,
    reason,
    ...(opId !== undefined ? { opId } : {}),
  });
}

// Correlated acknowledgements that a command was applied, echoing its opId.
// `viewer-settings-set`, `camera-set`, and `disposed` are terminal (those
// commands apply synchronously). `geometry-set` only confirms the geometry was
// *accepted* — its render outcome arrives later as a `geometry-loaded` or an
// `error`, correlated by the same opId.
function ack(type: string, opId?: string) {
  return stampOutbound(VIEWER_PROTOCOL_VERSION, type, opId !== undefined ? { opId } : {});
}

export const viewerGeometrySet = (opId?: string) => ack('geometry-set', opId);
export const viewerSettingsSet = (opId?: string) => ack('viewer-settings-set', opId);
export const viewerCameraSet = (opId?: string) => ack('camera-set', opId);
export const viewerDisposed = (opId?: string) => ack('disposed', opId);
