// Versioned, validated embed message protocol (issue #63).
//
// The embed iframe and its host page communicate over `postMessage`. This
// module is the single source of truth for the embed wire format: a protocol
// version, strict inbound validation with size limits, and structured error /
// acknowledgement envelopes. It is intentionally free of DOM/Lit dependencies
// so the validation can be unit-tested in isolation. The version-agnostic
// envelope/validation primitives live in `src/protocol/envelope.ts` (ADR 0005);
// this module is one binding over that shared core.

import { isRecord, stampOutbound, type ProtocolErrorCode } from '../protocol/envelope.ts';
import { isOpenScadValue, type OpenScadValue } from '../openscad-value.ts';

// Origin checking is generic; re-export it so embed consumers keep one import.
export { isTrustedOrigin } from '../protocol/envelope.ts';

/**
 * Wire protocol version. Inbound messages MUST carry this exact value;
 * unversioned or mismatched messages are rejected (no implicit legacy
 * acceptance). Bump on any breaking change to the inbound/outbound shapes.
 */
export const EMBED_PROTOCOL_VERSION = 2;

// Inbound size limits — guard rails against a hostile or buggy parent flooding
// the iframe. Lengths are measured in UTF-16 code units (cheap, and a safe
// over-approximation of byte intent for a DoS guard).
export const MAX_SOURCE_LENGTH = 5 * 1024 * 1024; // setModel source text
export const MAX_VAR_NAME_LENGTH = 256; // setVar variable name
export const MAX_VAR_VALUE_LENGTH = 64 * 1024; // setVar JSON-encoded value

export type InboundMessage =
  | { type: 'setModel'; source: string; requestId?: string }
  | { type: 'setVar'; name: string; value: OpenScadValue; requestId?: string }
  | { type: 'getVars'; requestId?: string }
  | { type: 'getArtifact'; requestId?: string; artifactId?: string };

/** Embed rejection codes are the shared protocol vocabulary. */
export type EmbedErrorCode = ProtocolErrorCode;

export type ValidationResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; code: EmbedErrorCode; reason: string; requestId?: string };

/** Extract a string requestId if present, so errors/acks can echo it. */
function readRequestId(data: Record<string, unknown>): string | undefined {
  return typeof data.requestId === 'string' ? data.requestId : undefined;
}

/**
 * Validate an untrusted inbound `postMessage` payload against the protocol.
 * Returns a discriminated result: either the narrowed `InboundMessage` or a
 * structured rejection the caller relays back to the host as an `error`.
 */
export function validateInbound(data: unknown): ValidationResult {
  if (!isRecord(data)) {
    return { ok: false, code: 'malformed', reason: 'message is not an object' };
  }
  const requestId = readRequestId(data);

  if (data.protocolVersion !== EMBED_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'unsupported-version',
      reason: `expected protocolVersion ${EMBED_PROTOCOL_VERSION}`,
      requestId,
    };
  }

  if (typeof data.type !== 'string') {
    return { ok: false, code: 'malformed', reason: 'missing message type', requestId };
  }

  switch (data.type) {
    case 'setModel': {
      if (typeof data.source !== 'string') {
        return { ok: false, code: 'invalid-payload', reason: 'source must be a string', requestId };
      }
      if (data.source.length > MAX_SOURCE_LENGTH) {
        return { ok: false, code: 'too-large', reason: 'source exceeds size limit', requestId };
      }
      return { ok: true, message: { type: 'setModel', source: data.source, requestId } };
    }
    case 'setVar': {
      if (typeof data.name !== 'string' || data.name.length === 0) {
        return {
          ok: false,
          code: 'invalid-payload',
          reason: 'name must be a non-empty string',
          requestId,
        };
      }
      if (data.name.length > MAX_VAR_NAME_LENGTH) {
        return { ok: false, code: 'too-large', reason: 'name exceeds size limit', requestId };
      }
      const value = data.value;
      // Reject anything that is not a valid OpenSCAD value (object, null, NaN/
      // Infinity, exotic) HERE, at the boundary, rather than letting it pass and
      // then throw deeper in the args builder (the prior divergence). This is the
      // same predicate the URL coercion and `-D` formatter use.
      if (!isOpenScadValue(value)) {
        return {
          ok: false,
          code: 'invalid-payload',
          reason: 'value must be an OpenSCAD value (string, number, boolean, or array of those)',
          requestId,
        };
      }
      // A valid value can still be enormous (a long string or big vector); bound it.
      if (JSON.stringify(value).length > MAX_VAR_VALUE_LENGTH) {
        return { ok: false, code: 'too-large', reason: 'value exceeds size limit', requestId };
      }
      return {
        ok: true,
        message: { type: 'setVar', name: data.name, value, requestId },
      };
    }
    case 'getVars':
      return { ok: true, message: { type: 'getVars', requestId } };
    case 'getArtifact': {
      // Optional: a specific artifact's immutable id (ADR 0008). Absent (or a
      // non-string) means "the current output", byte-identical to v2 behaviour.
      const artifactId = typeof data.artifactId === 'string' ? data.artifactId : undefined;
      return { ok: true, message: { type: 'getArtifact', requestId, artifactId } };
    }
    default:
      return { ok: false, code: 'unknown-type', reason: `unknown type "${data.type}"`, requestId };
  }
}

/** Stamp an outbound payload with the embed protocol version. */
export function outbound(type: string, payload: Record<string, unknown> = {}) {
  return stampOutbound(EMBED_PROTOCOL_VERSION, type, payload);
}
