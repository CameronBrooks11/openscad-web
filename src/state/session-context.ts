import type { OpenScadSession } from './session.ts';

// A DOM-ancestor session provider (ADR 0007), replacing the former global
// `getModel()` singleton. A shell registers itself as the provider for its
// subtree; any descendant resolves the nearest one. Resolution THROWS when no
// provider is found, so an element mounted outside a session fails loudly rather
// than silently binding to the wrong (or a default) session — the cross-session
// leak Gate B exists to prevent.

const SESSION_REQUEST = 'osc-session-request';

type SessionRequestDetail = { session?: OpenScadSession };

/**
 * Mark `host` as the session provider for its DOM subtree. Call once in the
 * shell's `connectedCallback`, before any descendant connects (a parent's
 * connectedCallback runs before its children's first render).
 */
export function provideSession(host: HTMLElement, session: OpenScadSession): void {
  host.addEventListener(SESSION_REQUEST, (e: Event) => {
    (e as CustomEvent<SessionRequestDetail>).detail.session = session;
    e.stopPropagation(); // the nearest provider wins
  });
}

/**
 * Resolve the session provided by the nearest ancestor of `el`. Throws if there
 * is no provider in the ancestry.
 */
export function resolveSession(el: HTMLElement): OpenScadSession {
  const detail: SessionRequestDetail = {};
  el.dispatchEvent(
    new CustomEvent<SessionRequestDetail>(SESSION_REQUEST, {
      detail,
      bubbles: true,
      composed: true,
    }),
  );
  if (!detail.session) {
    throw new Error(
      `No OpenScadSession provider in ancestry for <${el.localName}> — ` +
        'an element was mounted outside a session shell.',
    );
  }
  return detail.session;
}
