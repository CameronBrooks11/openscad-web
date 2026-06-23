import { afterEach, describe, expect, it, vi } from 'vitest';

import { VsCodeWebviewTransport } from '../vscode-webview.ts';
import { selectViewerTransport } from '../select.ts';
import { BrowserParentTransport } from '../browser-parent.ts';

// A loose handle to the ambient global, detached from its strict declared type.
const g = globalThis as unknown as { acquireVsCodeApi?: unknown };

/** Install a stub `acquireVsCodeApi` returning a spyable api; returns the spies. */
function stubVsCodeApi() {
  const postMessage = vi.fn();
  const acquire = vi.fn(() => ({
    postMessage,
    getState: () => undefined,
    setState: (s: unknown) => s,
  }));
  g.acquireVsCodeApi = acquire;
  return { postMessage, acquire };
}

afterEach(() => {
  delete g.acquireVsCodeApi;
});

describe('VsCodeWebviewTransport', () => {
  it('acquires the vscode api exactly once and routes send to postMessage', () => {
    const { postMessage, acquire } = stubVsCodeApi();
    const t = new VsCodeWebviewTransport();
    expect(acquire).toHaveBeenCalledTimes(1);
    t.send({ type: 'ready' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('delivers inbound messages WITHOUT any origin/source filtering (trusted channel)', () => {
    stubVsCodeApi();
    const t = new VsCodeWebviewTransport();
    const seen: unknown[] = [];
    t.subscribe((p) => seen.push(p));
    // A message with an "evil" origin and no source is still delivered — the
    // webview channel itself is the trust boundary, unlike the iframe transport.
    window.dispatchEvent(
      new MessageEvent('message', { data: { a: 1 }, origin: 'https://evil.example' }),
    );
    expect(seen).toEqual([{ a: 1 }]);
    t.dispose();
  });

  it('dispose detaches the listener', () => {
    stubVsCodeApi();
    const t = new VsCodeWebviewTransport();
    const seen: unknown[] = [];
    t.subscribe((p) => seen.push(p));
    t.dispose();
    window.dispatchEvent(new MessageEvent('message', { data: { a: 1 }, origin: 'x' }));
    expect(seen).toHaveLength(0);
  });

  it('re-subscribe replaces the prior handler (no double delivery)', () => {
    stubVsCodeApi();
    const t = new VsCodeWebviewTransport();
    const first: unknown[] = [];
    const second: unknown[] = [];
    t.subscribe((p) => first.push(p));
    t.subscribe((p) => second.push(p)); // detaches the first
    window.dispatchEvent(new MessageEvent('message', { data: { a: 1 }, origin: 'x' }));
    expect(first).toHaveLength(0);
    expect(second).toEqual([{ a: 1 }]);
    t.dispose();
  });
});

describe('selectViewerTransport', () => {
  it('picks the VS Code transport when acquireVsCodeApi is present', () => {
    stubVsCodeApi();
    expect(selectViewerTransport()).toBeInstanceOf(VsCodeWebviewTransport);
  });

  it('falls back to the parent-frame transport when it is absent', () => {
    // No stub installed (afterEach cleared any) -> typeof acquireVsCodeApi === 'undefined'.
    expect(selectViewerTransport()).toBeInstanceOf(BrowserParentTransport);
  });
});
