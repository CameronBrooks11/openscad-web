// T4 — Compile-pipeline tests
//
// Covers:
//   1. Feature-flag safety: getDefaultCompileArgs() must not include --enable=lazy-union
//   2. compileWithFallback: success path, no-retry path, and missing-library retry path
//
// compileWithFallback calls spawnOpenSCAD from the same module, so we cannot
// replace spawnOpenSCAD at the module boundary without breaking the internal call chain.
// Instead, we install a fake Worker in globalThis that immediately posts a
// synthetic "result" message back to the runner, exercising the full JS-layer
// path without requiring a real WASM binary.
//
// Full round-trip compilation with real WASM remains intentionally deferred from
// this JS-layer suite. The Vitest migration removed the old Jest CJS blocker,
// but the fake-Worker harness still provides the focused coverage used here.

import { getDefaultCompileArgs } from '../actions.ts';
import { clearPerfSnapshot, getPerfSnapshot } from '../../perf/runtime-performance.ts';

// ---------------------------------------------------------------------------
// Mock filesystem.ts — used by compileWithFallback for on-demand library mount
// ---------------------------------------------------------------------------
vi.mock('../../fs/filesystem.ts', () => ({
  mountDemandLibraries: vi.fn().mockResolvedValue([]),
  extractLibraryNames: vi.fn().mockReturnValue([]),
  createEditorFS: vi.fn().mockResolvedValue(undefined),
  preloadEditorLibraries: vi.fn().mockResolvedValue(undefined),
  symlinkLibraries: vi.fn().mockResolvedValue(undefined),
  saveActiveFile: vi.fn().mockResolvedValue(false),
  openLocalFile: vi.fn().mockResolvedValue(null),
  clearActiveFileHandle: vi.fn(),
  getParentDir: vi.fn((p: string) => p.split('/').slice(0, -1).join('/') || '/'),
  join: vi.fn((...args: string[]) => args.join('/')),
}));

import { compileWithFallback } from '../openscad-runner.ts';
import { mountDemandLibraries } from '../../fs/filesystem.ts';

const mockMount = mountDemandLibraries as ReturnType<typeof vi.fn>;

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

// Install the FakeWorker globally before module code runs
beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).Worker = FakeWorker;
});

beforeEach(() => {
  vi.clearAllMocks();
  _workerSpecs = [];
  clearPerfSnapshot();
});

// ---------------------------------------------------------------------------
// T4-1 — Feature flags
// ---------------------------------------------------------------------------

describe('compile pipeline — feature flags', () => {
  it('getDefaultCompileArgs returns an array', () => {
    expect(Array.isArray(getDefaultCompileArgs())).toBe(true);
  });

  it('includes --backend=manifold', () => {
    expect(getDefaultCompileArgs()).toContain('--backend=manifold');
  });

  it('does not enable lazy-union', () => {
    const enableFlags = getDefaultCompileArgs().filter((a: string) => a.startsWith('--enable='));
    expect(enableFlags).not.toContain('--enable=lazy-union');
  });
});

// ---------------------------------------------------------------------------
// T4-2 — compileWithFallback success path
// ---------------------------------------------------------------------------

describe('compile pipeline — compileWithFallback success', () => {
  it('resolves with exitCode 0 and does not call mountDemandLibraries', async () => {
    _workerSpecs.push({ exitCode: 0 });

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      vi.fn(),
    );

    expect(result.exitCode).toBe(0);
    expect(mockMount).not.toHaveBeenCalled();
  });

  it('returns failure without retry when error is unrelated to missing library', async () => {
    _workerSpecs.push({ exitCode: 1, stderrLines: ['CGAL error: invalid operation'] });

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      vi.fn(),
    );

    expect(result.exitCode).toBe(1);
    expect(mockMount).not.toHaveBeenCalled();
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

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      vi.fn(),
    );

    expect(result.perf?.workerWasmInitMillis).toBe(44);
    const snapshot = getPerfSnapshot();
    expect(snapshot.metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-fs-init', duration: 12 }),
    );
    expect(snapshot.metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-library-mount', duration: 8 }),
    );
    expect(snapshot.metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-wasm-init', duration: 44 }),
    );
  });

  it('handles explicit worker error responses and preserves the message', async () => {
    _workerSpecs.push({
      responseType: 'error',
      message: 'boom',
      stderrLines: ['runtime exploded'],
      perf: { workerJobMillis: 33 },
    });

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      vi.fn(),
    );

    expect(result.error).toBe('boom');
    expect(result.exitCode).toBeUndefined();
    expect(getPerfSnapshot().metrics).toContainEqual(
      expect.objectContaining({ name: 'osc:worker-job-total', duration: 33 }),
    );
  });
});

// ---------------------------------------------------------------------------
// T4-3 — compileWithFallback retry path
// ---------------------------------------------------------------------------

describe('compile pipeline — compileWithFallback retry on missing library', () => {
  it('mounts the missing library and retries, returning the second result', async () => {
    _workerSpecs.push({
      exitCode: 1,
      stderrLines: ["WARNING: Can't open library 'MCAD/involute_gears.scad'."],
    });
    _workerSpecs.push({ exitCode: 0 }); // retry succeeds

    mockMount.mockResolvedValueOnce(['MCAD']);

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      vi.fn(),
    );

    expect(result.exitCode).toBe(0);
    expect(mockMount).toHaveBeenCalledTimes(1);
    // Both specs consumed (two Worker calls)
    expect(_workerSpecs).toHaveLength(0);
  });

  it('does not retry when mountDemandLibraries returns empty (unknown library)', async () => {
    _workerSpecs.push({
      exitCode: 1,
      stderrLines: ["WARNING: Can't open library 'UnknownLib/foo.scad'."],
    });

    mockMount.mockResolvedValueOnce([]); // nothing mounted

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      vi.fn(),
    );

    expect(result.exitCode).toBe(1);
    expect(_workerSpecs).toHaveLength(0); // only one spec pushed, was consumed
    expect(mockMount).toHaveBeenCalledTimes(1);
  });
});
