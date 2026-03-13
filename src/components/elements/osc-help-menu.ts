// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('osc-help-menu')
export class OscHelpMenu extends LitElement {
  static override styles = css`
    :host { display: inline-block; position: relative; }
    details { display: inline-block; position: relative; }
    summary {
      cursor: pointer; list-style: none;
      padding: 4px 8px; border-radius: 50%;
      background: transparent; border: none;
      font-size: 1rem; color: #555;
    }
    summary::-webkit-details-marker { display: none; }
    summary:hover { background: rgba(0,0,0,0.07); }
    .menu {
      position: absolute; right: 0; top: 100%;
      background: #fff; border: 1px solid #ddd;
      border-radius: 4px; padding: 4px 0;
      z-index: 1000; min-width: 200px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    a {
      display: block; padding: 8px 16px;
      color: #333; text-decoration: none;
      white-space: nowrap; font-size: 0.9rem;
    }
    a:hover { background: #f0f0f0; }
  `;

  private _closeOnOutsideClick = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) {
      this.shadowRoot?.querySelector('details')?.removeAttribute('open');
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this._closeOnOutsideClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this._closeOnOutsideClick);
  }

  override render() {
    return html`
      <details>
        <summary title="Help &amp; Licenses">?</summary>
        <div class="menu">
          <a href="https://github.com/openscad/openscad-playground/" target="_blank" rel="noreferrer">openscad-playground</a>
          <a href="https://github.com/openscad/openscad-playground/blob/main/LICENSE.md" target="_blank" rel="noreferrer">LICENSES</a>
          <a href="https://openscad.org/documentation.html" target="_blank" rel="noreferrer">OpenSCAD Docs</a>
          <a href="https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Customizer" target="_blank" rel="noreferrer">Customizer Syntax</a>
          <a href="https://openscad.org/cheatsheet/" target="_blank" rel="noreferrer">OpenSCAD Cheatsheet</a>
          <a href="https://github.com/BelfrySCAD/BOSL2/wiki/CheatSheet" target="_blank" rel="noreferrer">BOSL2 Cheatsheet</a>
        </div>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-help-menu': OscHelpMenu;
  }
}
