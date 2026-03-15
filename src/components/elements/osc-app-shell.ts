// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import './osc-panel-switcher.ts';
import './osc-editor-panel.ts';
import './osc-viewer-panel.ts';
import './osc-customizer-panel.ts';
import './osc-footer.ts';

@customElement('osc-app-shell')
export class OscAppShell extends LitElement {
  // Monaco/editor internals rely on global CSS; using light DOM keeps those styles effective.
  protected override createRenderRoot() {
    return this;
  }

  @state() private _st: State | null = null;
  private _model!: Model;
  private _onState = (e: Event) => {
    this._st = (e as CustomEvent<State>).detail;
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;

    // Global keyboard shortcuts
    window.addEventListener('keydown', this._handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
    window.removeEventListener('keydown', this._handleKeyDown);
  }

  private _handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F5') {
      e.preventDefault();
      this._model.render({ isPreview: true, now: true });
    } else if (e.key === 'F6') {
      e.preventDefault();
      this._model.render({ isPreview: false, now: true });
    } else if (e.key === 'F7') {
      e.preventDefault();
      this._model.export();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._model.saveProject();
    }
  };

  override render() {
    const st = this._st;
    if (!st) return html``;

    const layout = st.view.layout;
    const mode = layout.mode;
    const shellStyles = html`
      <style>
        osc-app-shell {
          display: flex;
          flex-direction: column;
          flex: 1;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: #eef3fc;
        }
        osc-app-shell .panels-multi {
          display: flex;
          flex-direction: row;
          flex: 1;
          overflow: hidden;
          min-height: 0;
          min-width: 0;
          border-top: 1px solid #d6deec;
          border-bottom: 1px solid #d6deec;
          background: #d6deec;
        }
        osc-app-shell .panels-single {
          display: flex;
          flex-direction: column;
          flex: 1;
          position: relative;
          overflow: hidden;
          min-height: 0;
          min-width: 0;
          border-top: 1px solid #d6deec;
          border-bottom: 1px solid #d6deec;
          background: #d6deec;
        }
        osc-app-shell osc-editor-panel,
        osc-app-shell osc-viewer-panel,
        osc-app-shell osc-customizer-panel {
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
        }
        osc-app-shell .absolute-fill {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
        }
        osc-app-shell .opacity-animated {
          transition: opacity 0.25s ease;
        }
        osc-app-shell .opacity-0 {
          opacity: 0;
          pointer-events: none;
        }
      </style>
    `;

    if (mode === 'multi') {
      const itemCount =
        (layout.editor ? 1 : 0) + (layout.viewer ? 1 : 0) + (layout.customizer ? 1 : 0);
      const pct = itemCount > 0 ? Math.floor(100 / itemCount) + '%' : '100%';

      return html`
        ${shellStyles}
        <osc-panel-switcher></osc-panel-switcher>
        <div class="panels-multi">
          ${layout.editor
            ? html`
                <osc-editor-panel
                  id="panel-editor"
                  style="flex:1 1 ${pct};max-width:${pct};min-width:0;overflow:hidden;"
                ></osc-editor-panel>
              `
            : ''}
          ${layout.viewer
            ? html`
                <osc-viewer-panel
                  id="panel-viewer"
                  style="flex:1 1 ${pct};max-width:${pct};min-width:0;overflow:hidden;"
                ></osc-viewer-panel>
              `
            : ''}
          ${layout.customizer
            ? html`
                <osc-customizer-panel
                  id="panel-customizer"
                  style="flex:1 1 ${pct};max-width:${pct};min-width:0;overflow-y:auto;"
                ></osc-customizer-panel>
              `
            : ''}
        </div>
        <osc-footer></osc-footer>
      `;
    } else {
      // Single panel mode — stack all, use z-index to show focused
      const focus = layout.focus;
      const zOf = (id: string) => (focus === id ? 3 : id === 'viewer' ? 1 : 0);

      return html`
        ${shellStyles}
        <osc-panel-switcher></osc-panel-switcher>
        <div class="panels-single">
          <osc-editor-panel
            id="panel-editor"
            class="absolute-fill opacity-animated ${focus !== 'editor' ? 'opacity-0' : ''}"
            style="z-index:${zOf('editor')};"
            ?inert=${focus !== 'editor'}
            aria-hidden=${focus !== 'editor' ? 'true' : 'false'}
          ></osc-editor-panel>
          <osc-viewer-panel
            id="panel-viewer"
            class="absolute-fill"
            style="z-index:${zOf('viewer')};"
            ?inert=${focus !== 'viewer'}
            aria-hidden=${focus !== 'viewer' ? 'true' : 'false'}
          ></osc-viewer-panel>
          <osc-customizer-panel
            id="panel-customizer"
            class="absolute-fill opacity-animated ${focus !== 'customizer' ? 'opacity-0' : ''}"
            style="z-index:${zOf('customizer')};overflow-y:auto;"
            ?inert=${focus !== 'customizer'}
            aria-hidden=${focus !== 'customizer' ? 'true' : 'false'}
          ></osc-customizer-panel>
        </div>
        <osc-footer></osc-footer>
      `;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-app-shell': OscAppShell;
  }
}
