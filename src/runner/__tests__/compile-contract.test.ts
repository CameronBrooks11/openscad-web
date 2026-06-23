import { describe, expect, it } from 'vitest';

import {
  formatOfName,
  mediaTypeForFormat,
  newId,
  operationCancelled,
  operationFailure,
  operationSuccess,
  L1_PROTOCOL_VERSION,
  OPERATION_FAILED,
  type OperationBase,
} from '../compile-contract.ts';

describe('newId', () => {
  it('mints unique, well-formed v4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000); // no collisions
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of ids) expect(id).toMatch(uuid);
  });
});

describe('mediaTypeForFormat', () => {
  it('maps known formats and defaults unknown ones to octet-stream', () => {
    expect(mediaTypeForFormat('svg')).toBe('image/svg+xml');
    expect(mediaTypeForFormat('GLB')).toBe('model/gltf-binary'); // case-insensitive
    expect(mediaTypeForFormat('3mf')).toBe('model/3mf');
    expect(mediaTypeForFormat('wat')).toBe('application/octet-stream');
  });
});

describe('formatOfName', () => {
  it('extracts the lower-cased extension', () => {
    expect(formatOfName('part.STL')).toBe('stl');
    expect(formatOfName('model.scad')).toBe('scad');
    expect(formatOfName('noext')).toBe('');
  });
});

describe('OperationResult builders (ADR 0008 slice 4)', () => {
  const base: OperationBase = {
    sessionId: 's',
    operationId: 'o',
    sourceRevision: 3,
    kind: 'render',
    elapsedMillis: 42,
    diagnostics: [],
    logText: 'log',
  };

  it('operationSuccess stamps version + status and carries an optional artifact', () => {
    const artifact = {
      artifactId: 'a',
      operationId: 'o',
      sourceRevision: 3,
      format: 'off',
      mediaType: 'text/plain',
      size: 5,
      name: 'm.off',
    };
    const result = operationSuccess(base, artifact);
    expect(result.protocolVersion).toBe(L1_PROTOCOL_VERSION);
    expect(result.status).toBe('success');
    expect(result.operationId).toBe('o');
    expect(result.artifact).toBe(artifact);
    // No artifact for an artifact-less operation (e.g. a syntax check).
    expect(operationSuccess(base).artifact).toBeUndefined();
  });

  it('operationFailure carries the code + reason', () => {
    const result = operationFailure(base, OPERATION_FAILED, 'it broke');
    expect(result.status).toBe('error');
    expect(result.code).toBe(OPERATION_FAILED);
    expect(result.reason).toBe('it broke');
  });

  it('operationCancelled has no artifact/code/reason', () => {
    const result = operationCancelled(base);
    expect(result.status).toBe('cancelled');
    expect(result.protocolVersion).toBe(L1_PROTOCOL_VERSION);
    expect('artifact' in result).toBe(false);
  });
});
