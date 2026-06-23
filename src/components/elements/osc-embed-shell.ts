// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
// EmbedShell — minimal viewer for ?mode=embed URLs. Supports optional customizer controls,
// download button, and a postMessage API.
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { provideSession } from '../../state/session-context.ts';
import type { OpenScadSession } from '../../state/session.ts';
import { UrlModeParams, fetchExternalModel } from '../../state/url-mode.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';
import './osc-viewer-panel.ts';
import './osc-customizer-panel.ts';
import { validateInbound, outbound, isTrustedOrigin } from '../../embed/protocol.ts';
import { outputArtifactRef } from '../../embed/artifact-event.ts';
import { coerceUrlVars } from '../../openscad-value.ts';

// ---------------------------------------------------------------------------
// postMessage protocol — see src/embed/protocol.ts and docs/EMBED.md
// ---------------------------------------------------------------------------

function notifyHost(
  type: string,
  targetOrigin: string,
  payload?: Record<string, unknown>,
  transfer?: Transferable[],
) {
  if (window.parent !== window) {
    window.parent.postMessage(outbound(type, payload), targetOrigin, transfer ?? []);
  }
}

function getVarsSnapshot(st: State): Record<string, unknown> {
  const defaults = Object.fromEntries(
    (st.parameterSet?.parameters ?? []).map((parameter) => [parameter.name, parameter.initial]),
  );
  return { ...defaults, ...(st.params.vars ?? {}) };
}

@customElement('osc-embed-shell')
export class OscEmbedShell extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      width: 100%;
      height: 100%;
    }
    .viewer-wrap {
      flex: 1;
      position: relative;
    }
    osc-viewer-panel {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    .download-bar {
      padding: 4px 8px;
    }
    .download-bar button {
      cursor: pointer;
      padding: 4px 12px;
    }
    .error {
      padding: 2rem;
      color: var(--osc-error);
    }
  `;

  @property({ attribute: false }) urlParams!: UrlModeParams;
  /** The session this shell hosts (set by the booter before connection). */
  session!: OpenScadSession;
  @state() private _st: State | null = null;
  @state() private _loadError: string | null = null;
  private _model!: Model;
  private _readyNotified = false;
  private _lastSentParamSet: object | null = null;
  private _lastSentRenderURL: string | null = null;
  private _lastSentVars: Record<string, unknown> | null | undefined = undefined;
  /**
   * Resolved peer origin. When `parentOrigin` is configured we target it
   * (explicit-origin mode); otherwise we fall back to this document's own
   * origin (same-origin mode) — never the wildcard `'*'`, so messages are
   * never broadcast to arbitrary origins.
   */
  private _peerOrigin() {
    return this.urlParams?.parentOrigin ?? window.location.origin;
  }
  private _notifyHost(type: string, payload?: Record<string, unknown>, transfer?: Transferable[]) {
    notifyHost(type, this._peerOrigin(), payload, transfer);
  }
  private _acceptsMessage(event: MessageEvent) {
    if (event.source !== window.parent) return false;
    // No default acceptance of arbitrary origins: an unconfigured embed only
    // trusts a same-origin parent; cross-origin parents must set parentOrigin.
    return isTrustedOrigin(
      event.origin,
      this.urlParams?.parentOrigin ?? null,
      window.location.origin,
    );
  }
  private _maybeNotifyReady(st: State) {
    if (this._readyNotified) return;
    if (st.previewing || st.rendering) return;
    if (!st.output && !st.parameterSet && !st.error) return;

    this._readyNotified = true;
    this._lastSentVars = st.params.vars;
    this._notifyHost('ready', {
      vars: getVarsSnapshot(st),
      ...(st.parameterSet ? { parameterSet: st.parameterSet } : {}),
      // Feature flags so a host can detect this build's optional behaviours
      // (ADR 0008). `artifactIdentity`: renderComplete/artifact carry immutable
      // ids and `getArtifact` accepts an `artifactId`.
      capabilities: { artifactIdentity: true },
    });
  }
  private _onState = (e: Event) => {
    const st = (e as CustomEvent<State>).detail;
    this._st = st;

    this._maybeNotifyReady(st);

    if (this._readyNotified && st.params.vars !== this._lastSentVars) {
      this._lastSentVars = st.params.vars;
      this._notifyHost('varsChanged', { vars: getVarsSnapshot(st) });
    }

    if (this._readyNotified && st.parameterSet && st.parameterSet !== this._lastSentParamSet) {
      this._lastSentParamSet = st.parameterSet;
      this._notifyHost('parameterSetLoaded', { parameterSet: st.parameterSet });
    }

    if (st.output && !st.rendering && !st.previewing) {
      if (st.output.outFileURL !== this._lastSentRenderURL) {
        this._lastSentRenderURL = st.output.outFileURL;
        // Send durable metadata + immutable identity only; the host fetches
        // bytes on demand via `getArtifact` (optionally by the advertised
        // `artifactId`). A blob URL owned by the iframe document is not even
        // usable cross-origin, so it is never leaked into the event.
        this._notifyHost('renderComplete', { artifact: outputArtifactRef(st.output) });
      }
    }
  };

  private _messageHandler = (event: MessageEvent) => {
    if (!this._acceptsMessage(event)) return;
    const result = validateInbound(event.data);
    if (!result.ok) {
      this._notifyHost('error', {
        code: result.code,
        reason: result.reason,
        ...(result.requestId ? { requestId: result.requestId } : {}),
      });
      return;
    }
    const msg = result.message;
    const requestId = msg.requestId;
    const ack = requestId ? { requestId } : {};
    switch (msg.type) {
      case 'setModel':
        this._model.source = msg.source;
        this._notifyHost('ack', ack);
        break;
      case 'setVar':
        this._model.setVar(msg.name, msg.value);
        this._notifyHost('ack', ack);
        break;
      case 'getVars':
        this._notifyHost('varsSnapshot', {
          vars: getVarsSnapshot(this._model.state),
          ...(requestId ? { requestId } : {}),
        });
        break;
      case 'getArtifact':
        void this._sendArtifact(requestId, msg.artifactId);
        break;
    }
  };

  /**
   * Respond to `getArtifact` with bytes + immutable identity (transferred).
   * With no `artifactId` this is the current output (byte-identical to v2); with
   * one it is that specific artifact's exact bytes, or `available: false` if it
   * is unknown or has been evicted from the per-session store (ADR 0008).
   */
  private async _sendArtifact(requestId: string | undefined, artifactId: string | undefined) {
    const resolved = this._resolveArtifact(artifactId);
    if (!resolved) {
      this._notifyHost('artifact', { available: false, ...(requestId ? { requestId } : {}) });
      return;
    }
    const bytes = await resolved.file.arrayBuffer();
    this._notifyHost(
      'artifact',
      {
        available: true,
        ...resolved.ref,
        bytes,
        ...(requestId ? { requestId } : {}),
      },
      [bytes],
    );
  }

  /** The requested artifact's ref + File: a specific one from the store, or —
   *  when no id is given — the current output read straight off state (never the
   *  store, so a burst of previews cannot evict the live result). */
  private _resolveArtifact(artifactId: string | undefined) {
    if (artifactId !== undefined) {
      const stored = this._model.getStoredArtifact(artifactId);
      return stored ? { ref: stored.ref, file: stored.bytes } : undefined;
    }
    const output = this._model.state.output;
    return output ? { ref: outputArtifactRef(output), file: output.outFile } : undefined;
  }

  override connectedCallback() {
    super.connectedCallback();
    provideSession(this, this.session);
    this._model = this.session.model;
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
      this._model.mutate((s) => {
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
        this._notifyHost('stateChange', { error: result.error });
        return;
      }
      const preVars = params.prePopulatedVars;
      if (Object.keys(preVars).length > 0) {
        this._model.mutate((s) => {
          s.params.vars = { ...(s.params.vars ?? {}), ...coerceUrlVars(preVars) };
        });
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
      ${params?.embedControls
        ? html`<osc-customizer-panel style="max-height:40vh;"></osc-customizer-panel>`
        : ''}
      ${params?.embedDownload
        ? html`
            <div class="download-bar">
              <button @click=${() => this._model.export()}>Download STL</button>
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-embed-shell': OscEmbedShell;
  }
}
