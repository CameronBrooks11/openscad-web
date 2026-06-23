// Gate B slice 3a: a scheduler is bound to a specific CompileBackend, so a
// compile reaches THAT session's engine — not a shared/global one. This is the
// property that closes the engine-sharing gap left by slice 2.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WasmWorkerBackend } from '../openscad-runner.ts';
import { createRenderDelayable } from '../actions.ts';
import type { RenderArgs } from '../actions.ts';

// A worker that never responds, so submitted jobs stay observable in `pending`.
class SilentWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

const RENDER_ARGS: RenderArgs = {
  scadPath: '/m.scad',
  sources: [{ path: '/m.scad', content: 'cube();' }],
  isPreview: true,
  mountArchives: false,
  renderFormat: 'off',
  streamsCallback: () => {},
};

describe('scheduler ↔ backend binding', () => {
  beforeAll(() => {
    (globalThis as unknown as Record<string, unknown>).Worker = SilentWorker;
  });
  afterAll(() => {
    delete (globalThis as unknown as Record<string, unknown>).Worker;
  });

  it('routes a compile to the backend its scheduler was created with', () => {
    const a = new WasmWorkerBackend();
    const b = new WasmWorkerBackend();
    const renderA = createRenderDelayable(a);
    const renderB = createRenderDelayable(b);

    const pa = renderA(RENDER_ARGS)({ now: true }).catch(() => {});
    expect(a.pending.size).toBe(1); // landed in a's engine
    expect(b.pending.size).toBe(0); // not b's

    const pb = renderB(RENDER_ARGS)({ now: true }).catch(() => {});
    expect(b.pending.size).toBe(1); // landed in b's engine
    expect(a.pending.size).toBe(1); // a untouched

    a.dispose();
    b.dispose();
    return Promise.allSettled([pa, pb]);
  });
});
