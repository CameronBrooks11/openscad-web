// The VS Code webview `Transport`: outbound via the once-acquired vscode API,
// inbound from the extension over the webview channel. Unlike the iframe
// transport there is NO origin or sender-window check — the webview channel
// itself is the trust boundary (the only sender is the extension host). Payloads
// are still validated by the controller (DoS/format hygiene on a trusted channel).

import type { Transport } from '../transport.ts';

export class VsCodeWebviewTransport implements Transport {
  // Acquired exactly once, at construction; the handle is held for the session.
  private readonly api = acquireVsCodeApi();
  private listener: ((e: MessageEvent) => void) | null = null;

  send(message: object): void {
    this.api.postMessage(message);
  }

  subscribe(handler: (payload: unknown) => void): void {
    this.detach();
    const listener = (event: MessageEvent): void => handler(event.data);
    this.listener = listener;
    window.addEventListener('message', listener);
  }

  dispose(): void {
    this.detach();
  }

  private detach(): void {
    if (this.listener) {
      window.removeEventListener('message', this.listener);
      this.listener = null;
    }
  }
}
