// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import chroma from 'chroma-js';
import { getModel } from '../../state/model-context.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';

@customElement('osc-multimaterial-dialog')
export class OscMultimaterialDialog extends LitElement {
  static override styles = css`
    dialog {
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 0;
      min-width: 380px;
      max-width: 90vw;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.4);
    }
    .header {
      padding: 12px 16px;
      font-weight: bold;
      font-size: 1rem;
      border-bottom: 1px solid #eee;
    }
    .body {
      padding: 16px;
    }
    p {
      margin: 0 0 8px;
      font-size: 0.875rem;
      color: #555;
    }
    .color-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    input[type='color'] {
      width: 36px;
      height: 28px;
      padding: 0;
      border: 1px solid #ccc;
      cursor: pointer;
      border-radius: 2px;
    }
    input[type='text'] {
      flex: 1;
      padding: 4px 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 0.875rem;
    }
    input[type='text'].invalid {
      border-color: #e00;
      background: #fff5f5;
    }
    button.remove {
      background: none;
      border: none;
      cursor: pointer;
      color: #e00;
      font-size: 1rem;
      padding: 0 4px;
    }
    button.remove:hover {
      color: #900;
    }
    button.add {
      margin-top: 4px;
      padding: 4px 12px;
      border: 1px solid #aaa;
      background: #f5f5f5;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
    }
    button.add:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .footer {
      padding: 10px 16px;
      border-top: 1px solid #eee;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .footer-left {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85rem;
    }
    .footer-right {
      display: flex;
      gap: 8px;
    }
    button.btn {
      padding: 5px 14px;
      border: 1px solid #bbb;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      background: #f5f5f5;
    }
    button.btn-primary {
      background: #4f87c5;
      color: #fff;
      border-color: #4f87c5;
    }
    button.btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.btn:hover:not(:disabled) {
      background: #e8e8e8;
    }
    button.btn-primary:hover:not(:disabled) {
      background: #3a72b0;
    }
  `;

  @state() private _st: State | null = null;
  @state() private _tempColors: string[] = [];
  private _model!: Model;
  private _dialogEl: HTMLDialogElement | null = null;

  private _onState = (e: Event) => {
    const st = (e as CustomEvent<State>).detail;
    const prev = this._st;
    this._st = st;
    // Sync temp colors when dialog opens
    if (!prev?.view.extruderPickerVisibility && st.view.extruderPickerVisibility) {
      this._tempColors = [...(st.params.extruderColors ?? [])];
    }
    this._syncDialog();
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

  override firstUpdated() {
    this._dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    this._syncDialog();
  }

  private _syncDialog() {
    const dlg = this._dialogEl;
    if (!dlg) return;
    if (this._st?.view.extruderPickerVisibility) {
      if (!dlg.open) {
        this._tempColors = [...(this._st.params.extruderColors ?? [])];
        dlg.showModal();
      }
    } else {
      if (dlg.open) dlg.close();
    }
  }

  private _cancel() {
    this._model.mutate((s) => {
      s.view.extruderPickerVisibility = undefined;
    });
  }

  private _confirm() {
    const wasExporting = this._st?.view.extruderPickerVisibility === 'exporting';
    this._model.mutate((s) => {
      s.params.extruderColors = this._tempColors.filter((c) => c.trim() !== '');
      s.view.extruderPickerVisibility = undefined;
    });
    if (wasExporting) this._model.export();
  }

  private _setColor(index: number, color: string) {
    const arr = [...this._tempColors];
    arr[index] = color;
    this._tempColors = arr;
  }

  private _removeColor(index: number) {
    this._tempColors = this._tempColors.filter((_, i) => i !== index);
  }

  private _addColor() {
    this._tempColors = [...this._tempColors, ''];
  }

  override render() {
    const st = this._st;
    const canAdd = !this._tempColors.some((c) => c.trim() === '');
    const canSave = this._tempColors.every((c) => chroma.valid(c) || c.trim() === '');
    const isExporting = st?.view.extruderPickerVisibility === 'exporting';

    return html`
      <dialog
        @cancel=${(e: Event) => {
          e.preventDefault();
          this._cancel();
        }}
      >
        <div class="header">Multimaterial Color Picker</div>
        <div class="body">
          <p>
            To print on a multimaterial printer, we map the model's colors to the nearest extruder
            color.
          </p>
          <p>Define the colors of your extruders below.</p>
          ${this._tempColors.map(
            (color, i) => html`
              <div class="color-row">
                <input
                  type="color"
                  .value=${chroma.valid(color) ? chroma(color).hex() : '#000000'}
                  @change=${(e: Event) =>
                    this._setColor(i, chroma((e.target as HTMLInputElement).value).name())}
                />
                <input
                  type="text"
                  class=${color.trim() !== '' && !chroma.valid(color) ? 'invalid' : ''}
                  .value=${color}
                  ?autofocus=${color === ''}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && canAdd) {
                      e.preventDefault();
                      this._addColor();
                    }
                  }}
                  @input=${(e: Event) => {
                    let v = (e.target as HTMLInputElement).value.trim();
                    try {
                      v = chroma(v).name();
                    } catch {
                      /* keep raw */
                    }
                    this._setColor(i, v);
                  }}
                />
                <button class="remove" @click=${() => this._removeColor(i)}>✕</button>
              </div>
            `,
          )}
          <button class="add" ?disabled=${!canAdd} @click=${this._addColor}>+ Add Color</button>
        </div>
        <div class="footer">
          <div class="footer-left">
            <input
              type="checkbox"
              id="skip-mm-prompt"
              .checked=${!!st?.params.skipMultimaterialPrompt}
              @change=${(e: Event) =>
                this._model.mutate((s) => {
                  s.params.skipMultimaterialPrompt = (e.target as HTMLInputElement).checked;
                })}
            />
            <label for="skip-mm-prompt">Don't ask again this session</label>
          </div>
          <div class="footer-right">
            <button class="btn" @click=${this._cancel}>Cancel</button>
            <button class="btn btn-primary" ?disabled=${!canSave} @click=${this._confirm}>
              ${isExporting ? 'Export' : 'Save'}
            </button>
          </div>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-multimaterial-dialog': OscMultimaterialDialog;
  }
}
