// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import { getFS } from '../../state/fs-context.ts';
import { clearHomeDirectory } from '../../fs/filesystem.ts';
import { isInStandaloneMode } from '../../utils.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';

@customElement('osc-settings-menu')
export class OscSettingsMenu extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      position: relative;
    }
    details {
      display: inline-block;
      position: relative;
    }
    summary {
      cursor: pointer;
      list-style: none;
      padding: 4px 8px;
      border-radius: 50%;
      background: transparent;
      border: none;
      font-size: 1rem;
      color: #555;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    summary:hover {
      background: rgba(0, 0, 0, 0.07);
    }
    .menu {
      position: absolute;
      right: 0;
      top: 100%;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 4px 0;
      z-index: 1000;
      min-width: 240px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    button.item {
      display: block;
      width: 100%;
      padding: 8px 16px;
      border: none;
      background: none;
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
      font-size: 0.9rem;
      color: #333;
    }
    button.item:hover {
      background: #f0f0f0;
    }
    hr {
      margin: 4px 0;
      border: none;
      border-top: 1px solid #eee;
    }
    button.item.danger {
      color: #c00;
    }
  `;

  @state() private _st: State | null = null;
  private _model!: Model;
  private _onState = (e: Event) => {
    this._st = (e as CustomEvent<State>).detail;
  };

  private _closeOnOutsideClick = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) {
      this.shadowRoot?.querySelector('details')?.removeAttribute('open');
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
    document.addEventListener('click', this._closeOnOutsideClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
    document.removeEventListener('click', this._closeOnOutsideClick);
  }

  override render() {
    const st = this._st;
    if (!st) return html``;
    const backend = st.params.backend ?? 'manifold';

    return html`
      <details>
        <summary title="Settings">⚙</summary>
        <div class="menu">
          <button
            class="item"
            @click=${() =>
              this._model.changeLayout(st.view.layout.mode === 'multi' ? 'single' : 'multi')}
          >
            ${st.view.layout.mode === 'multi'
              ? 'Switch to single panel mode'
              : 'Switch to side-by-side mode'}
          </button>
          <hr />
          <button
            class="item"
            @click=${() =>
              this._model.mutate((s) => {
                s.view.showAxes = !s.view.showAxes;
              })}
          >
            ${st.view.showAxes ? 'Hide axes' : 'Show axes'}
          </button>
          <button
            class="item"
            @click=${() =>
              this._model.mutate((s) => {
                s.view.lineNumbers = !s.view.lineNumbers;
              })}
          >
            ${st.view.lineNumbers ? 'Hide line numbers' : 'Show line numbers'}
          </button>
          <button
            class="item"
            @click=${() =>
              this._model.mutate((s) => {
                s.params.autoCompile = !(s.params.autoCompile ?? true);
              })}
          >
            ${(st.params.autoCompile ?? true)
              ? 'Disable auto-compile on edit'
              : 'Enable auto-compile on edit'}
          </button>
          <button
            class="item"
            @click=${() =>
              this._model.mutate((s) => {
                s.view.customizerGroupsCollapsed = !(s.view.customizerGroupsCollapsed ?? false);
              })}
          >
            ${(st.view.customizerGroupsCollapsed ?? false)
              ? 'Expand customizer groups by default'
              : 'Collapse customizer groups by default'}
          </button>
          <hr />
          <button
            class="item"
            @click=${() =>
              this._model.mutate((s) => {
                s.params.backend = s.params.backend === 'cgal' ? 'manifold' : 'cgal';
              })}
          >
            ${backend === 'manifold' ? 'Switch to CGAL backend' : 'Switch to Manifold backend'}
          </button>
          ${isInStandaloneMode()
            ? html`
                <hr />
                <button class="item danger" @click=${this._clearLocalData}>Clear local data</button>
              `
            : ''}
        </div>
      </details>
    `;
  }

  private _clearLocalData() {
    if (
      window.confirm(
        "This will clear all the edits you've made and files you've created in this playground " +
          'and will reset it to factory defaults. ' +
          'Are you sure you wish to proceed? (you might lose your models!)',
      )
    ) {
      try {
        clearHomeDirectory(getFS());
      } catch (e) {
        console.error('Failed to clear /home partition:', e);
      }
      // Keep this to clear any future settings persisted outside BrowserFS.
      localStorage.clear();
      location.reload();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-settings-menu': OscSettingsMenu;
  }
}
