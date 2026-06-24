import { describe, expect, it } from 'vitest';

import * as protocol from '../index.ts';

// The barrel is the public export surface a separate consumer (a VS Code
// extension) imports; this pins that surface (#176).
describe('protocol barrel', () => {
  it('exports EXACTLY the L0 public surface (no internal leaks)', () => {
    expect(protocol.VIEWER_PROTOCOL_VERSION).toBe(1);
    expect(protocol.MAX_OFF_LENGTH).toBeGreaterThan(0);
    // The full runtime (value) export set — pinned exactly, so a stray
    // `export` of an internal helper (e.g. readString) is caught.
    expect(Object.keys(protocol).sort()).toEqual(
      [
        'VIEWER_PROTOCOL_VERSION',
        'MAX_OFF_LENGTH',
        'validateViewerInbound',
        'viewerReady',
        'viewerGeometryLoaded',
        'viewerCameraChange',
        'viewerError',
        'viewerGeometrySet',
        'viewerSettingsSet',
        'viewerCameraSet',
        'viewerNamedViewSet',
        'viewerDisposed',
        'VIEWER_NAMED_VIEWS',
        'isTrustedOrigin',
        'stampOutbound',
        'isRecord',
        'isPlainJsonValue',
      ].sort(),
    );
  });
});
