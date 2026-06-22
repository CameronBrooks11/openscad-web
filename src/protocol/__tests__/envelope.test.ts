import { describe, expect, it } from 'vitest';

import { isPlainJsonValue, isRecord, isTrustedOrigin, stampOutbound } from '../envelope.ts';

describe('isRecord', () => {
  it('accepts plain objects and arrays, rejects null/primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(3)).toBe(false);
  });
});

describe('isPlainJsonValue', () => {
  it('accepts JSON primitives, arrays, and plain objects', () => {
    expect(isPlainJsonValue('s')).toBe(true);
    expect(isPlainJsonValue(true)).toBe(true);
    expect(isPlainJsonValue(1.5)).toBe(true);
    expect(isPlainJsonValue(null)).toBe(true);
    expect(isPlainJsonValue([1, 'a', { b: 2 }])).toBe(true);
    expect(isPlainJsonValue({ a: { b: [3] } })).toBe(true);
  });

  it('rejects non-finite numbers and non-JSON / exotic types', () => {
    expect(isPlainJsonValue(NaN)).toBe(false);
    expect(isPlainJsonValue(Infinity)).toBe(false);
    expect(isPlainJsonValue(undefined)).toBe(false);
    expect(isPlainJsonValue(() => 0)).toBe(false);
    expect(isPlainJsonValue(new Map())).toBe(false);
    expect(isPlainJsonValue(new Uint8Array([1]))).toBe(false);
    expect(isPlainJsonValue(new Date())).toBe(false);
    expect(isPlainJsonValue([1, () => 0])).toBe(false); // exotic nested
  });
});

describe('isTrustedOrigin', () => {
  it('trusts only self-origin when no parentOrigin is configured', () => {
    expect(isTrustedOrigin('https://a.test', null, 'https://a.test')).toBe(true);
    expect(isTrustedOrigin('https://b.test', null, 'https://a.test')).toBe(false);
  });

  it('trusts only the configured parentOrigin when set', () => {
    expect(isTrustedOrigin('https://p.test', 'https://p.test', 'https://a.test')).toBe(true);
    expect(isTrustedOrigin('https://a.test', 'https://p.test', 'https://a.test')).toBe(false);
  });
});

describe('stampOutbound', () => {
  it('stamps the version and merges the payload under the type', () => {
    expect(stampOutbound(7, 'ready', { capabilities: ['view'] })).toEqual({
      protocolVersion: 7,
      type: 'ready',
      capabilities: ['view'],
    });
  });

  it('defaults to an empty payload', () => {
    expect(stampOutbound(1, 'ping')).toEqual({ protocolVersion: 1, type: 'ping' });
  });
});
