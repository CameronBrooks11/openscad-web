// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getModel } from '../../state/model-context.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from '../../state/formats.ts';

type Format2D = keyof typeof VALID_EXPORT_FORMATS_2D;
type Format3D = keyof typeof VALID_EXPORT_FORMATS_3D;

interface FormatOption {
  key: string;
  label: string;
  label2D?: string;
  buttonLabel: string;
  is2D: boolean;
}

const FORMAT_OPTIONS: FormatOption[] = [
  { key: 'glb', label: 'GLB (binary glTF)', buttonLabel: 'Download GLB', is2D: false },
  { key: 'stl', label: 'STL (binary)', buttonLabel: 'Download STL', is2D: false },
  { key: 'off', label: 'OFF (Object File Format)', buttonLabel: 'Download OFF', is2D: false },
  { key: '3mf', label: '3MF (Multimaterial)', buttonLabel: 'Download 3MF', is2D: false },
  { key: 'svg', label: 'SVG (Simple Vector Graphics)', buttonLabel: 'Download SVG', is2D: true },
  { key: 'dxf', label: 'DXF (Drawing Exchange Format)', buttonLabel: 'Download DXF', is2D: true },
];

@customElement('osc-export-button')
export class OscExportButton extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .split {
      display: inline-flex;
    }
    button {
      cursor: pointer;
      padding: 4px 10px;
      border: 1px solid #bbb;
      background: #f5f5f5;
      font-size: 0.85rem;
      color: #333;
    }
    button:hover:not(:disabled) {
      background: #e8e8e8;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.main {
      border-radius: 4px 0 0 4px;
      border-right: none;
    }
    button.arrow {
      border-radius: 0 4px 4px 0;
      padding: 4px 6px;
    }
    details {
      display: inline-block;
      position: relative;
    }
    details summary {
      display: none;
    }
    .menu {
      position: absolute;
      left: 0;
      top: 100%;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 4px 0;
      z-index: 1000;
      min-width: 220px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    .menu-item {
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
    .menu-item:hover {
      background: #f0f0f0;
    }
    hr {
      margin: 4px 0;
      border: none;
      border-top: 1px solid #eee;
    }
  `;

  @state() private _st: State | null = null;
  @state() private _open = false;
  private _model!: Model;
  private _onState = (e: Event) => {
    this._st = (e as CustomEvent<State>).detail;
  };

  private _closeOnOutsideClick = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) this._open = false;
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

    const is2D = !!st.is2D;
    const options = FORMAT_OPTIONS.filter((f) => f.is2D === is2D);
    const currentKey = is2D ? st.params.exportFormat2D : st.params.exportFormat3D;
    const selected = options.find((f) => f.key === currentKey) ?? options[0];
    const disabled = !st.output || !!st.output.isPreview || !!st.rendering || !!st.exporting;

    return html`
      <div class="split">
        <button
          class="main"
          ?disabled=${disabled}
          aria-label=${selected?.buttonLabel ?? 'Export'}
          @click=${() => this._model.export()}
        >
          <span aria-hidden="true">⬇</span> ${selected?.buttonLabel ?? 'Export'}
        </button>
        <button
          class="arrow"
          ?disabled=${disabled}
          @click=${this._toggleMenu}
          title="Choose format"
          aria-label="Choose export format"
          aria-haspopup="menu"
          aria-expanded=${this._open ? 'true' : 'false'}
        >
          ▾
        </button>
      </div>
      ${this._open
        ? html`
            <div
              class="menu"
              role="menu"
              aria-label="Export format options"
              style="position:absolute; z-index:1000; margin-top:30px;"
            >
              ${options.map(
                (f) => html`
                  <button
                    class="menu-item"
                    role="menuitemradio"
                    aria-checked=${currentKey === f.key ? 'true' : 'false'}
                    @click=${() => this._selectFormat(f.key, is2D)}
                  >
                    ${f.label}
                  </button>
                `,
              )}
              ${!is2D
                ? html`
                    <hr />
                    <button
                      class="menu-item"
                      role="menuitem"
                      @click=${() => {
                        this._open = false;
                        this._model.mutate((s) => {
                          s.view.extruderPickerVisibility = 'editing';
                        });
                      }}
                    >
                      Edit
                      materials${(st.params.extruderColors ?? []).length > 0
                        ? ` (${(st.params.extruderColors ?? []).length})`
                        : ''}
                    </button>
                  `
                : ''}
            </div>
          `
        : ''}
    `;
  }

  private _toggleMenu(e: Event) {
    e.stopPropagation();
    this._open = !this._open;
  }

  private _selectFormat(key: string, is2D: boolean) {
    this._open = false;
    if (is2D) {
      this._model.setFormats(key as Format2D, undefined);
    } else {
      this._model.setFormats(undefined, key as Format3D);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-export-button': OscExportButton;
  }
}
