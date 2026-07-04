import { describe, expect, it } from 'vitest';

import {
  SESSION_COMMANDS,
  SESSION_MAX_FILES,
  SESSION_MAX_FILE_LENGTH,
  SESSION_MAX_ID_LENGTH,
  SESSION_MAX_PATH_LENGTH,
  SESSION_PROTOCOL_VERSION,
  sessionArtifact,
  sessionError,
  sessionLibrariesAck,
  sessionOperationResult,
  sessionProjectAck,
  sessionReady,
  validateSessionInbound,
} from '../session-transport.ts';
import type { ArtifactRef, OperationResult } from '../session-contract.ts';

const v = SESSION_PROTOCOL_VERSION;
const ok = (data: unknown) => validateSessionInbound({ protocolVersion: v, ...(data as object) });

describe('validateSessionInbound', () => {
  it('rejects non-objects, version mismatch, and missing/unknown type', () => {
    expect(validateSessionInbound(null)).toMatchObject({ ok: false, code: 'malformed' });
    expect(validateSessionInbound({ type: 'cancel' })).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
    expect(validateSessionInbound({ protocolVersion: 999, type: 'cancel' })).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
    // A v1 host against the v2 session skews loudly (the extension re-vendors
    // atomically, so this is the designed failure mode, not a compat path).
    expect(validateSessionInbound({ protocolVersion: 1, type: 'cancel' })).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
    expect(ok({ type: 7 })).toMatchObject({ ok: false, code: 'malformed' });
    expect(ok({ type: 'nope' })).toMatchObject({ ok: false, code: 'unknown-type' });
  });

  it('accepts setProject with files + optional entryPoint', () => {
    const r = ok({
      type: 'setProject',
      files: [
        { path: '/home/main.scad', content: 'cube(1);' },
        { path: '/home/lib/a.scad', content: '// a' },
      ],
      entryPoint: '/home/main.scad',
    });
    expect(r).toEqual({
      ok: true,
      message: {
        type: 'setProject',
        files: [
          { path: '/home/main.scad', content: 'cube(1);' },
          { path: '/home/lib/a.scad', content: '// a' },
        ],
        entryPoint: '/home/main.scad',
      },
    });
    // entryPoint omitted is fine.
    expect(ok({ type: 'setProject', files: [] })).toMatchObject({ ok: true });
    // Optional correlation id (#227): forwarded when present, validated when given.
    expect(ok({ type: 'setProject', files: [], requestId: 'p-1' })).toEqual({
      ok: true,
      message: { type: 'setProject', files: [], requestId: 'p-1' },
    });
    expect(ok({ type: 'setProject', files: [], requestId: 9 })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(
      ok({ type: 'setProject', files: [], requestId: 'x'.repeat(SESSION_MAX_ID_LENGTH + 1) }),
    ).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('accepts binary project files (bytes as Uint8Array) and enforces one-of content|bytes (#172)', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(
      ok({
        type: 'setProject',
        files: [
          { path: '/home/main.scad', content: 'import("part.stl");' },
          { path: '/home/part.stl', bytes },
        ],
      }),
    ).toEqual({
      ok: true,
      message: {
        type: 'setProject',
        files: [
          { path: '/home/main.scad', content: 'import("part.stl");' },
          { path: '/home/part.stl', bytes },
        ],
      },
    });
    // exactly one of content | bytes
    expect(ok({ type: 'setProject', files: [{ path: '/a', content: 'x', bytes }] })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'setProject', files: [{ path: '/a' }] })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    // bytes must be a genuine Uint8Array, not an array/ArrayBuffer/base64 string
    expect(ok({ type: 'setProject', files: [{ path: '/a', bytes: [1, 2, 3] }] })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(
      ok({ type: 'setProject', files: [{ path: '/a', bytes: new ArrayBuffer(3) }] }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('enforces the byte caps on binary files (per-file and total)', () => {
    const tooLarge = { ok: false, code: 'too-large' };
    const maxBytes = new Uint8Array(SESSION_MAX_FILE_LENGTH);
    expect(
      ok({
        type: 'setProject',
        files: [{ path: '/a', bytes: new Uint8Array(SESSION_MAX_FILE_LENGTH + 1) }],
      }),
    ).toMatchObject(tooLarge);
    // two max-size binaries exceed the total budget
    expect(
      ok({
        type: 'setProject',
        files: [
          { path: '/a', bytes: maxBytes },
          { path: '/b', bytes: maxBytes },
        ],
      }),
    ).toMatchObject(tooLarge);
    // mixed text + binary share one budget
    expect(
      ok({
        type: 'setProject',
        files: [
          { path: '/a', content: 'x'.repeat(SESSION_MAX_FILE_LENGTH) },
          { path: '/b', bytes: maxBytes },
        ],
      }),
    ).toMatchObject(tooLarge);
  });

  it('rejects malformed setProject payloads', () => {
    expect(ok({ type: 'setProject', files: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'setProject', files: [{ path: '/a' }] })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'setProject', files: [{ path: 1, content: 'x' }] })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(
      ok({ type: 'setProject', files: [{ path: '/a', content: 'x' }], entryPoint: 5 }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('enforces DoS caps (file count, per-file size, total size, path length)', () => {
    const tooLarge = { ok: false, code: 'too-large' };

    // file count
    const many = Array.from({ length: SESSION_MAX_FILES + 1 }, (_, i) => ({
      path: `/${i}`,
      content: '',
    }));
    expect(ok({ type: 'setProject', files: many })).toMatchObject(tooLarge);

    // per-file content cap — inside setProject AND on updateFile
    const maxFile = 'x'.repeat(SESSION_MAX_FILE_LENGTH);
    const overFile = maxFile + 'x';
    expect(ok({ type: 'setProject', files: [{ path: '/a', content: overFile }] })).toMatchObject(
      tooLarge,
    );
    expect(ok({ type: 'updateFile', path: '/a', content: overFile })).toMatchObject(tooLarge);

    // total project size — two max-size files exceed the total cap
    expect(
      ok({
        type: 'setProject',
        files: [
          { path: '/a', content: maxFile },
          { path: '/b', content: maxFile },
        ],
      }),
    ).toMatchObject(tooLarge);

    // path length — on every path-bearing message
    const longPath = '/' + 'x'.repeat(SESSION_MAX_PATH_LENGTH);
    expect(ok({ type: 'setProject', files: [{ path: longPath, content: '' }] })).toMatchObject(
      tooLarge,
    );
    expect(ok({ type: 'updateFile', path: longPath, content: '' })).toMatchObject(tooLarge);
    expect(ok({ type: 'removeFile', path: longPath })).toMatchObject(tooLarge);
    expect(ok({ type: 'setEntryPoint', path: longPath })).toMatchObject(tooLarge);
  });

  it('accepts updateFile / removeFile / setEntryPoint and rejects non-string paths', () => {
    expect(ok({ type: 'updateFile', path: '/home/m.scad', content: 'x' })).toMatchObject({
      ok: true,
      message: { type: 'updateFile', path: '/home/m.scad', content: 'x' },
    });
    expect(ok({ type: 'removeFile', path: '/home/m.scad' })).toMatchObject({
      ok: true,
      message: { type: 'removeFile', path: '/home/m.scad' },
    });
    expect(ok({ type: 'setEntryPoint', path: '/home/m.scad' })).toMatchObject({
      ok: true,
      message: { type: 'setEntryPoint', path: '/home/m.scad' },
    });
    expect(ok({ type: 'removeFile' })).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('accepts cancel and dispose', () => {
    expect(ok({ type: 'cancel' })).toEqual({ ok: true, message: { type: 'cancel' } });
    expect(ok({ type: 'dispose' })).toEqual({ ok: true, message: { type: 'dispose' } });
    // Targeted cancel (#226): optional requestId, validated when present.
    expect(ok({ type: 'cancel', requestId: 'r-1' })).toEqual({
      ok: true,
      message: { type: 'cancel', requestId: 'r-1' },
    });
    expect(ok({ type: 'cancel', requestId: 7 })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'cancel', requestId: 'x'.repeat(SESSION_MAX_ID_LENGTH + 1) })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
  });

  it('accepts setLibraries and validates names, paths, one-of, meta (ADR 0010)', () => {
    const lib = {
      name: 'MyLib',
      files: [{ path: 'util.scad', content: 'module u() cube(1);' }],
      meta: { version: '1.2.3', source: 'local', junk: 'dropped' },
    };
    expect(ok({ type: 'setLibraries', libraries: [lib], requestId: 'L1' })).toEqual({
      ok: true,
      message: {
        type: 'setLibraries',
        libraries: [
          {
            name: 'MyLib',
            files: [{ path: 'util.scad', content: 'module u() cube(1);' }],
            meta: { version: '1.2.3', source: 'local' }, // unknown meta keys dropped
          },
        ],
        requestId: 'L1',
      },
    });
    // Names: traversal, reserved, multi-segment, bad charset.
    for (const name of ['..', '.', 'fonts', 'home', 'a/b', 'a b', '']) {
      expect(ok({ type: 'setLibraries', libraries: [{ name, files: [] }] })).toMatchObject({
        ok: false,
        code: 'invalid-payload',
      });
    }
    // Paths: absolute, traversal, empty segment.
    for (const path of ['/abs.scad', '../out.scad', 'a//b.scad', 'a/./b.scad']) {
      expect(
        ok({ type: 'setLibraries', libraries: [{ name: 'L', files: [{ path, content: '' }] }] }),
      ).toMatchObject({ ok: false, code: 'invalid-payload' });
    }
    // Duplicate names / paths and path-prefix conflicts reject atomically.
    expect(
      ok({
        type: 'setLibraries',
        libraries: [
          { name: 'L', files: [] },
          { name: 'L', files: [] },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(
      ok({
        type: 'setLibraries',
        libraries: [
          {
            name: 'L',
            files: [
              { path: 'a', content: '' },
              { path: 'a/b.scad', content: '' },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    // exactly-one-of + invalid UTF-8 at a text suffix.
    expect(
      ok({ type: 'setLibraries', libraries: [{ name: 'L', files: [{ path: 'x.scad' }] }] }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(
      ok({
        type: 'setLibraries',
        libraries: [
          { name: 'L', files: [{ path: 'x.scad', bytes: Uint8Array.from([0xff, 0xfe]) }] },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    // Binary assets at non-text suffixes are fine.
    expect(
      ok({
        type: 'setLibraries',
        libraries: [{ name: 'L', files: [{ path: 'part.stl', bytes: Uint8Array.from([1]) }] }],
      }),
    ).toMatchObject({ ok: true });
  });

  it('setLibraries enforces its own (separate) size pool', () => {
    const big = 'x'.repeat(SESSION_MAX_FILE_LENGTH + 1);
    expect(
      ok({
        type: 'setLibraries',
        libraries: [{ name: 'L', files: [{ path: 'a.scad', content: big }] }],
      }),
    ).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('accepts render with an optional requestId (#219)', () => {
    expect(ok({ type: 'render' })).toEqual({ ok: true, message: { type: 'render' } });
    expect(ok({ type: 'render', requestId: 'r-1' })).toEqual({
      ok: true,
      message: { type: 'render', requestId: 'r-1' },
    });
    expect(ok({ type: 'render', requestId: 7 })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'render', requestId: 'x'.repeat(SESSION_MAX_ID_LENGTH + 1) })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
  });

  it('accepts export with a known format and rejects unknown/missing ones (#216)', () => {
    for (const format of ['stl', 'off', 'glb', '3mf', 'svg', 'dxf']) {
      expect(ok({ type: 'export', format })).toEqual({
        ok: true,
        message: { type: 'export', format },
      });
    }
    expect(ok({ type: 'export' })).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(ok({ type: 'export', format: 'step' })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'export', format: 7 })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    // Optional correlation id (#223): forwarded when present, validated when given.
    expect(ok({ type: 'export', format: 'stl', requestId: 'r-9' })).toEqual({
      ok: true,
      message: { type: 'export', format: 'stl', requestId: 'r-9' },
    });
    expect(ok({ type: 'export', format: 'stl', requestId: 7 })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(
      ok({ type: 'export', format: 'stl', requestId: 'x'.repeat(SESSION_MAX_ID_LENGTH + 1) }),
    ).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('accepts getArtifact and requires string artifactId + requestId', () => {
    expect(ok({ type: 'getArtifact', artifactId: 'a-1', requestId: 'r-1' })).toEqual({
      ok: true,
      message: { type: 'getArtifact', artifactId: 'a-1', requestId: 'r-1' },
    });
    // requestId is REQUIRED — the reply is correlated, not a push.
    expect(ok({ type: 'getArtifact', artifactId: 'a-1' })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'getArtifact', requestId: 'r-1' })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(ok({ type: 'getArtifact', artifactId: 7, requestId: 'r' })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    const longId = 'x'.repeat(SESSION_MAX_ID_LENGTH + 1);
    expect(ok({ type: 'getArtifact', artifactId: longId, requestId: 'r' })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
    expect(ok({ type: 'getArtifact', artifactId: 'a', requestId: longId })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
  });

  it('every advertised SESSION_COMMAND is a handled inbound type (capabilities ⟷ dispatch)', () => {
    const minimal: Record<(typeof SESSION_COMMANDS)[number], object> = {
      setProject: { files: [] },
      updateFile: { path: '/a', content: 'x' },
      removeFile: { path: '/a' },
      setEntryPoint: { path: '/a' },
      setLibraries: { libraries: [] },
      render: {},
      export: { format: 'stl' },
      getArtifact: { artifactId: 'a', requestId: 'r' },
      cancel: {},
      dispose: {},
    };
    for (const cmd of SESSION_COMMANDS) {
      expect(ok({ type: cmd, ...minimal[cmd] })).toMatchObject({ ok: true });
    }
  });
});

describe('outbound builders', () => {
  it('sessionReady advertises capabilities, version-stamped', () => {
    expect(sessionReady(SESSION_COMMANDS)).toEqual({
      protocolVersion: v,
      type: 'ready',
      capabilities: [...SESSION_COMMANDS],
    });
  });

  it('sessionOperationResult wraps the result with the session envelope version', () => {
    const result: OperationResult = {
      protocolVersion: 1, // the nested L1 version, independent of the wire version
      sessionId: 's1',
      operationId: 'op1',
      sourceRevision: 3,
      kind: 'preview',
      elapsedMillis: 12,
      diagnostics: [],
      logText: '',
      status: 'success',
    };
    expect(sessionOperationResult(result)).toEqual({
      protocolVersion: v,
      type: 'operation-result',
      result,
    });
  });

  it('sessionArtifact carries ref + bytes when found, available:false when not', () => {
    const artifact: ArtifactRef = {
      artifactId: 'a-1',
      operationId: 'op-1',
      sourceRevision: 3,
      format: 'stl',
      mediaType: 'model/stl',
      size: 3,
      name: 'out.stl',
    };
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sessionArtifact('r-1', { artifact, bytes })).toEqual({
      protocolVersion: v,
      type: 'artifact',
      requestId: 'r-1',
      available: true,
      artifact,
      bytes,
    });
    // Bytes stay a Uint8Array (structured clone), NEVER a base64 string.
    const reply = sessionArtifact('r-1', { artifact, bytes }) as Record<string, unknown>;
    expect(reply.bytes).toBeInstanceOf(Uint8Array);
    expect(sessionArtifact('r-2', undefined)).toEqual({
      protocolVersion: v,
      type: 'artifact',
      requestId: 'r-2',
      available: false,
    });
  });

  it('sessionLibrariesAck echoes the id with the assigned revision (ADR 0010)', () => {
    expect(sessionLibrariesAck('L1', 9)).toEqual({
      protocolVersion: v,
      type: 'libraries-ack',
      requestId: 'L1',
      sourceRevision: 9,
    });
  });

  it('sessionProjectAck echoes the id with the assigned revision (#227)', () => {
    expect(sessionProjectAck('p-1', 7)).toEqual({
      protocolVersion: v,
      type: 'project-ack',
      requestId: 'p-1',
      sourceRevision: 7,
    });
  });

  it('sessionError carries code + reason', () => {
    expect(sessionError('invalid-payload', 'bad')).toEqual({
      protocolVersion: v,
      type: 'error',
      code: 'invalid-payload',
      reason: 'bad',
    });
  });
});
