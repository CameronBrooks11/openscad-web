import { describe, expect, it } from 'vitest';

import {
  SESSION_COMMANDS,
  SESSION_MAX_FILES,
  SESSION_MAX_FILE_LENGTH,
  SESSION_MAX_PATH_LENGTH,
  SESSION_PROTOCOL_VERSION,
  sessionError,
  sessionOperationResult,
  sessionReady,
  validateSessionInbound,
} from '../session-transport.ts';
import type { OperationResult } from '../session-contract.ts';

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
  });

  it('every advertised SESSION_COMMAND is a handled inbound type (capabilities ⟷ dispatch)', () => {
    const minimal: Record<(typeof SESSION_COMMANDS)[number], object> = {
      setProject: { files: [] },
      updateFile: { path: '/a', content: 'x' },
      removeFile: { path: '/a' },
      setEntryPoint: { path: '/a' },
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

  it('sessionError carries code + reason', () => {
    expect(sessionError('invalid-payload', 'bad')).toEqual({
      protocolVersion: v,
      type: 'error',
      code: 'invalid-payload',
      reason: 'bad',
    });
  });
});
