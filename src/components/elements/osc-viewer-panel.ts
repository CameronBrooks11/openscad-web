// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import { blurHashToImage, imageToThumbhash, thumbHashToImage } from '../../io/image_hashes.ts';
import { ThreeScene, NAMED_POSITIONS } from '../viewer/ThreeScene.ts';
import { offToBufferGeometry } from '../viewer/off-loader.ts';
import { parseOff } from '../../io/import_off.ts';
import { getViewerOutputMode } from './viewer-output-mode.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';

// Uses light DOM so data-testid is accessible and Three.js can manage the canvas size.

@customElement('osc-viewer-panel')
export class OscViewerPanel extends LitElement {
  // Light DOM — no shadow root
  protected override createRenderRoot() {
    return this;
  }

  @state() private _st: State | null = null;
  @state() private _toastMessage: string | null = null;
  private _model!: Model;
  private _scene: ThreeScene | null = null;
  private _ro: ResizeObserver | null = null;
  private _container: HTMLDivElement | null = null;
  private _lastOutFile: File | undefined;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSvgPreviewUrl: string | null = null;

  private _onState = (e: Event) => {
    const st = (e as CustomEvent<State>).detail;
    const prev = this._st;
    this._st = st;

    // Axes change
    if (prev?.view.showAxes !== st.view.showAxes) {
      this._scene?.setAxesVisible(!!st.view.showAxes);
    }
    // Color change
    if (prev?.view.color !== st.view.color && st.view.color) {
      this._scene?.setModelColor(st.view.color);
    }
    // Output change
    if (st.output?.outFile !== this._lastOutFile) {
      this._lastOutFile = st.output?.outFile;
      const outputMode = getViewerOutputMode(st.output?.outFile?.name);
      if (outputMode === 'three' && st.output?.outFile) {
        this._loadGeometry(st.output.outFile);
      } else if (outputMode === 'svg' && st.output?.outFileURL) {
        this._loadSvgPreview(st.output.outFileURL);
      }
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
    this._teardownScene();
    if (this._toastTimer) clearTimeout(this._toastTimer);
  }

  override updated() {
    const nextContainer = this.querySelector(
      '[data-testid="viewer-canvas"]',
    ) as HTMLDivElement | null;
    if (!nextContainer) {
      if (
        getViewerOutputMode(this._st?.output?.outFile?.name) === 'svg' &&
        this._st?.output?.outFileURL
      ) {
        this._loadSvgPreview(this._st.output.outFileURL);
      }
      this._teardownScene();
      return;
    }

    if (this._scene && this._container === nextContainer) {
      return;
    }

    this._teardownScene();
    this._container = nextContainer;

    const scene = new ThreeScene(nextContainer);
    this._scene = scene;

    const st = this._st ?? this._model.state;
    if (st.view.camera) scene.applyCameraState(st.view.camera);
    scene.onCameraChange = (cam) => {
      this._model.mutate((s) => {
        s.view.camera = cam;
      });
    };
    scene.setAxesVisible(!!st.view.showAxes);
    scene.start();

    this._ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        scene.resize(width, height);
      }
    });
    this._ro.observe(this._container);

    // Load any geometry that was already output when this panel mounted
    if (getViewerOutputMode(st.output?.outFile?.name) === 'three' && st.output?.outFile) {
      this._lastOutFile = st.output.outFile;
      this._loadGeometry(st.output.outFile);
    }
  }

  private _teardownScene() {
    this._ro?.disconnect();
    this._ro = null;
    this._scene?.dispose();
    this._scene = null;
    this._container = null;
  }

  private async _loadGeometry(file: File) {
    const scene = this._scene;
    if (!scene) return;
    try {
      const text = await file.text();
      const data = parseOff(text);
      const geometry = offToBufferGeometry(data);
      const color = this._st?.view.color ?? '#f9d72c';
      scene.loadGeometry(geometry, color);

      if (this._container) this._container.dataset.geometryLoaded = 'true';

      const dataUrl = scene.renderer.domElement.toDataURL('image/png', 0.5);
      const hash = await imageToThumbhash(dataUrl);
      this._model.mutate((s) => {
        s.preview = { thumbhash: hash };
      });
    } catch (err) {
      console.error('Error loading OFF geometry:', err);
    }
  }

  private async _loadSvgPreview(svgUrl: string) {
    if (svgUrl === this._lastSvgPreviewUrl) return;
    this._lastSvgPreviewUrl = svgUrl;
    try {
      const hash = await imageToThumbhash(svgUrl);
      this._model.mutate((s) => {
        s.preview = { thumbhash: hash };
      });
    } catch (err) {
      console.error('Error loading SVG preview:', err);
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
    const st = this._st;
    const isCompiling = !!(st?.rendering || st?.previewing);
    const outputMode = getViewerOutputMode(st?.output?.outFile?.name);
    const shows3DViewer = outputMode === 'three';
    const placeholderUri = (() => {
      if (st?.preview?.blurhash) return blurHashToImage(st.preview.blurhash, 100, 100);
      if (st?.preview?.thumbhash) return thumbHashToImage(st.preview.thumbhash);
      return null;
    })();

    return html`
      <style>
        osc-viewer-panel {
          display: flex;
          flex-direction: column;
          position: relative;
          flex: 1;
          width: 100%;
          height: 100%;
        }
        @keyframes osc-pulse {
          0% {
            opacity: 0.4;
          }
          50% {
            opacity: 0.7;
          }
          100% {
            opacity: 0.4;
          }
        }
        .osc-toast {
          position: absolute;
          top: 8px;
          right: 8px;
          background: rgba(0, 0, 0, 0.65);
          color: #fff;
          padding: 4px 12px;
          border-radius: 4px;
          font-size: 0.8rem;
          pointer-events: none;
          z-index: 10;
          transition: opacity 0.3s;
        }
        .svg-preview,
        .dxf-placeholder {
          width: 100%;
          height: 100%;
        }
        .svg-preview {
          display: block;
          object-fit: contain;
          background: #fff;
        }
        .dxf-placeholder {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: #f5f7fb;
          color: #3b4455;
          text-align: center;
          line-height: 1.5;
        }
      </style>
      ${isCompiling && placeholderUri
        ? html`
            <img
              src=${placeholderUri}
              alt=""
              style="animation:osc-pulse 1.5s ease-in-out infinite;position:absolute;pointer-events:none;width:100%;height:100%;z-index:1;"
            />
          `
        : ''}
      ${shows3DViewer
        ? html`
            <div
              data-testid="viewer-canvas"
              role="img"
              aria-label="3D preview viewport"
              style="flex:1;position:relative;width:100%;height:100%;"
            ></div>
          `
        : outputMode === 'svg'
          ? html`
              <img
                class="svg-preview"
                data-testid="viewer-svg"
                src=${st?.output?.outFileURL ?? ''}
                alt="Rendered SVG preview"
              />
            `
          : html`
              <div class="dxf-placeholder" data-testid="viewer-dxf-placeholder">
                DXF exported. Click Download to open it in your CAD tool.
              </div>
            `}
      ${shows3DViewer && this._toastMessage
        ? html`<div class="osc-toast">${this._toastMessage}</div>`
        : ''}
      ${shows3DViewer
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
                    style="font-size:0.65rem;padding:2px 6px;cursor:pointer;opacity:0.75;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:3px;"
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
    'osc-viewer-panel': OscViewerPanel;
  }
}
