// The iframe/embedded `Transport`: outbound goes to the parent frame, inbound is
// trusted only from that frame AND the configured origin. This is the original
// viewer-entry behaviour, extracted verbatim (ADR 0005 / #143).

import { isTrustedOrigin } from '../../protocol/envelope.ts';
import type { Transport } from '../transport.ts';

/** Parse `?parentOrigin=…` to a bare origin, rejecting malformed values and
 *  unsupported schemes (never the wildcard); a bad value falls back to
 *  same-origin-only trust. Exported for unit testing. */
export function canonicalOrigin(raw: string | null): string | null {
  if (raw == null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export class BrowserParentTransport implements Transport {
  private readonly selfOrigin = window.location.origin;
  private readonly parentOrigin = canonicalOrigin(
    new URLSearchParams(window.location.search).get('parentOrigin'),
  );
  private readonly targetOrigin = this.parentOrigin ?? this.selfOrigin;
  // Embedded (iframe / webview): the host is the parent frame. Opened top-level
  // there is no host — don't post to ourselves and re-enter our own handler.
  private readonly host: Window | null = window.parent !== window ? window.parent : null;
  private listener: ((e: MessageEvent) => void) | null = null;

  send(message: object): void {
    this.host?.postMessage(message, this.targetOrigin);
  }

  subscribe(handler: (payload: unknown) => void): void {
    this.detach();
    const listener = (event: MessageEvent): void => {
      // Trust both the origin AND the sender window: a same-origin sibling frame
      // must not drive the viewer; when embedded, only the host frame.
      if (this.host !== null && event.source !== this.host) return;
      if (!isTrustedOrigin(event.origin, this.parentOrigin, this.selfOrigin)) return;
      handler(event.data);
    };
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
