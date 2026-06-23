import { afterEach, describe, expect, it } from 'vitest';

import { BrowserParentTransport, canonicalOrigin } from '../browser-parent.ts';

describe('canonicalOrigin', () => {
  it('keeps the origin of a valid http(s) URL', () => {
    expect(canonicalOrigin('https://host.example.com/path?x=1')).toBe('https://host.example.com');
    expect(canonicalOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects null, malformed, the wildcard, and unsupported schemes', () => {
    expect(canonicalOrigin(null)).toBeNull();
    expect(canonicalOrigin('not a url')).toBeNull();
    expect(canonicalOrigin('*')).toBeNull();
    expect(canonicalOrigin('javascript:alert(1)')).toBeNull();
    expect(canonicalOrigin('file:///etc/passwd')).toBeNull();
  });
});

describe('BrowserParentTransport trust filtering', () => {
  const realParent = window.parent;
  const restoreParent = () =>
    Object.defineProperty(window, 'parent', { configurable: true, value: realParent });
  const setParent = (parent: unknown) =>
    Object.defineProperty(window, 'parent', { configurable: true, value: parent });

  afterEach(restoreParent);

  function collect(t: BrowserParentTransport) {
    const seen: unknown[] = [];
    t.subscribe((p) => seen.push(p));
    return seen;
  }

  it('rejects a message from a wrong origin', () => {
    const t = new BrowserParentTransport();
    const seen = collect(t);
    window.dispatchEvent(
      new MessageEvent('message', { data: { a: 1 }, origin: 'https://evil.example' }),
    );
    expect(seen).toHaveLength(0);
    t.dispose();
  });

  it('accepts a message from the trusted (self) origin when top-level', () => {
    const t = new BrowserParentTransport();
    const seen = collect(t);
    window.dispatchEvent(
      new MessageEvent('message', { data: { a: 1 }, origin: window.location.origin }),
    );
    expect(seen).toEqual([{ a: 1 }]);
    t.dispose();
  });

  it('rejects a message whose source is not the host frame (sibling-frame defense)', () => {
    const fakeParent = {} as Window;
    setParent(fakeParent);
    const t = new BrowserParentTransport();
    const seen = collect(t);
    // Correct origin but WRONG source (a sibling, not the host) -> rejected.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { a: 1 },
        origin: window.location.origin,
        source: window as unknown as MessageEventSource,
      }),
    );
    expect(seen).toHaveLength(0);
    // Correct source (the host frame) AND origin -> accepted.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { b: 2 },
        origin: window.location.origin,
        source: fakeParent as unknown as MessageEventSource,
      }),
    );
    expect(seen).toEqual([{ b: 2 }]);
    t.dispose();
  });

  it('dispose detaches the listener', () => {
    const t = new BrowserParentTransport();
    const seen = collect(t);
    t.dispose();
    window.dispatchEvent(
      new MessageEvent('message', { data: { a: 1 }, origin: window.location.origin }),
    );
    expect(seen).toHaveLength(0);
  });
});
