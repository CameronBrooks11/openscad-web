// Issue #78: a non-blocking "update available" affordance. Listens for the
// SW_UPDATE_AVAILABLE_EVENT dispatched by the service-worker registration and
// offers a user-initiated reload, which applies the waiting worker safely
// rather than swapping it mid-session.
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  SW_UPDATE_AVAILABLE_EVENT,
  applyServiceWorkerUpdate,
} from '../../runtime/service-worker.ts';

@customElement('osc-update-banner')
export class OscUpdateBanner extends LitElement {
  static override styles = css`
    .banner {
      position: fixed;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: calc(100vw - 24px);
      padding: 10px 14px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: #1e293b;
      color: #f8fafc;
      box-shadow: 0 6px 24px var(--osc-shadow);
      font-size: 0.9rem;
    }
    .msg {
      line-height: 1.3;
    }
    .actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    button {
      cursor: pointer;
      padding: 5px 12px;
      border-radius: 6px;
      border: 1px solid transparent;
      font: inherit;
    }
    .reload {
      background: #38bdf8;
      color: #0b1220;
      font-weight: 600;
    }
    .reload:disabled {
      opacity: 0.7;
      cursor: default;
    }
    .dismiss {
      background: transparent;
      color: #cbd5e1;
      border-color: #475569;
    }
  `;

  @state() private _registration: ServiceWorkerRegistration | null = null;
  @state() private _applying = false;

  private _onUpdate = (event: Event) => {
    const detail = (event as CustomEvent<{ registration: ServiceWorkerRegistration }>).detail;
    this._registration = detail?.registration ?? null;
    this._applying = false;
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener(SW_UPDATE_AVAILABLE_EVENT, this._onUpdate);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(SW_UPDATE_AVAILABLE_EVENT, this._onUpdate);
  }

  private _reload() {
    if (!this._registration) return;
    this._applying = true;
    applyServiceWorkerUpdate(this._registration);
  }

  private _dismiss() {
    this._registration = null;
  }

  override render() {
    if (!this._registration) return html``;
    return html`
      <div class="banner" role="status" data-testid="update-banner">
        <span class="msg">A new version is available.</span>
        <span class="actions">
          <button class="reload" ?disabled=${this._applying} @click=${this._reload}>
            ${this._applying ? 'Updating…' : 'Reload to update'}
          </button>
          <button class="dismiss" @click=${this._dismiss}>Later</button>
        </span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-update-banner': OscUpdateBanner;
  }
}
