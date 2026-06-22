// Issue #63: versioned, validated embed protocol — malformed/oversized/unknown
// messages are rejected with structured errors; origin trust is same-origin by
// default with no acceptance of arbitrary parent origins.

import {
  validateInbound,
  isTrustedOrigin,
  outbound,
  EMBED_PROTOCOL_VERSION,
  MAX_SOURCE_LENGTH,
  MAX_VAR_NAME_LENGTH,
  MAX_VAR_VALUE_LENGTH,
} from '../protocol.ts';

const V = EMBED_PROTOCOL_VERSION;

describe('validateInbound — version gate', () => {
  it('rejects a non-object payload as malformed', () => {
    for (const bad of [null, undefined, 'setModel', 42, true]) {
      const r = validateInbound(bad);
      expect(r).toMatchObject({ ok: false, code: 'malformed' });
    }
  });

  it('rejects an unversioned message and echoes the requestId', () => {
    const r = validateInbound({ type: 'getVars', requestId: 'abc' });
    expect(r).toMatchObject({ ok: false, code: 'unsupported-version', requestId: 'abc' });
  });

  it('rejects a mismatched protocol version', () => {
    const r = validateInbound({ protocolVersion: V + 1, type: 'getVars' });
    expect(r).toMatchObject({ ok: false, code: 'unsupported-version' });
  });

  it('rejects a missing/non-string type as malformed', () => {
    expect(validateInbound({ protocolVersion: V })).toMatchObject({
      ok: false,
      code: 'malformed',
    });
    expect(validateInbound({ protocolVersion: V, type: 7 })).toMatchObject({
      ok: false,
      code: 'malformed',
    });
  });

  it('rejects an unknown type', () => {
    const r = validateInbound({ protocolVersion: V, type: 'dropTable' });
    expect(r).toMatchObject({ ok: false, code: 'unknown-type' });
  });
});

describe('validateInbound — setModel', () => {
  it('accepts a well-formed setModel and narrows it', () => {
    const r = validateInbound({
      protocolVersion: V,
      type: 'setModel',
      source: 'cube(1);',
      requestId: 'r1',
    });
    expect(r).toEqual({
      ok: true,
      message: { type: 'setModel', source: 'cube(1);', requestId: 'r1' },
    });
  });

  it('rejects a non-string source as invalid-payload', () => {
    const r = validateInbound({ protocolVersion: V, type: 'setModel', source: 123 });
    expect(r).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('rejects an oversized source as too-large', () => {
    const source = 'x'.repeat(MAX_SOURCE_LENGTH + 1);
    const r = validateInbound({ protocolVersion: V, type: 'setModel', source });
    expect(r).toMatchObject({ ok: false, code: 'too-large' });
  });
});

describe('validateInbound — setVar', () => {
  it('accepts a well-formed setVar', () => {
    const r = validateInbound({ protocolVersion: V, type: 'setVar', name: 'n', value: 5 });
    expect(r).toEqual({
      ok: true,
      message: { type: 'setVar', name: 'n', value: 5, requestId: undefined },
    });
  });

  it('rejects an empty or non-string name', () => {
    expect(
      validateInbound({ protocolVersion: V, type: 'setVar', name: '', value: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(
      validateInbound({ protocolVersion: V, type: 'setVar', name: 9, value: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
  });

  it('rejects an oversized name', () => {
    const name = 'n'.repeat(MAX_VAR_NAME_LENGTH + 1);
    expect(validateInbound({ protocolVersion: V, type: 'setVar', name, value: 1 })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
  });

  it('rejects an oversized value', () => {
    const value = 'v'.repeat(MAX_VAR_VALUE_LENGTH + 1);
    expect(validateInbound({ protocolVersion: V, type: 'setVar', name: 'n', value })).toMatchObject(
      {
        ok: false,
        code: 'too-large',
      },
    );
  });

  it('rejects a non-serialisable value', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      validateInbound({ protocolVersion: V, type: 'setVar', name: 'n', value: circular }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('rejects exotic cloneable types that bypass the JSON size limit', () => {
    // These stringify to "{}" (tiny) but carry an arbitrarily large payload,
    // so the encoded-length guard alone would not bound them.
    for (const value of [new ArrayBuffer(8), new Map(), new Set(), new Uint8Array(8), new Date()]) {
      expect(
        validateInbound({ protocolVersion: V, type: 'setVar', name: 'n', value }),
      ).toMatchObject({ ok: false, code: 'invalid-payload' });
    }
    // Nested exotic value inside an otherwise-plain object is also rejected.
    expect(
      validateInbound({
        protocolVersion: V,
        type: 'setVar',
        name: 'n',
        value: { buf: new ArrayBuffer(8) },
      }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('rejects (does not throw on) a function or symbol value', () => {
    expect(
      validateInbound({ protocolVersion: V, type: 'setVar', name: 'n', value: () => 1 }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(
      validateInbound({ protocolVersion: V, type: 'setVar', name: 'n', value: Symbol('x') }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('accepts plain nested JSON values (arrays/objects of primitives)', () => {
    const r = validateInbound({
      protocolVersion: V,
      type: 'setVar',
      name: 'vec',
      value: { a: [1, 2, 3], b: { c: true, d: 'x' }, e: null },
    });
    expect(r).toMatchObject({ ok: true });
  });
});

describe('validateInbound — read commands', () => {
  it('accepts getVars and getArtifact, echoing requestId', () => {
    expect(validateInbound({ protocolVersion: V, type: 'getVars', requestId: 'g' })).toEqual({
      ok: true,
      message: { type: 'getVars', requestId: 'g' },
    });
    expect(validateInbound({ protocolVersion: V, type: 'getArtifact' })).toEqual({
      ok: true,
      message: { type: 'getArtifact', requestId: undefined },
    });
  });
});

describe('isTrustedOrigin', () => {
  const self = 'https://app.example.com';

  it('trusts only the same origin when no parentOrigin is configured', () => {
    expect(isTrustedOrigin(self, null, self)).toBe(true);
    expect(isTrustedOrigin('https://evil.example', null, self)).toBe(false);
  });

  it('trusts only the configured parentOrigin when set', () => {
    const parent = 'https://store.example.com';
    expect(isTrustedOrigin(parent, parent, self)).toBe(true);
    expect(isTrustedOrigin(self, parent, self)).toBe(false);
    expect(isTrustedOrigin('https://evil.example', parent, self)).toBe(false);
  });

  it('never trusts the wildcard', () => {
    expect(isTrustedOrigin('*', null, self)).toBe(false);
  });
});

describe('outbound', () => {
  it('stamps the protocol version and type', () => {
    expect(outbound('ready', { vars: {} })).toEqual({
      protocolVersion: V,
      type: 'ready',
      vars: {},
    });
  });
});
