// #123 Gate B capstone: one headless, end-to-end run of the multi-file project
// contract over the REAL Model + CompileCoordinator + actions pipeline, with a
// fake CompileBackend standing in for the WASM worker. Proves the contract's
// operations mutate the project, drive deterministic compiles, surface terminal
// OperationResults (success-with-artifact and cancelled) on the 'operation'
// event, and that an artifact's exact bytes are retrievable by id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Model } from '../model.ts';
import { ArtifactStore } from '../artifact-store.ts';
import type { State } from '../app-state.ts';
import type { HostAdapter } from '../web-host-adapter.ts';
import type { ProjectFileSystem } from '../../fs/project-filesystem.ts';
import type { OperationResult } from '../../runner/compile-contract.ts';
import {
  type CompileBackend,
  type OpenSCADInvocation,
  type OpenSCADInvocationResults,
} from '../../runner/openscad-runner.ts';
import { AbortablePromise } from '../../utils.ts';

// A backend that resolves immediately with canned outputs (one per requested
// output path: valid JSON for the syntax `out.json`, OFF bytes otherwise), or —
// in 'hang' mode — never resolves and rejects on kill() like the real delayable.
class FakeBackend implements CompileBackend {
  mode: 'ok' | 'hang' = 'ok';

  spawn(invocation: OpenSCADInvocation): AbortablePromise<OpenSCADInvocationResults> {
    if (this.mode === 'hang') {
      return AbortablePromise<OpenSCADInvocationResults>(
        (_res, rej) => () => rej(new Error('Cancelled')),
      );
    }
    const outputs = (invocation.outputPaths ?? ['out']).map((p): [string, Uint8Array] => [
      p,
      new TextEncoder().encode(p.endsWith('.json') ? '{}' : 'OFF\n0 0 0\n'),
    ]);
    return AbortablePromise<OpenSCADInvocationResults>((res) => {
      res({ outputs, mergedOutputs: [], elapsedMillis: 1, revision: invocation.revision });
      return () => {};
    });
  }
  cancel(): void {}
  dispose(): void {}
}

let urlN = 0;
const host = {
  createObjectURL: () => `blob:fake-${urlN++}`,
  revokeObjectURL: () => {},
  download: () => {},
  downloadBlob: () => {},
  playCompletionChime: () => {},
  baseUrl: () => 'http://localhost/',
} as unknown as HostAdapter;

const fakeFs = {
  readFileSync: () => new Uint8Array(),
  writeFile: () => {},
} as unknown as ProjectFileSystem;

function baseState(): State {
  return {
    params: {
      activePath: '/home/seed.scad',
      sources: [{ kind: 'text', path: '/home/seed.scad', content: 'cube(0);' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'stl',
    },
    view: {
      layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
      color: '#000',
    },
  } as State;
}

function makeModel(backend: FakeBackend) {
  const model = new Model(
    fakeFs,
    baseState(),
    undefined,
    undefined,
    host,
    backend,
    'sess',
    new ArtifactStore(),
  );
  const ops: OperationResult[] = [];
  model.addEventListener('operation', (e) => ops.push((e as CustomEvent<OperationResult>).detail));
  return { model, ops };
}

// Flush the syntax (300ms) + render (1000ms) debounces and the resolved jobs.
const settle = () => vi.advanceTimersByTimeAsync(1200);

describe('#123 multi-file project contract — headless end to end', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('setProject → render commits a retrievable artifact and a success result', async () => {
    const { model, ops } = makeModel(new FakeBackend());

    model.setProject(
      [
        { path: 'a.scad', content: 'cube(1);' },
        { path: 'main.scad', content: 'use <a.scad>\nsphere(1);' },
      ],
      'main.scad',
    );
    await settle();

    expect(model.state.params.sources.map((s) => s.path)).toEqual([
      '/home/a.scad',
      '/home/main.scad',
    ]);
    expect(model.state.params.activePath).toBe('/home/main.scad');

    const success = ops.find((o) => o.status === 'success' && o.artifact);
    expect(success).toBeDefined();
    if (success?.status === 'success' && success.artifact) {
      expect(success.sessionId).toBe('sess');
      expect(success.artifact.format).toBe('off');
      // The exact bytes are retrievable by the immutable artifactId.
      const stored = model.getStoredArtifact(success.artifact.artifactId);
      expect(stored).toBeDefined();
      expect(stored!.bytes).toBe(model.state.output!.outFile);
    }
  });

  it('updateFile → setEntryPoint → removeFile drive deterministic recompiles', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject(
      [
        { path: 'a.scad', content: 'cube(1);' },
        { path: 'main.scad', content: 'use <a.scad>\nsphere(1);' },
      ],
      'main.scad',
    );
    await settle();

    // Update a non-active file — the entry (which `use`s it) recompiles.
    ops.length = 0;
    model.updateFile('a.scad', 'cube(2);');
    await settle();
    const aSrc = model.state.params.sources.find((s) => s.path === '/home/a.scad');
    expect(aSrc && 'content' in aSrc ? aSrc.content : undefined).toBe('cube(2);');
    expect(ops.some((o) => o.status === 'success')).toBe(true);

    // Switch the entry point.
    model.setEntryPoint('a.scad');
    await settle();
    expect(model.state.params.activePath).toBe('/home/a.scad');

    // Remove the active entry → deterministic re-point to main.scad.
    model.removeFile('a.scad');
    await settle();
    expect(model.state.params.sources.map((s) => s.path)).toEqual(['/home/main.scad']);
    expect(model.state.params.activePath).toBe('/home/main.scad');
  });

  it('cancel() surfaces a terminal cancelled result for the in-flight compile', async () => {
    const backend = new FakeBackend();
    const { model, ops } = makeModel(backend);

    backend.mode = 'hang'; // the next compile never resolves
    model.setProject([{ path: 'main.scad', content: 'sphere(1);' }], 'main.scad');
    await settle(); // the debounced syntax + render jobs start and hang

    model.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(ops.some((o) => o.status === 'cancelled')).toBe(true);
    // The cancelled compile cleared its spinners.
    expect(model.state.rendering).toBeFalsy();
    expect(model.state.previewing).toBeFalsy();
    expect(model.state.checkingSyntax).toBeFalsy();
  });
});
