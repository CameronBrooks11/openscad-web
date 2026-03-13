// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import type { Parameter, ParameterOption } from '../../state/customizer-types.ts';

@customElement('osc-customizer-panel')
export class OscCustomizerPanel extends LitElement {
  static override styles = css`
    :host { display: flex; flex-direction: column; overflow-y: auto; }
    details {
      margin: 5px 10px; border: 1px solid #ccc; border-radius: 4px;
      background: rgba(255,255,255,0.4);
    }
    summary {
      padding: 8px 12px; cursor: pointer; font-weight: bold;
      user-select: none; list-style: disc;
    }
    summary::-webkit-details-marker { display: list-item; }
    .group-body { padding: 8px 12px 12px; }
    .param-row {
      display: flex; flex-direction: column; margin-bottom: 10px;
    }
    .param-header {
      display: flex; flex-direction: row; align-items: center;
      justify-content: space-between; margin-bottom: 4px;
    }
    .param-label { font-weight: bold; font-size: 0.85rem; }
    .param-caption { font-size: 0.75rem; color: #666; }
    .param-controls { display: flex; flex-direction: row; align-items: center; gap: 4px; }
    select, input[type="number"], input[type="text"] {
      padding: 3px 6px; border: 1px solid #ccc; border-radius: 4px;
      font-size: 0.85rem; background: #fff;
    }
    input[type="range"] { flex: 1; cursor: pointer; }
    input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
    button.reset {
      background: none; border: none; cursor: pointer; color: #888;
      font-size: 1rem; padding: 0 2px;
    }
    button.reset:hover { color: #333; }
    button.reset.hidden { visibility: hidden; }
    .slider-row { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
    .vector-row { display: flex; gap: 4px; flex: 1; }
  `;

  @state() private _st: State | null = null;
  private _model!: Model;
  private _onState = (e: Event) => { this._st = (e as CustomEvent<State>).detail; };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _handleChange(name: string, value: any) {
    this._model.setVar(name, value);
  }

  override render() {
    const st = this._st;
    if (!st) return html``;

    const groups = (st.parameterSet?.parameters ?? []).reduce((acc, p) => {
      if (!acc[p.group]) acc[p.group] = [];
      acc[p.group].push(p);
      return acc;
    }, {} as Record<string, Parameter[]>);

    const collapsed = new Set(st.view.collapsedCustomizerTabs ?? []);
    const globalCollapse = st.view.customizerGroupsCollapsed ?? false;

    const setOpen = (group: string, open: boolean) => {
      const s = new Set(collapsed);
      open ? s.delete(group) : s.add(group);
      this._model.mutate(s2 => { s2.view.collapsedCustomizerTabs = Array.from(s); });
    };

    return html`
      ${Object.entries(groups).map(([group, params]) => html`
        <details
          ?open=${!globalCollapse && !collapsed.has(group)}
          @toggle=${(e: Event) => setOpen(group, (e.target as HTMLDetailsElement).open)}>
          <summary>${group}</summary>
          <div class="group-body">
            ${params.map(p => this._renderParam(p, (st.params.vars ?? {})[p.name]))}
          </div>
        </details>
      `)}
    `;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _renderParam(param: Parameter, value: any) {
    const isDefault = value === undefined || JSON.stringify(value) === JSON.stringify(param.initial);

    return html`
      <div class="param-row">
        <div class="param-header">
          <div>
            <div class="param-label">${param.name}</div>
            <div class="param-caption">${param.caption}</div>
          </div>
          <div class="param-controls">
            ${this._renderControl(param, value)}
            <button class="reset ${isDefault ? 'hidden' : ''}" title="Reset to default"
              @click=${() => this._handleChange(param.name, param.initial)}>↺</button>
          </div>
        </div>
        ${this._renderSlider(param, value)}
      </div>
    `;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _renderControl(param: Parameter, value: any) {
    const v = value ?? param.initial;

    // Number with options → select dropdown
    if (param.type === 'number' && 'options' in param && param.options) {
      return html`
        <select @change=${(e: Event) => this._handleChange(param.name, Number((e.target as HTMLSelectElement).value))}>
          ${(param.options as ParameterOption[]).map(o => html`
            <option .value=${String(o.value)} ?selected=${v === o.value}>${o.name}</option>
          `)}
        </select>
      `;
    }

    // String with options → select dropdown
    if (param.type === 'string' && param.options) {
      return html`
        <select @change=${(e: Event) => this._handleChange(param.name, (e.target as HTMLSelectElement).value)}>
          ${(param.options as ParameterOption[]).map(o => html`
            <option .value=${String(o.value)} ?selected=${v === o.value}>${o.name}</option>
          `)}
        </select>
      `;
    }

    // Boolean → checkbox
    if (param.type === 'boolean') {
      return html`
        <input type="checkbox" .checked=${!!v}
          @change=${(e: Event) => this._handleChange(param.name, (e.target as HTMLInputElement).checked)} />
      `;
    }

    // Vector (array initial) → multiple number inputs
    if (Array.isArray(param.initial) && 'min' in param) {
      const arr = Array.isArray(v) ? v : param.initial as number[];
      return html`
        <div class="vector-row">
          ${(param.initial as number[]).map((_, i) => html`
            <input type="number" style="width:56px;" size="5"
              .value=${String(arr[i] ?? (param.initial as number[])[i])}
              @change=${(e: Event) => {
                const newArr = [...arr];
                newArr[i] = Number((e.target as HTMLInputElement).value);
                this._handleChange(param.name, newArr);
              }} />
          `)}
        </div>
      `;
    }

    // Number without slider options → number input
    if (param.type === 'number') {
      return html`
        <input type="number" size="5" style="width:72px;"
          .value=${String(v)}
          @change=${(e: Event) => this._handleChange(param.name, Number((e.target as HTMLInputElement).value))} />
      `;
    }

    // String → text input
    if (param.type === 'string') {
      return html`
        <input type="text" style="min-width:100px;"
          .value=${String(v)}
          @input=${(e: Event) => this._handleChange(param.name, (e.target as HTMLInputElement).value)} />
      `;
    }

    return html``;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _renderSlider(param: Parameter, value: any) {
    if (!Array.isArray(param.initial) && param.type === 'number' && 'min' in param && param.min !== undefined) {
      const v = value ?? param.initial;
      return html`
        <div class="slider-row">
          <input type="range"
            .value=${String(v)}
            min=${param.min} max=${(param as {max?: number}).max ?? 100} step=${(param as {step?: number}).step ?? 1}
            @input=${(e: Event) => this._handleChange(param.name, Number((e.target as HTMLInputElement).value))} />
          <span style="font-size:0.8rem;width:40px;text-align:right;">${Number(v).toFixed(Number((param as {step?: number}).step ?? 1) < 1 ? 2 : 0)}</span>
        </div>
      `;
    }
    return html``;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-customizer-panel': OscCustomizerPanel;
  }
}
