// A model-independent 3D geometry viewer. It owns the Three.js scene lifecycle
// and renders OFF geometry passed as plain text, with camera-preset controls.
// It has no dependency on the application Model/State — inputs come in as
// properties and changes go out as events, so it can be reused in isolation.
//
// Inputs (properties): offText, color, showAxes, camera (applied on mount only).
// Events: `camera-change` (CameraState), `geometry-loaded` ({ thumbhash }),
// `context-lost`, `viewer-error` (the load error). The host listens to whichever
// it needs; in this app `osc-viewer-panel` consumes camera-change/geometry-loaded.
import { LitElement, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ThreeScene, NAMED_POSITIONS, type CameraState } from '../viewer/ThreeScene.ts';
import { offToBufferGeometry } from '../viewer/off-loader.ts';
import { parseOff } from '../../io/import_off.ts';
import { imageToThumbhash } from '../../io/image_hashes.ts';

const DEFAULT_COLOR = '#f9d72c';

@customElement('osc-geometry-viewer')
export class OscGeometryViewer extends LitElement {
  // Light DOM so Three.js can size the canvas and data-testid stays queryable.
  protected override createRenderRoot() {
    return this;
  }

  /** OFF geometry as text. Setting it (re)loads the mesh. */
  @property({ attribute: false }) offText: string | null = null;
  @property() color = DEFAULT_COLOR;
  @property({ type: Boolean }) showAxes = true;
  /** When false, the scene is suspended (no rendering) until reactivated. */
  @property({ type: Boolean }) active = true;
  /** Initial camera; applied on mount only — the user drives it afterward. */
  @property({ attribute: false }) camera: CameraState | null = null;
  /**
   * When true (default), a thumbnail hash is computed after each load and
   * included in the `geometry-loaded` event. A host that only displays geometry
   * (no preview placeholder) can set this false to skip the hashing work; the
   * `geometry-loaded` event still fires (without a thumbhash) as the load signal.
   */
  @property({ type: Boolean }) generateThumbnails = true;
  /** Show the built-in camera-preset buttons. A host with its own UI can hide them. */
  @property({ type: Boolean }) showControls = true;
  /** Scene background (any CSS/Three colour). Defaults to the viewer's dark grey. */
  @property() background?: string;

  @state() private _toastMessage: string | null = null;

  private _scene: ThreeScene | null = null;
  private _ro: ResizeObserver | null = null;
  private _container: HTMLDivElement | null = null;
  private _loadedOffText: string | null = null;
  // A camera pose commanded via setCamera() before the scene exists, applied
  // once firstUpdated() builds it (avoids dropping a command that races mount).
  private _pendingCamera: CameraState | null = null;
  // Monotonic load id: a newer _loadGeometry supersedes an older one whose
  // thumbnail hashing is still in flight, so a slow older hash cannot overwrite
  // the newer geometry's preview.
  private _loadSeq = 0;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  override firstUpdated() {
    const container = this.querySelector('[data-testid="viewer-canvas"]') as HTMLDivElement | null;
    if (!container) return;
    this._container = container;

    const scene = new ThreeScene(container);
    this._scene = scene;
    if (this.background) scene.setBackground(this.background);
    if (this.camera) scene.applyCameraState(this.camera);
    // A setCamera() that arrived before the scene existed wins over the initial
    // camera property (it was an explicit host command).
    if (this._pendingCamera) {
      scene.applyCameraState(this._pendingCamera, { silent: true });
      this._pendingCamera = null;
    }
    scene.setAxesVisible(this.showAxes);
    scene.onCameraChange = (cam) =>
      this.dispatchEvent(new CustomEvent<CameraState>('camera-change', { detail: cam }));
    scene.onContextLost = () => this.dispatchEvent(new CustomEvent('context-lost'));
    scene.start();

    this._ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        scene.resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    this._ro.observe(container);

    if (!this.active) scene.setActive(false);
    if (this.offText) this._loadGeometry(this.offText);
  }

  override updated(changed: PropertyValues) {
    const scene = this._scene;
    if (!scene) return;
    if (changed.has('active')) scene.setActive(this.active);
    if (changed.has('showAxes')) scene.setAxesVisible(this.showAxes);
    if (changed.has('color') && this.color) scene.setModelColor(this.color);
    if (changed.has('background') && this.background) scene.setBackground(this.background);
    if (changed.has('offText') && this.offText && this.offText !== this._loadedOffText) {
      this._loadGeometry(this.offText);
    }
    // `camera` is intentionally NOT re-applied on change: it is an initial value
    // only; echoing the model's camera back while the user is interacting would
    // fight their input.
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._ro?.disconnect();
    this._ro = null;
    this._scene?.dispose();
    this._scene = null;
    this._container = null;
    if (this._toastTimer) clearTimeout(this._toastTimer);
  }

  /**
   * Imperatively set the camera pose (e.g. a host command: top view, restore
   * pose). Applied silently so it does not echo back as a `camera-change` event.
   * Unlike the mount-only `camera` property, this works at any time.
   */
  setCamera(camera: CameraState): void {
    if (this._scene) this._scene.applyCameraState(camera, { silent: true });
    else this._pendingCamera = camera; // applied when firstUpdated() builds the scene
  }

  private async _loadGeometry(offText: string) {
    const scene = this._scene;
    if (!scene) return;
    this._loadedOffText = offText;
    const loadSeq = ++this._loadSeq;
    try {
      const geometry = offToBufferGeometry(parseOff(offText));
      scene.loadGeometry(geometry, this.color);
      if (this._container) this._container.dataset.geometryLoaded = 'true';

      if (!this.generateThumbnails) {
        // Geometry is loaded; signal the host without the (skipped) thumbnail.
        this.dispatchEvent(new CustomEvent('geometry-loaded', { detail: {} }));
        return;
      }

      // Render the new geometry before capturing so the thumbnail isn't stale.
      scene.renderOnce();
      const dataUrl = scene.renderer.domElement.toDataURL('image/png');
      const thumbhash = await imageToThumbhash(dataUrl);
      // Bail if torn down OR superseded by a newer geometry while hashing.
      if (this._scene !== scene || this._loadSeq !== loadSeq) return;
      this.dispatchEvent(new CustomEvent('geometry-loaded', { detail: { thumbhash } }));
    } catch (err) {
      console.error('Error loading OFF geometry:', err);
      this.dispatchEvent(new CustomEvent('viewer-error', { detail: err }));
    }
  }

  private _showToast(msg: string) {
    this._toastMessage = msg;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastMessage = null;
    }, 1500);
  }

  override render() {
    return html`
      <style>
        osc-geometry-viewer {
          display: block;
          position: relative;
          flex: 1;
          width: 100%;
          height: 100%;
        }
        osc-geometry-viewer .osc-toast {
          position: absolute;
          top: 8px;
          right: 8px;
          background: var(--osc-viewer-control-background, var(--osc-overlay, rgba(0, 0, 0, 0.6)));
          color: var(--osc-viewer-control-foreground, var(--osc-on-accent, #fff));
          padding: 4px 12px;
          border-radius: 4px;
          font-size: 0.8rem;
          pointer-events: none;
          z-index: 10;
          transition: opacity 0.3s;
        }
      </style>
      <div
        data-testid="viewer-canvas"
        role="img"
        aria-label="3D preview viewport"
        style="flex:1;position:relative;width:100%;height:100%;"
      ></div>
      ${this._toastMessage ? html`<div class="osc-toast">${this._toastMessage}</div>` : ''}
      ${this.showControls
        ? html`
            <div
              aria-label="Viewer camera presets"
              style="position:absolute;bottom:8px;right:8px;display:flex;flex-direction:column;gap:2px;z-index:2;"
            >
              ${NAMED_POSITIONS.map(
                ({ name }) => html`
                  <button
                    title="${name} view"
                    aria-label=${`Set ${name} view`}
                    @click=${() => {
                      this._scene?.setCameraPosition(name);
                      this._showToast(`${name} view`);
                    }}
                    style="font-size:0.65rem;padding:2px 6px;cursor:pointer;opacity:0.75;background:var(--osc-viewer-control-background, var(--osc-overlay, rgba(0, 0, 0, 0.6)));color:var(--osc-viewer-control-foreground, var(--osc-on-accent, #fff));border:none;border-radius:3px;"
                  >
                    ${name}
                  </button>
                `,
              )}
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-geometry-viewer': OscGeometryViewer;
  }
}
