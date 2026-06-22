// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { countDiagnostics, maxDiagnosticSeverity } from '../../diagnostics.ts';
import { getModel } from '../../state/model-context.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import './osc-export-button.ts';
import './osc-settings-menu.ts';
import './osc-help-menu.ts';
import './osc-multimaterial-dialog.ts';

@customElement('osc-footer')
export class OscFooter extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .progress-bar-track {
      height: 6px;
      margin: 0 5px;
      background: var(--osc-panel-muted);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-bar-indeterminate {
      height: 100%;
      width: 30%;
      background: var(--osc-accent);
      border-radius: 3px;
      animation: osc-progress 1.4s linear infinite;
    }
    @keyframes osc-progress {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(433%);
      }
    }
    .footer-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 4px;
      margin: 5px;
    }
    button.foot-btn {
      cursor: pointer;
      padding: 4px 10px;
      border: 1px solid var(--osc-border);
      background: var(--osc-panel-muted);
      border-radius: 4px;
      font-size: 0.85rem;
      color: var(--osc-fg);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    button.foot-btn:hover:not(:disabled) {
      background: var(--osc-hover);
    }
    button.foot-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.foot-btn.danger {
      border-color: var(--osc-error);
      color: var(--osc-error);
    }
    button.foot-btn.warning {
      border-color: var(--osc-warning);
      color: var(--osc-warning);
    }
    .badge {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 10px;
      font-size: 0.7rem;
      font-weight: bold;
      color: var(--osc-on-accent);
      line-height: 1.4;
    }
    .badge-danger {
      background: var(--osc-error);
    }
    .badge-warning {
      background: var(--osc-warning);
    }
    .badge-info {
      background: var(--osc-info);
    }
    .spacer {
      flex: 1;
    }
    .error-banner {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 5px 5px 0;
      padding: 10px 12px;
      border: 1px solid var(--osc-error-border);
      border-radius: 8px;
      background: var(--osc-error-bg);
      color: var(--osc-error-fg);
    }
    .error-banner-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .error-banner-message {
      flex: 1;
      font-size: 0.9rem;
      line-height: 1.4;
    }
    .error-banner-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .error-details {
      font-size: 0.8rem;
      color: var(--osc-error-fg);
    }
    .error-details summary {
      cursor: pointer;
      font-weight: 600;
    }
    .error-details pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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

    const busy = st.rendering || st.previewing || st.checkingSyntax || st.exporting;
    const markers = st.lastCheckerRun?.markers ?? [];
    const counts = countDiagnostics(markers);
    const errCount = counts.error;
    const warnCount = counts.warning;
    const infoCount = counts.info;
    const maxSev = maxDiagnosticSeverity(markers) ?? undefined;
    const hasDiagnostics = !!(
      st.lastCheckerRun ||
      st.output ||
      st.error ||
      st.currentRunLogs?.length
    );

    return html`
      ${st.error
        ? html`
            <div class="error-banner" data-testid="error-banner" role="alert">
              <div class="error-banner-header">
                <div class="error-banner-message">${st.error}</div>
                <button class="foot-btn danger" @click=${() => this._model.clearError()}>
                  Dismiss
                </button>
              </div>
              <div class="error-banner-actions">
                ${st.currentRunLogs?.length
                  ? html`
                      <button
                        class="foot-btn"
                        @click=${() => {
                          this._model.logsVisible = true;
                        }}
                      >
                        Show Logs
                      </button>
                    `
                  : ''}
              </div>
              ${st.errorDetails
                ? html`
                    <details class="error-details">
                      <summary>Technical details</summary>
                      <pre>${st.errorDetails}</pre>
                    </details>
                  `
                : ''}
            </div>
          `
        : ''}
      <div
        class="progress-bar-track"
        style="visibility:${busy ? 'visible' : 'hidden'};"
        role="status"
        aria-live="polite"
        aria-label=${busy ? 'Working…' : 'Idle'}
      >
        <div class="progress-bar-indeterminate"></div>
      </div>
      <div class="footer-row">
        ${st.output && !st.output.isPreview
          ? html`<osc-export-button></osc-export-button>`
          : st.previewing
            ? html`<button class="foot-btn" disabled>⚡ Previewing…</button>`
            : st.output?.isPreview
              ? html`<button
                  class="foot-btn"
                  @click=${() => this._model.render({ isPreview: false, now: true })}
                  ?disabled=${st.rendering}
                >
                  ⚡ ${st.rendering ? 'Rendering…' : 'Render'}
                </button>`
              : ''}

        <osc-multimaterial-dialog></osc-multimaterial-dialog>

        ${hasDiagnostics
          ? html`
              <button
                class="foot-btn ${maxSev === 'error'
                  ? 'danger'
                  : maxSev === 'warning'
                    ? 'warning'
                    : ''}"
                title="Toggle log output"
                aria-label="Toggle log output"
                aria-pressed=${st.view.logs ? 'true' : 'false'}
                @click=${() => {
                  this._model.logsVisible = !st.view.logs;
                }}
              >
                ≡ ${errCount > 0 ? html`<span class="badge badge-danger">${errCount}</span>` : ''}
                ${warnCount > 0 ? html`<span class="badge badge-warning">${warnCount}</span>` : ''}
                ${infoCount > 0 ? html`<span class="badge badge-info">${infoCount}</span>` : ''}
              </button>
            `
          : ''}

        <div class="spacer"></div>

        <osc-settings-menu></osc-settings-menu>
        <osc-help-menu></osc-help-menu>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-footer': OscFooter;
  }
}
