// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import { SingleLayoutComponentId } from '../../state/app-state.ts';

interface PanelTarget {
  id: SingleLayoutComponentId;
  label: string;
  title: string;
}

@customElement('osc-panel-switcher')
export class OscPanelSwitcher extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .bar {
      display: flex;
      flex-direction: row;
      margin: 5px;
      position: relative;
      align-items: center;
    }
    .tabs {
      display: flex;
      flex: 1;
      gap: 4px;
      justify-content: center;
    }
    button.tab {
      padding: 5px 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #f5f5f5;
      cursor: pointer;
      font-size: 0.875rem;
      color: #333;
    }
    button.tab:hover {
      background: #e8e8e8;
    }
    button.tab.active {
      background: #4f87c5;
      color: #fff;
      border-color: #4f87c5;
    }
    button.tab.toggled {
      background: #4f87c5;
      color: #fff;
      border-color: #4f87c5;
    }
    button.tab.untoggled {
      background: #f5f5f5;
      color: #555;
    }
  `;

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
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
  }

  override render() {
    const st = this._st;
    if (!st) return html``;

    const targets: PanelTarget[] = [
      { id: 'editor', label: '✏ Edit', title: 'Editor' },
      { id: 'viewer', label: '📦 View', title: 'Viewer' },
    ];
    if ((st.parameterSet?.parameters?.length ?? 0) > 0) {
      targets.push({ id: 'customizer', label: '🎛 Customize', title: 'Customizer' });
    }

    const layout = st.view.layout;

    return html`
      <div class="bar">
        <div
          class="tabs"
          role=${layout.mode === 'single' ? 'tablist' : 'group'}
          aria-label=${layout.mode === 'single' ? 'Visible panel' : 'Visible panels'}
        >
          ${layout.mode === 'multi'
            ? targets.map(({ id, label, title }) => {
                const on = !!(layout as unknown as Record<string, boolean>)[id];
                return html`
                  <button
                    class="tab ${on ? 'toggled' : 'untoggled'}"
                    title="${title}"
                    aria-label=${`${title} panel`}
                    aria-pressed=${on ? 'true' : 'false'}
                    aria-controls=${`panel-${id}`}
                    @click=${() => this._model.changeMultiVisibility(id, !on)}
                  >
                    ${label}
                  </button>
                `;
              })
            : targets.map(
                ({ id, label, title }) => html`
                  <button
                    class="tab ${layout.focus === id ? 'active' : ''}"
                    title="${title}"
                    role="tab"
                    aria-label=${`${title} panel`}
                    aria-selected=${layout.focus === id ? 'true' : 'false'}
                    aria-controls=${`panel-${id}`}
                    @click=${() => this._model.changeSingleVisibility(id)}
                  >
                    ${label}
                  </button>
                `,
              )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-panel-switcher': OscPanelSwitcher;
  }
}
