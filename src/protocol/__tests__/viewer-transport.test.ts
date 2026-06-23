import { describe, expect, it } from 'vitest';

import {
  MAX_OFF_LENGTH,
  VIEWER_PROTOCOL_VERSION,
  validateViewerInbound,
  viewerCameraChange,
  viewerCameraSet,
  viewerDisposed,
  viewerError,
  viewerGeometryLoaded,
  viewerGeometrySet,
  viewerReady,
  viewerSettingsSet,
  type CameraPose,
} from '../viewer-transport.ts';

const v = VIEWER_PROTOCOL_VERSION;
const pose: CameraPose = { position: [1, 2, 3], target: [0, 0, 0], zoom: 1.5 };

describe('validateViewerInbound', () => {
  it('rejects non-objects and version mismatches', () => {
    expect(validateViewerInbound(null)).toMatchObject({ ok: false, code: 'malformed' });
    expect(validateViewerInbound({ type: 'dispose' })).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
    expect(validateViewerInbound({ protocolVersion: 999, type: 'dispose' })).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
  });

  it('rejects an unknown type and echoes opId on errors', () => {
    const r = validateViewerInbound({ protocolVersion: v, type: 'nope', opId: 'x1' });
    expect(r).toMatchObject({ ok: false, code: 'unknown-type', opId: 'x1' });
  });

  it('accepts setGeometry and carries opId/sessionId', () => {
    const r = validateViewerInbound({
      protocolVersion: v,
      type: 'setGeometry',
      offText: 'OFF\n0 0 0\n',
      opId: 'op1',
      sessionId: 's1',
    });
    expect(r).toEqual({
      ok: true,
      message: { type: 'setGeometry', offText: 'OFF\n0 0 0\n', opId: 'op1', sessionId: 's1' },
    });
  });

  it('rejects a non-string or oversized offText', () => {
    expect(
      validateViewerInbound({ protocolVersion: v, type: 'setGeometry', offText: 42 }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(
      validateViewerInbound({
        protocolVersion: v,
        type: 'setGeometry',
        offText: 'x'.repeat(MAX_OFF_LENGTH + 1),
      }),
    ).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('accepts setViewerSettings with only the provided fields', () => {
    const r = validateViewerInbound({
      protocolVersion: v,
      type: 'setViewerSettings',
      color: '#fff',
      showAxes: false,
    });
    expect(r).toEqual({
      ok: true,
      message: { type: 'setViewerSettings', color: '#fff', showAxes: false },
    });
  });

  it('rejects wrong field types in setViewerSettings', () => {
    expect(
      validateViewerInbound({ protocolVersion: v, type: 'setViewerSettings', showAxes: 'yes' }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(
      validateViewerInbound({ protocolVersion: v, type: 'setViewerSettings', color: 3 }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
  });

  it('accepts a valid camera pose and rejects malformed ones', () => {
    expect(validateViewerInbound({ protocolVersion: v, type: 'setCamera', camera: pose })).toEqual({
      ok: true,
      message: { type: 'setCamera', camera: pose },
    });
    for (const bad of [
      { position: [1, 2], target: [0, 0, 0], zoom: 1 }, // short triple
      { position: [1, 2, 3], target: [0, 0, 0], zoom: 'x' }, // bad zoom
      { position: [1, 2, NaN], target: [0, 0, 0], zoom: 1 }, // non-finite
      { target: [0, 0, 0], zoom: 1 }, // missing position
      'nope',
    ]) {
      expect(
        validateViewerInbound({ protocolVersion: v, type: 'setCamera', camera: bad }),
      ).toMatchObject({ ok: false, code: 'invalid-payload' });
    }
  });

  it('accepts dispose', () => {
    expect(validateViewerInbound({ protocolVersion: v, type: 'dispose' })).toEqual({
      ok: true,
      message: { type: 'dispose' },
    });
  });
});

describe('outbound builders', () => {
  it('stamp the version and shape', () => {
    expect(viewerReady(['view'])).toEqual({
      protocolVersion: v,
      type: 'ready',
      capabilities: ['view'],
    });
    expect(viewerGeometryLoaded('hash', 'op7')).toEqual({
      protocolVersion: v,
      type: 'geometry-loaded',
      thumbhash: 'hash',
      opId: 'op7',
    });
    expect(viewerGeometryLoaded()).toEqual({ protocolVersion: v, type: 'geometry-loaded' });
    expect(viewerCameraChange(pose)).toEqual({
      protocolVersion: v,
      type: 'camera-change',
      camera: pose,
    });
    expect(viewerError('invalid-payload', 'bad', 'op9')).toEqual({
      protocolVersion: v,
      type: 'error',
      code: 'invalid-payload',
      reason: 'bad',
      opId: 'op9',
    });
  });

  it('correlated acks echo opId and omit it when absent', () => {
    expect(viewerGeometrySet('a')).toEqual({ protocolVersion: v, type: 'geometry-set', opId: 'a' });
    expect(viewerSettingsSet('b')).toEqual({
      protocolVersion: v,
      type: 'viewer-settings-set',
      opId: 'b',
    });
    expect(viewerCameraSet('c')).toEqual({ protocolVersion: v, type: 'camera-set', opId: 'c' });
    expect(viewerDisposed('d')).toEqual({ protocolVersion: v, type: 'disposed', opId: 'd' });
    expect(viewerGeometrySet()).toEqual({ protocolVersion: v, type: 'geometry-set' });
  });
});
