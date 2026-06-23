// Gate B slice 1: the compile engine is instance-scoped (WasmWorkerBackend), so
// two backends are fully isolated — no shared id space, pending map, or worker
// generation. This is the property the later session work depends on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WasmWorkerBackend, type OpenSCADInvocation } from '../openscad-runner.ts';

// A worker that never responds, so submitted jobs stay observable in `pending`.
class SilentWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

const INVOCATION: OpenSCADInvocation = { mountArchives: false, args: ['x.scad'] };

describe('WasmWorkerBackend isolation', () => {
  beforeAll(() => {
    (globalThis as unknown as Record<string, unknown>).Worker = SilentWorker;
  });
  afterAll(() => {
    delete (globalThis as unknown as Record<string, unknown>).Worker;
  });

  it('two backends have independent id spaces, pending maps, and generations', () => {
    const a = new WasmWorkerBackend();
    const b = new WasmWorkerBackend();

    const pa = a.spawn(INVOCATION, () => {}).catch(() => {});
    const pb = b.spawn(INVOCATION, () => {}).catch(() => {});

    // Each backend mints "1" from its own counter — not a shared sequence.
    expect([...a.pending.keys()]).toEqual(['1']);
    expect([...b.pending.keys()]).toEqual(['1']);
    expect(a.nextId).toBe(1);
    expect(b.nextId).toBe(1);

    // Disposing one rejects only its own jobs and bumps only its own generation.
    const genB = b.generation;
    a.dispose();
    expect(a.generation).toBe(1);
    expect(a.pending.size).toBe(0); // a's job was rejected + cleared
    expect(b.generation).toBe(genB); // b untouched
    expect(b.pending.size).toBe(1); // b's job intact

    b.dispose(); // cleanup: reject b's job + clear its queue timer
    return Promise.allSettled([pa, pb]);
  });
});
