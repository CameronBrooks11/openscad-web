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
  /** Every invocation received, so tests can assert what crossed to the worker. */
  invocations: OpenSCADInvocation[] = [];

  spawn(invocation: OpenSCADInvocation): AbortablePromise<OpenSCADInvocationResults> {
    this.invocations.push(invocation);
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
const revokedUrls: string[] = [];
const host = {
  createObjectURL: () => `blob:fake-${urlN++}`,
  revokeObjectURL: (url: string) => {
    revokedUrls.push(url);
  },
  download: () => {},
  downloadBlob: () => {},
  playCompletionChime: () => {},
  baseUrl: () => 'http://localhost/',
} as unknown as HostAdapter;

// Stateful: binary assets written by setProject (#172) are read back at compile
// time by materializeBinarySources (ADR 0006), so the fake must round-trip them.
const fsStore = new Map<string, Uint8Array>();
const fakeFs = {
  readFileSync: (path: string) => {
    const bytes = fsStore.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  },
  writeFile: () => {},
  writeBytes: (path: string, bytes: Uint8Array) => {
    fsStore.set(path, bytes);
  },
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

function makeModel(backend: FakeBackend, fs: ProjectFileSystem = fakeFs) {
  const model = new Model(
    fs,
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
  beforeEach(() => {
    vi.useFakeTimers();
    fsStore.clear();
    revokedUrls.length = 0;
  });
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

  it('setProject with a binary asset lands a local source and ships its exact bytes to the worker (#172)', async () => {
    const backend = new FakeBackend();
    const { model, ops } = makeModel(backend);
    const stlBytes = Uint8Array.from([0x53, 0x54, 0x4c, 0x00, 0xff, 0x01]);

    model.setProject(
      [
        { path: 'main.scad', content: 'import("part.stl");' },
        { path: 'assets/part.stl', bytes: stlBytes },
      ],
      'main.scad',
    );
    await settle();

    // The binary landed as a content-less `local` source; the text stayed editable.
    expect(model.state.params.sources).toEqual(
      expect.arrayContaining([
        { kind: 'local', path: '/home/assets/part.stl' },
        { kind: 'text', path: '/home/main.scad', content: 'import("part.stl");' },
      ]),
    );
    expect(model.state.params.activePath).toBe('/home/main.scad');

    // The compile succeeded, and the worker request carried the asset's EXACT
    // bytes (materialized off the FS — ADR 0006), not a stringified corruption.
    expect(ops.find((o) => o.status === 'success' && o.artifact)).toBeDefined();
    const wire = backend.invocations
      .flatMap((i) => i.inputs ?? [])
      .find((s) => s.path === '/home/assets/part.stl');
    expect(wire).toBeDefined();
    expect(wire!.content).toEqual(stlBytes);
  });

  it('a binary entryPoint is allowed — the engine renders it via its import wrapper (#121)', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject(
      [
        { path: 'main.scad', content: 'cube(1);' },
        { path: 'part.stl', bytes: Uint8Array.from([1, 2, 3]) },
      ],
      'part.stl',
    );
    await settle();
    expect(model.state.params.activePath).toBe('/home/part.stl');
    expect(ops.find((o) => o.status === 'success' && o.artifact)).toBeDefined();
  });

  it('an all-binary project with no entryPoint selects and renders the binary (the implicit door)', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject([{ path: 'part.stl', bytes: Uint8Array.from([1, 2, 3]) }]);
    await settle();
    expect(model.state.params.activePath).toBe('/home/part.stl');
    expect(model.state.params.sources).toEqual([{ kind: 'local', path: '/home/part.stl' }]);
    expect(ops.find((o) => o.status === 'success' && o.artifact)).toBeDefined();
  });

  it('bytes at a text-suffix path decode to an ordinary text source; invalid UTF-8 rejects atomically', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject([{ path: 'main.scad', bytes: new TextEncoder().encode('cube(2);') }]);
    await settle();
    // Valid UTF-8 at .scad → a text source, exactly as if pushed as content.
    expect(model.state.params.sources).toEqual([
      { kind: 'text', path: '/home/main.scad', content: 'cube(2);' },
    ]);
    expect(ops.find((o) => o.status === 'success' && o.artifact)).toBeDefined();

    // Invalid UTF-8 at a text path rejects the whole push (no silent mojibake).
    const before = model.state.params.sources;
    model.setProject([{ path: 'other.scad', bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0xff]) }]);
    await settle();
    expect(model.state.params.sources).toBe(before);
    expect(model.state.errorDetails).toMatch(/not valid UTF-8/);
  });

  it('a truly-binary push on a filesystem without writeBytes rejects loudly up front', async () => {
    const noBytesFs = {
      readFileSync: () => new Uint8Array(),
      writeFile: () => {},
    } as unknown as ProjectFileSystem;
    const { model, ops } = makeModel(new FakeBackend(), noBytesFs);
    const before = model.state.params.sources;
    model.setProject([
      { path: 'main.scad', content: 'import("p.stl");' },
      { path: 'p.stl', bytes: Uint8Array.from([1]) },
    ]);
    await settle();
    expect(model.state.params.sources).toBe(before);
    expect(model.state.errorDetails).toMatch(/cannot store binary assets/);
    expect(ops).toEqual([]);
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

  it('exportArtifact drives a kind:export success carrying the requested format (#216)', async () => {
    const backend = new FakeBackend();
    const { model, ops } = makeModel(backend);
    model.setProject([{ path: 'main.scad', content: 'cube(1);' }], 'main.scad');
    await settle();
    expect(ops.find((o) => o.status === 'success' && o.artifact)).toBeDefined();

    model.exportArtifact('stl');
    await settle();

    const exported = ops.find((o) => o.kind === 'export');
    expect(exported).toBeDefined();
    expect(exported!.status).toBe('success');
    if (exported!.status === 'success') {
      expect(exported!.artifact?.format).toBe('stl');
      // The export's exact bytes are retrievable by id — the getArtifact flow.
      expect(model.getStoredArtifact(exported!.artifact!.artifactId)).toBeDefined();
    }
  });

  it('exportArtifact does not mutate the persisted format settings, and off pass-through works (#216 review)', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject([{ path: 'main.scad', content: 'cube(1);' }], 'main.scad');
    await settle();

    // 'off' pass-through: the preview output IS the OFF — same artifact identity.
    model.exportArtifact('off');
    await settle();
    const exported = ops.find((o) => o.kind === 'export');
    expect(exported?.status).toBe('success');
    if (exported?.status === 'success') {
      expect(exported.artifact?.format).toBe('off');
    }
    // The persisted settings are untouched (a per-request format must not flip
    // subsequent previews' render format — the review's pollution finding).
    expect(model.state.params.exportFormat3D).toBe('stl');
    expect(model.state.params.exportFormat2D).toBe('svg');
  });

  it("an export's ArtifactRef carries the CONSUMED output's revision, not the edit counter (#216 review)", async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject([{ path: 'main.scad', content: 'cube(1);' }], 'main.scad');
    await settle();
    const preview = ops.find((o) => o.status === 'success' && o.artifact);
    expect(preview).toBeDefined();
    const previewRevision = (preview as { artifact: { sourceRevision: number } }).artifact
      .sourceRevision;

    // Edit (bumps the revision) then export IMMEDIATELY — before the new
    // preview lands. The export converts the OLD output and must say so.
    model.updateFile('/home/main.scad', 'cube(2);');
    model.exportArtifact('stl');
    await settle();

    const exported = ops.find((o) => o.kind === 'export' && o.status === 'success');
    expect(exported).toBeDefined();
    expect((exported as { artifact: { sourceRevision: number } }).artifact.sourceRevision).toBe(
      previewRevision,
    );
  });

  it('a pass-through export does not let a later conversion revoke the live output URL (#216 review)', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject([{ path: 'main.scad', content: 'cube(1);' }], 'main.scad');
    await settle();
    const outputUrl = model.state.output!.outFileURL;

    model.exportArtifact('off'); // pass-through: aliases the output URL
    await settle();
    model.exportArtifact('stl'); // conversion: must NOT revoke the aliased URL
    await settle();

    expect(ops.filter((o) => o.kind === 'export' && o.status === 'success')).toHaveLength(2);
    expect(revokedUrls).not.toContain(outputUrl);
  });

  it('exportArtifact before any completed compile fails with no-output, not a misleading mismatch (#216 review)', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    // No compile has run (makeModel never calls init()).
    model.exportArtifact('svg');
    await settle();
    const exported = ops.find((o) => o.kind === 'export');
    expect(exported?.status).toBe('error');
    if (exported?.status === 'error') {
      expect(exported.code).toBe('no-output');
    }
  });

  it('exportArtifact terminates a dimensionality mismatch as an export failure, not silence (#216)', async () => {
    const { model, ops } = makeModel(new FakeBackend());
    model.setProject([{ path: 'main.scad', content: 'cube(1);' }], 'main.scad');
    await settle();

    model.exportArtifact('svg'); // 2D format, 3D model
    await settle();

    const exported = ops.find((o) => o.kind === 'export');
    expect(exported).toBeDefined();
    expect(exported!.status).toBe('error');
    if (exported!.status === 'error') {
      expect(exported!.code).toBe('export-format-mismatch');
      expect(exported!.reason).toMatch(/3D/);
    }
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
