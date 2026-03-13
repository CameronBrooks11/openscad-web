// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
// CustomizerShell — minimal viewer + customizer panel for ?mode=customizer URLs.
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import { UrlModeParams, fetchExternalModel } from '../../state/url-mode.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import './osc-viewer-panel.ts';
import './osc-customizer-panel.ts';

function coerceUrlVars(vars: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === 'true') result[k] = true;
    else if (v === 'false') result[k] = false;
    else {
      const n = Number(v);
      result[k] = v.trim() !== '' && !isNaN(n) ? n : v;
    }
  }
  return result;
}

function buildEditorUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('mode');
  return url.toString();
}

@customElement('osc-customizer-shell')
export class OscCustomizerShell extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      width: 100%;
      height: 100%;
    }
    .main-row {
      display: flex;
      flex-direction: row;
      flex: 1;
      overflow: hidden;
    }
    .viewer-wrap {
      flex: 1;
      position: relative;
    }
    osc-viewer-panel {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    osc-customizer-panel {
      width: 280px;
      min-width: 220px;
      overflow-y: auto;
    }
    .back-bar {
      padding: 4px 8px;
      font-size: 0.8em;
      background: rgba(0, 0, 0, 0.05);
    }
    .error {
      padding: 2rem;
      color: red;
    }
  `;

  @property({ attribute: false }) urlParams!: UrlModeParams;
  @state() private _st: State | null = null;
  @state() private _loadError: string | null = null;
  private _model!: Model;
  private _onState = (e: Event) => {
    this._st = (e as CustomEvent<State>).detail;
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
    this._initialize();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
  }

  private _initialize() {
    const params = this.urlParams;
    if (!params) return;

    const overrides = params.viewOverrides;
    if (Object.keys(overrides).length > 0) {
      this._model.mutate((s) => {
        if (overrides.showAxes !== undefined) s.view.showAxes = overrides.showAxes;
        if (overrides.color !== undefined) s.view.color = overrides.color!;
        if (overrides.lineNumbers !== undefined) s.view.lineNumbers = overrides.lineNumbers;
      });
    }

    if (!params.modelUrl) {
      this._model.init();
      return;
    }

    (async () => {
      const result = await fetchExternalModel(params.modelUrl!);
      if (typeof result === 'object' && 'error' in result) {
        this._loadError = result.error;
        return;
      }
      const preVars = params.prePopulatedVars;
      if (Object.keys(preVars).length > 0) {
        this._model.mutate((s) => {
          s.params.vars = { ...(s.params.vars ?? {}), ...coerceUrlVars(preVars) };
        });
      }
      this._model.source = result;
    })();
  }

  override render() {
    if (this._loadError) {
      return html`<div class="error">Failed to load model: ${this._loadError}</div>`;
    }
    return html`
      <div class="main-row">
        <div class="viewer-wrap">
          <osc-viewer-panel></osc-viewer-panel>
        </div>
        <osc-customizer-panel></osc-customizer-panel>
      </div>
      <div class="back-bar">
        <a href=${buildEditorUrl()} target="_blank" rel="noreferrer">View in Editor</a>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-customizer-shell': OscCustomizerShell;
  }
}
