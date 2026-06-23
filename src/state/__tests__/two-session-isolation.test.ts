// Gate B capstone (ADR 0007): two full OpenScadSessions on one page are
// completely isolated end to end — a compile, and a teardown, in one session
// never touch the other's engine, pending jobs, or worker generation. This is
// the integration-level proof the slice work was building toward.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpenScadSession } from '../session.ts';
import { WasmWorkerBackend } from '../../runner/openscad-runner.ts';
import type { State } from '../app-state.ts';
import type { ProjectFileSystem } from '../../fs/project-filesystem.ts';

// A worker that never responds, so submitted jobs stay observable in `pending`.
class SilentWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

function baseState(): State {
  return {
    params: {
      activePath: '/m.scad',
      sources: [{ kind: 'text', path: '/m.scad', content: 'cube(10);' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
      autoCompile: false,
    },
    view: {
      layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
      color: '#000',
    },
  } as State;
}

const fakeFs = {
  readFileSync: () => new Uint8Array(),
  writeFile: () => {},
} as unknown as ProjectFileSystem;

// render() materializes sources on a microtask before spawning; let it settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Gate B — two independent sessions', () => {
  beforeAll(() => {
    (globalThis as unknown as Record<string, unknown>).Worker = SilentWorker;
  });
  afterAll(() => {
    delete (globalThis as unknown as Record<string, unknown>).Worker;
  });

  it('compile + dispose in one session do not affect the other', async () => {
    const a = new OpenScadSession(fakeFs, baseState());
    const b = new OpenScadSession(fakeFs, baseState());
    const aEngine = a.backend as WasmWorkerBackend;
    const bEngine = b.backend as WasmWorkerBackend;

    // Each session compiles — on its OWN engine.
    a.model.render({ isPreview: true, now: true }).catch(() => {});
    b.model.render({ isPreview: true, now: true }).catch(() => {});
    await flush();

    expect(aEngine.pending.size).toBe(1);
    expect(bEngine.pending.size).toBe(1);
    expect(aEngine).not.toBe(bEngine); // distinct engines, distinct workers

    // Tearing down A rejects A's job and bumps A's generation; B is untouched.
    a.dispose();
    expect(aEngine.pending.size).toBe(0);
    expect(aEngine.generation).toBe(1);
    expect(bEngine.pending.size).toBe(1);
    expect(bEngine.generation).toBe(0);

    b.dispose();
  });
});
