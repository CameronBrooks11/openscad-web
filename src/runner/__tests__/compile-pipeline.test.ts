// Compile-pipeline tests
//
// Covers:
//   1. buildOpenScadArgs — the single source of truth for OpenSCAD CLI args,
//      including feature-flag safety (no implicit --enable=lazy-union).
//   2. spawnOpenSCAD — the JS-layer request/response loop, exercised via a fake
//      Worker that posts synthetic result/error messages back to the runner.
//
// Full round-trip compilation with real WASM remains intentionally deferred from
// this JS-layer suite; the fake-Worker harness provides the focused coverage here.

import { buildOpenScadArgs } from '../actions.ts';
import { clearPerfSnapshot, getPerfSnapshot } from '../../perf/runtime-performance.ts';

// ---------------------------------------------------------------------------
// Fake Worker that drives the runner message loop
// ---------------------------------------------------------------------------
type FakeWorkerSpec = {
  responseType?: 'result' | 'error';
  exitCode?: number;
  message?: string;
  stderrLines?: string[];
  perf?: {
    workerFsInitMillis?: number;
    workerLibraryMountMillis?: number;
    workerWasmInitMillis?: number;
    workerJobMillis?: number;
  };
};

let _workerSpecs: FakeWorkerSpec[] = [];

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(msg: { type: string; id: string }) {
    if (msg.type !== 'compile') return;
    const spec = _workerSpecs.shift();
    if (!spec) throw new Error('FakeWorker: no spec queued for this compile call');
    const mergedOutputs = (spec.stderrLines ?? []).map((text) => ({ stderr: text }));
    const response =
      spec.responseType === 'error'
        ? {
            type: 'error' as const,
            id: msg.id,
            message: spec.message ?? 'Worker error',
            mergedOutputs,
            elapsedMillis: 0,
            perf: spec.perf,
          }
        : {
            type: 'result' as const,
            id: msg.id,
            exitCode: spec.exitCode ?? 0,
            outputs: [] as [string, Uint8Array][],
            mergedOutputs,
            elapsedMillis: 0,
            perf: spec.perf,
          };
    // Deliver asynchronously (mirrors real Worker MessageEvent timing)
    setTimeout(() => this.onmessage?.({ data: response } as MessageEvent), 0);
  }

  terminate() {}
}

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).Worker = FakeWorker;
});

beforeEach(() => {
  vi.clearAllMocks();
  _workerSpecs = [];
  clearPerfSnapshot();
});

// Imported after the FakeWorker is staged so the runner picks it up lazily.
import { spawnOpenSCAD } from '../openscad-runner.ts';

// ---------------------------------------------------------------------------
// buildOpenScadArgs — single source of truth
// ---------------------------------------------------------------------------

describe('buildOpenScadArgs', () => {
  it('builds the positional path, output, and export format', () => {
    expect(
      buildOpenScadArgs({ scadPath: 'm.scad', outFile: 'o.off', exportFormat: 'off' }),
    ).toEqual(['m.scad', '-o', 'o.off', '--export-format=off']);
  });

  it('omits --backend when no backend is requested (e.g. syntax pass)', () => {
    const args = buildOpenScadArgs({
      scadPath: 'm.scad',
      outFile: 'o.json',
      exportFormat: 'param',
    });
    expect(args.some((a) => a.startsWith('--backend='))).toBe(false);
  });

  it('includes the requested backend', () => {
    const args = buildOpenScadArgs({
      scadPath: 'm.scad',
      outFile: 'o.off',
      exportFormat: 'off',
      backend: 'manifold',
    });
    expect(args).toContain('--backend=manifold');
  });

  it('does not implicitly enable lazy-union', () => {
    const args = buildOpenScadArgs({
      scadPath: 'm.scad',
      outFile: 'o.off',
      exportFormat: 'off',
      backend: 'manifold',
    });
    expect(args.filter((a) => a.startsWith('--enable='))).not.toContain('--enable=lazy-union');
  });

  it('emits -D for vars, --enable for features, and appends extra args', () => {
    const args = buildOpenScadArgs({
      scadPath: 'm.scad',
      outFile: 'o.off',
      exportFormat: 'off',
      backend: 'manifold',
      vars: { n: 3, label: 'hi' },
      features: ['fast-csg'],
      extraArgs: ['--quiet'],
    });
    expect(args).toContain('-Dn=3');
    expect(args).toContain('-Dlabel="hi"');
    expect(args).toContain('--enable=fast-csg');
    expect(args).toContain('--quiet');
  });

  it('emits the full render arg list in a stable order', () => {
    expect(
      buildOpenScadArgs({
        scadPath: 'm.scad',
        outFile: 'o.off',
        exportFormat: 'off',
        backend: 'manifold',
        vars: { n: 3 },
        features: ['fast-csg'],
        extraArgs: ['--quiet'],
      }),
    ).toEqual([
      'm.scad',
      '-o',
      'o.off',
      '--backend=manifold',
      '--export-format=off',
      '-Dn=3',
      '--enable=fast-csg',
      '--quiet',
    ]);
  });

  it('throws a parameter-scoped error for an invalid var value', () => {
    expect(() =>
      buildOpenScadArgs({
        scadPath: 'm.scad',
        outFile: 'o.off',
        exportFormat: 'off',
        vars: { bad: NaN },
      }),
    ).toThrow(/parameter "bad"/);
  });
});

// ---------------------------------------------------------------------------
// spawnOpenSCAD — JS-layer request/response loop
// ---------------------------------------------------------------------------

describe('spawnOpenSCAD', () => {
  it('resolves with the worker exit code on success', async () => {
    _workerSpecs.push({ exitCode: 0 });
    const result = await spawnOpenSCAD({ mountArchives: true, args: ['m.scad'] }, vi.fn());
    expect(result.exitCode).toBe(0);
  });

  it('preserves an explicit worker error response', async () => {
    _workerSpecs.push({
      responseType: 'error',
      message: 'boom',
      stderrLines: ['runtime exploded'],
      perf: { workerJobMillis: 33 },
    });

    const result = await spawnOpenSCAD({ mountArchives: true, args: ['m.scad'] }, vi.fn());

    expect(result.error).toBe('boom');
    expect(result.exitCode).toBeUndefined();
    expect(getPerfSnapshot().metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-job-total', duration: 33 }),
    );
  });

  it('records worker perf timings from a successful compile response', async () => {
    _workerSpecs.push({
      exitCode: 0,
      perf: {
        workerFsInitMillis: 12,
        workerLibraryMountMillis: 8,
        workerWasmInitMillis: 44,
        workerJobMillis: 65,
      },
    });

    const result = await spawnOpenSCAD({ mountArchives: true, args: ['m.scad'] }, vi.fn());

    expect(result.perf?.workerWasmInitMillis).toBe(44);
    const snapshot = getPerfSnapshot();
    expect(snapshot.metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-fs-init', duration: 12 }),
    );
    expect(snapshot.metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-wasm-init', duration: 44 }),
    );
  });
});
