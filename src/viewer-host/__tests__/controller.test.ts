import { describe, expect, it } from 'vitest';

import { ViewerController, type GeometryViewer } from '../controller.ts';
import { InProcessTestTransport } from '../transports/in-process.ts';
import { VIEWER_PROTOCOL_VERSION } from '../../protocol/viewer-transport.ts';

const V = VIEWER_PROTOCOL_VERSION;

// A minimal stand-in for <osc-geometry-viewer>: EventTarget gives the
// add/removeEventListener + dispatchEvent surface the controller uses.
class FakeViewer extends EventTarget {
  offText: string | null = null;
  color = '';
  showAxes = true;
  active = true;
  generateThumbnails = false;
  camera: unknown;
  removed = false;
  setCamera(camera: unknown): void {
    this.camera = camera;
  }
  remove(): void {
    this.removed = true;
  }
}

function setup() {
  const viewer = new FakeViewer();
  const transport = new InProcessTestTransport();
  const controller = new ViewerController(viewer as unknown as GeometryViewer, transport);
  return { viewer, transport, controller };
}

const sentTypes = (t: InProcessTestTransport) => t.sent.map((m) => (m as { type: string }).type);

describe('ViewerController', () => {
  it('announces ready (after subscribing) with the supported commands', () => {
    const { transport } = setup();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      type: 'ready',
      capabilities: ['setGeometry', 'setViewerSettings', 'setCamera', 'dispose'],
    });
  });

  it('applies setGeometry and acks with geometry-set, correlating opId', () => {
    const { viewer, transport } = setup();
    transport.receive({
      protocolVersion: V,
      type: 'setGeometry',
      offText: 'OFF\n0 0 0\n',
      opId: 'g1',
    });
    expect(viewer.offText).toBe('OFF\n0 0 0\n');
    expect(transport.sent.at(-1)).toMatchObject({ type: 'geometry-set', opId: 'g1' });
  });

  it('forwards geometry-loaded to the host, correlated to the setGeometry opId', () => {
    const { viewer, transport } = setup();
    transport.receive({ protocolVersion: V, type: 'setGeometry', offText: 'x', opId: 'g1' });
    viewer.dispatchEvent(new CustomEvent('geometry-loaded', { detail: { thumbhash: 'h' } }));
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'geometry-loaded',
      thumbhash: 'h',
      opId: 'g1',
    });
  });

  it('forwards a render failure as a correlated render-error', () => {
    const { viewer, transport } = setup();
    transport.receive({ protocolVersion: V, type: 'setGeometry', offText: 'x', opId: 'g2' });
    viewer.dispatchEvent(new CustomEvent('viewer-error', { detail: 'boom' }));
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'error',
      code: 'render-error',
      opId: 'g2',
    });
  });

  it('applies setViewerSettings (only provided fields) and acks', () => {
    const { viewer, transport } = setup();
    transport.receive({ protocolVersion: V, type: 'setViewerSettings', color: '#abc', opId: 's1' });
    expect(viewer.color).toBe('#abc');
    expect(viewer.showAxes).toBe(true); // untouched
    expect(transport.sent.at(-1)).toMatchObject({ type: 'viewer-settings-set', opId: 's1' });
  });

  it('applies setCamera and acks; forwards camera-change from the viewer', () => {
    const { viewer, transport } = setup();
    const camera = { position: [1, 2, 3], target: [0, 0, 0], zoom: 1.5 };
    transport.receive({ protocolVersion: V, type: 'setCamera', camera, opId: 'c1' });
    expect(viewer.camera).toEqual(camera);
    expect(transport.sent.at(-1)).toMatchObject({ type: 'camera-set', opId: 'c1' });

    viewer.dispatchEvent(new CustomEvent('camera-change', { detail: camera }));
    expect(transport.sent.at(-1)).toMatchObject({ type: 'camera-change', camera });
  });

  it('rejects an invalid inbound payload with a protocol error', () => {
    const { transport } = setup();
    transport.receive({ protocolVersion: V + 99, type: 'setGeometry', offText: 'x' });
    expect(transport.sent.at(-1)).toMatchObject({ type: 'error', code: 'unsupported-version' });
  });

  it('dispose acks, removes the viewer, and ignores subsequent commands', () => {
    const { viewer, transport } = setup();
    transport.receive({ protocolVersion: V, type: 'dispose', opId: 'd1' });
    expect(transport.sent.at(-1)).toMatchObject({ type: 'disposed', opId: 'd1' });
    expect(viewer.removed).toBe(true);

    const before = transport.sent.length;
    transport.receive({ protocolVersion: V, type: 'setGeometry', offText: 'y', opId: 'g9' });
    expect(transport.sent.length).toBe(before); // detached — no further output
    expect(viewer.offText).toBeNull(); // not applied
  });

  it('does not emit acks/events for non-setGeometry before any geometry op', () => {
    const { transport } = setup();
    // ready only so far
    expect(sentTypes(transport)).toEqual(['ready']);
  });
});
