// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { OscGeometryViewer } from './osc-geometry-viewer.ts';
import type { CameraState } from '../viewer/ThreeScene.ts';

const pose: CameraState = { position: [1, 2, 3], target: [0, 0, 0], zoom: 1.5 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (el: OscGeometryViewer) => el as unknown as { _pendingCamera: CameraState | null };

describe('osc-geometry-viewer setCamera (race with mount)', () => {
  it('buffers a camera commanded before the scene exists', () => {
    const el = new OscGeometryViewer();
    // Not mounted → no scene yet; the command must not be dropped.
    el.setCamera(pose);
    expect(priv(el)._pendingCamera).toEqual(pose);
  });

  it('shows the camera controls by default', () => {
    expect(new OscGeometryViewer().showControls).toBe(true);
  });
});
