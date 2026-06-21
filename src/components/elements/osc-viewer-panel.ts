// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import { blurHashToImage, imageToThumbhash, thumbHashToImage } from '../../io/image_hashes.ts';
import { getViewerOutputMode } from './viewer-output-mode.ts';
import './osc-geometry-viewer.ts';
import type { CameraState } from '../viewer/ThreeScene.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';

const DEFAULT_COLOR = '#f9d72c';

// Adapter between the application Model/State and the model-independent
// <osc-geometry-viewer>: it picks the output surface (3D / SVG / DXF), feeds the
// geometry viewer its inputs, and forwards camera/preview changes back to Model.
// Uses light DOM so data-testid is accessible and child sizing works.
@customElement('osc-viewer-panel')
export class OscViewerPanel extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  /** Whether this panel is the active surface; forwarded to suspend the viewer. */
  @property({ type: Boolean }) active = true;
  @state() private _st: State | null = null;
  @state() private _offText: string | null = null;
  private _model!: Model;
  private _lastOutFile: File | undefined;
  private _lastSvgPreviewUrl: string | null = null;

  private _onState = (e: Event) => {
    const st = (e as CustomEvent<State>).detail;
    this._st = st;
    if (st.output?.outFile !== this._lastOutFile) {
      this._lastOutFile = st.output?.outFile;
      this._syncOutput(st);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
    this._lastOutFile = this._st.output?.outFile;
    this._syncOutput(this._st);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
  }

  private _syncOutput(st: State) {
    const mode = getViewerOutputMode(st.output?.outFile?.name);
    if (mode === 'three' && st.output?.outFile) {
      this._readOffText(st.output.outFile);
    } else if (mode === 'svg' && st.output?.outFileURL) {
      this._offText = null;
      this._loadSvgPreview(st.output.outFileURL);
    } else {
      this._offText = null;
    }
  }

  private async _readOffText(file: File) {
    try {
      const text = await file.text();
      if (this._lastOutFile !== file) return; // a newer output superseded this one
      this._offText = text;
    } catch (err) {
      console.error('Error reading OFF geometry:', err);
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
            <osc-geometry-viewer
              .offText=${this._offText}
              color=${st?.view.color ?? DEFAULT_COLOR}
              ?showAxes=${!!st?.view.showAxes}
              ?active=${this.active}
              .camera=${(st?.view.camera ?? null) as CameraState | null}
              @camera-change=${(e: CustomEvent<CameraState>) =>
                this._model.mutate((s) => {
                  s.view.camera = e.detail;
                })}
              @geometry-loaded=${(e: CustomEvent<{ thumbhash: string }>) =>
                this._model.mutate((s) => {
                  s.preview = { thumbhash: e.detail.thumbhash };
                })}
            ></osc-geometry-viewer>
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
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-viewer-panel': OscViewerPanel;
  }
}
