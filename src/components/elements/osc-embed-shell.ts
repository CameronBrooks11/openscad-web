// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
// EmbedShell — minimal viewer for ?mode=embed URLs. Supports optional customizer controls,
// download button, and a postMessage API.
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import { UrlModeParams, fetchExternalModel } from '../../state/url-mode.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import './osc-viewer-panel.ts';
import './osc-customizer-panel.ts';

// ---------------------------------------------------------------------------
// postMessage protocol (host → iframe)
// ---------------------------------------------------------------------------
type SetModelMsg = { type: 'setModel'; source: string };
type SetVarMsg   = { type: 'setVar'; name: string; value: unknown };
type InboundMsg  = SetModelMsg | SetVarMsg;

function notifyHost(type: string, payload?: Record<string, unknown>) {
  if (window.parent !== window) {
    window.parent.postMessage({ type, ...payload }, '*');
  }
}

function coerceUrlVars(vars: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === 'true') result[k] = true;
    else if (v === 'false') result[k] = false;
    else { const n = Number(v); result[k] = v.trim() !== '' && !isNaN(n) ? n : v; }
  }
  return result;
}

@customElement('osc-embed-shell')
export class OscEmbedShell extends LitElement {
  static override styles = css`
    :host {
      display: flex; flex-direction: column; flex: 1;
      width: 100%; height: 100%;
    }
    .viewer-wrap { flex: 1; position: relative; }
    osc-viewer-panel { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
    .download-bar { padding: 4px 8px; }
    .download-bar button { cursor: pointer; padding: 4px 12px; }
    .error { padding: 2rem; color: red; }
  `;

  @property({ attribute: false }) urlParams!: UrlModeParams;
  @state() private _st: State | null = null;
  @state() private _loadError: string | null = null;
  private _model!: Model;
  private _onState = (e: Event) => {
    const prev = this._st;
    const st = (e as CustomEvent<State>).detail;
    this._st = st;
    if (st.output && !st.rendering && !st.previewing) {
      if (!prev?.output || prev.output.outFileURL !== st.output.outFileURL) {
        notifyHost('renderComplete', { outFileURL: st.output.outFileURL });
      }
    }
  };

  private _messageHandler = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const msg = event.data as InboundMsg;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'setModel') {
      const m = msg as SetModelMsg;
      if (typeof m.source === 'string') this._model.source = m.source;
    } else if (msg.type === 'setVar') {
      const m = msg as SetVarMsg;
      if (typeof m.name === 'string') this._model.setVar(m.name, m.value as never);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
    window.addEventListener('message', this._messageHandler);
    this._initialize();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
    window.removeEventListener('message', this._messageHandler);
  }

  private _initialize() {
    const params = this.urlParams;
    if (!params) return;

    // Apply view overrides
    const overrides = params.viewOverrides;
    if (Object.keys(overrides).length > 0) {
      this._model.mutate(s => {
        if (overrides.showAxes !== undefined) s.view.showAxes = overrides.showAxes;
        if (overrides.color !== undefined) s.view.color = overrides.color!;
        if (overrides.lineNumbers !== undefined) s.view.lineNumbers = overrides.lineNumbers;
      });
    }

    if (!params.modelUrl) {
      this._model.init();
      return;
    }

    // Load external model
    (async () => {
      const result = await fetchExternalModel(params.modelUrl!);
      if (typeof result === 'object' && 'error' in result) {
        this._loadError = result.error;
        notifyHost('stateChange', { error: result.error });
        return;
      }
      const preVars = params.prePopulatedVars;
      if (Object.keys(preVars).length > 0) {
        this._model.mutate(s => { s.params.vars = { ...(s.params.vars ?? {}), ...coerceUrlVars(preVars) }; });
      }
      this._model.source = result;
    })();
  }

  override render() {
    if (this._loadError) {
      return html`<div class="error">Failed to load model: ${this._loadError}</div>`;
    }
    const params = this.urlParams;
    return html`
      <div class="viewer-wrap">
        <osc-viewer-panel></osc-viewer-panel>
      </div>
      ${params?.embedControls ? html`<osc-customizer-panel style="max-height:40vh;"></osc-customizer-panel>` : ''}
      ${params?.embedDownload ? html`
        <div class="download-bar">
          <button @click=${() => this._model.export()}>Download STL</button>
        </div>
      ` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-embed-shell': OscEmbedShell;
  }
}
