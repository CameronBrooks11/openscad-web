// Transport-agnostic Layer-0 viewer controller (ADR 0005 / #143). It wires a
// `<osc-geometry-viewer>` element to a `Transport`: validates inbound commands,
// applies them to the viewer, posts the correlated acks/events, forwards the
// viewer's own events to the host, and tears everything down on `dispose`.
//
// It imports ONLY the protocol (DOM-free wire contract) — never the app shell,
// state, Monaco, or the editor — so the viewer host stays cleanly isolated.

import {
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
} from '../protocol/viewer-transport.ts';
import type { Transport } from './transport.ts';

/**
 * The structural surface the controller drives on `<osc-geometry-viewer>`. Typed
 * with the protocol's `CameraPose` (structurally identical to the component's
 * camera state) so the controller needs no import from the viewer component.
 */
export type GeometryViewer = HTMLElement & {
  offText: string | null;
  color: string;
  showAxes: boolean;
  active: boolean;
  generateThumbnails: boolean;
  setCamera(camera: CameraPose): void;
};

export class ViewerController {
  // The opId of the in-flight setGeometry, so its (async) render outcome —
  // geometry-loaded or a render error — correlates back. Only setGeometry sets
  // offText, so every load maps to one setGeometry.
  private geometryOpId: string | undefined;
  private disposed = false;

  constructor(
    private readonly viewer: GeometryViewer,
    private readonly transport: Transport,
  ) {
    viewer.addEventListener('camera-change', this.onCameraChange);
    viewer.addEventListener('geometry-loaded', this.onGeometryLoaded);
    viewer.addEventListener('viewer-error', this.onViewerError);
    // Attach the inbound handler BEFORE announcing readiness, so a host that
    // sends a command the instant it sees `ready` is never racing our listener.
    transport.subscribe(this.onInbound);
    transport.send(viewerReady(['setGeometry', 'setViewerSettings', 'setCamera', 'dispose']));
  }

  private onCameraChange = (e: Event): void => {
    this.transport.send(viewerCameraChange((e as CustomEvent<CameraPose>).detail));
  };
  private onGeometryLoaded = (e: Event): void => {
    const { thumbhash } = (e as CustomEvent<{ thumbhash?: string }>).detail;
    this.transport.send(viewerGeometryLoaded(thumbhash, this.geometryOpId));
  };
  private onViewerError = (e: Event): void => {
    // A render/parse failure of host-supplied geometry — distinct from a protocol
    // validation rejection — correlated to the setGeometry that triggered it.
    this.transport.send(
      viewerError('render-error', String((e as CustomEvent).detail), this.geometryOpId),
    );
  };

  private onInbound = (payload: unknown): void => {
    if (this.disposed) return; // commands after disposal are ignored, not queued
    const result = validateViewerInbound(payload);
    if (!result.ok) {
      this.transport.send(viewerError(result.code, result.reason, result.opId));
      return;
    }
    const msg = result.message;
    switch (msg.type) {
      case 'setGeometry':
        this.geometryOpId = msg.opId; // correlate the eventual geometry-loaded / error
        this.viewer.offText = msg.offText;
        this.transport.send(viewerGeometrySet(msg.opId)); // accepted; render outcome follows
        break;
      case 'setViewerSettings':
        if (msg.color !== undefined) this.viewer.color = msg.color;
        if (msg.showAxes !== undefined) this.viewer.showAxes = msg.showAxes;
        if (msg.active !== undefined) this.viewer.active = msg.active;
        this.transport.send(viewerSettingsSet(msg.opId));
        break;
      case 'setCamera':
        this.viewer.setCamera(msg.camera);
        this.transport.send(viewerCameraSet(msg.opId));
        break;
      case 'dispose':
        this.transport.send(viewerDisposed(msg.opId)); // ack before tearing down
        this.dispose();
        break;
    }
  };

  /** Tear down fully: stop forwarding, remove the element (disposes the GL
   *  scene), and detach the transport. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewer.removeEventListener('camera-change', this.onCameraChange);
    this.viewer.removeEventListener('geometry-loaded', this.onGeometryLoaded);
    this.viewer.removeEventListener('viewer-error', this.onViewerError);
    this.viewer.remove();
    this.transport.dispose();
  }
}
