// T4 — Compile-pipeline tests
//
// Covers:
//   1. Feature-flag safety: getDefaultCompileArgs() must not include --enable=lazy-union
//   2. compileWithFallback: success path, no-retry path, and missing-library retry path
//
// compileWithFallback calls spawnOpenSCAD from the same module, so we cannot
// mock spawnOpenSCAD via jest.mock without breaking the internal call chain.
// Instead, we install a fake Worker in globalThis that immediately posts a
// synthetic "result" message back to the runner, exercising the full JS-layer
// path without requiring a real WASM binary.
//
// Full round-trip compilation with real WASM is deferred (see
// working/reference/deferred-items.md) because openscad.js uses import.meta.url
// and ESM exports that cannot load in jest CJS environment.

import { getDefaultCompileArgs } from '../actions.ts';

// ---------------------------------------------------------------------------
// Mock filesystem.ts — used by compileWithFallback for on-demand library mount
// ---------------------------------------------------------------------------
jest.mock('../../fs/filesystem.ts', () => ({
  mountDemandLibraries: jest.fn().mockResolvedValue([]),
  extractLibraryNames: jest.fn().mockReturnValue([]),
  createEditorFS: jest.fn().mockResolvedValue(undefined),
  preloadAllLibraries: jest.fn().mockResolvedValue(undefined),
  symlinkLibraries: jest.fn().mockResolvedValue(undefined),
  saveActiveFile: jest.fn().mockResolvedValue(false),
  openLocalFile: jest.fn().mockResolvedValue(null),
  clearActiveFileHandle: jest.fn(),
  getParentDir: jest.fn((p: string) => p.split('/').slice(0, -1).join('/') || '/'),
  join: jest.fn((...args: string[]) => args.join('/')),
}));

import { compileWithFallback } from '../openscad-runner.ts';
import { mountDemandLibraries } from '../../fs/filesystem.ts';

const mockMount = mountDemandLibraries as jest.Mock;

// ---------------------------------------------------------------------------
// Fake Worker that drives the runner message loop
// ---------------------------------------------------------------------------
type FakeWorkerSpec = {
  exitCode: number;
  stderrLines?: string[];
};

let _workerSpecs: FakeWorkerSpec[] = [];

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(msg: { type: string; id: string }) {
    if (msg.type !== 'compile') return;
    const spec = _workerSpecs.shift();
    if (!spec) throw new Error('FakeWorker: no spec queued for this compile call');
    const mergedOutputs = (spec.stderrLines ?? []).map(text => ({ stderr: text }));
    const response = {
      type: 'result' as const,
      id: msg.id,
      exitCode: spec.exitCode,
      outputs: [] as [string, Uint8Array][],
      mergedOutputs,
      elapsedMillis: 0,
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
  jest.clearAllMocks();
  _workerSpecs = [];
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
    const enableFlags = getDefaultCompileArgs().filter(
      (a: string) => a.startsWith('--enable='),
    );
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
      jest.fn(),
    );

    expect(result.exitCode).toBe(0);
    expect(mockMount).not.toHaveBeenCalled();
  });

  it('returns failure without retry when error is unrelated to missing library', async () => {
    _workerSpecs.push({ exitCode: 1, stderrLines: ['CGAL error: invalid operation'] });

    const result = await compileWithFallback(
      { mountArchives: true, args: ['test.scad', '-o', 'out.off'] },
      jest.fn(),
    );

    expect(result.exitCode).toBe(1);
    expect(mockMount).not.toHaveBeenCalled();
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
      jest.fn(),
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
      jest.fn(),
    );

    expect(result.exitCode).toBe(1);
    expect(_workerSpecs).toHaveLength(0); // only one spec pushed, was consumed
    expect(mockMount).toHaveBeenCalledTimes(1);
  });
});
