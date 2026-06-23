import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy compile/IO deps the format-conversion + 3MF paths touch. The
// export render scheduler is now created per ExportService via a factory; mock
// the factory so it always returns the same handle the tests configure/assert on.
const mockRenderExport = vi.fn().mockReturnValue(
  vi.fn().mockResolvedValue({
    outFile: new File(['converted'], 'model.stl'),
    logText: '',
    markers: [],
    elapsedMillis: 1,
  }),
);
vi.mock('../../../runner/actions.ts', () => ({
  createRenderExportDelayable: () => mockRenderExport,
}));
vi.mock('../../../io/import_off.ts', () => ({ parseOff: vi.fn(() => ({})) }));
vi.mock('../../../io/export_3mf.ts', () => ({
  export3MF: vi.fn(() => new Uint8Array([1, 2, 3])),
}));
vi.mock('../../../io/export_glb.ts', () => ({
  exportGLB: vi.fn(async () => new Uint8Array([4, 5, 6]).buffer),
}));
vi.mock('chroma-js', () => ({ default: vi.fn((c: string) => c) }));

import { type RenderOutput } from '../../../runner/actions.ts';
import type { State } from '../../app-state.ts';
import { bubbleUpDeepMutations } from '../../deep-mutate.ts';
import type { HostAdapter } from '../../web-host-adapter.ts';
import { ExportService } from '../export-service.ts';
import type { ServiceContext } from '../service-context.ts';

/**
 * A renderExport mock whose inner thunk returns an AbortablePromise-shaped value
 * (a Promise with a `kill` spy), mirroring the real delayable so the service can
 * own and kill the in-flight render. The promise stays pending until `resolve`
 * (or `reject`) is called by the test.
 */
function hangingRender() {
  let resolve!: (v: RenderOutput) => void;
  let reject!: (e: unknown) => void;
  const kill = vi.fn();
  const inner = vi.fn(() =>
    Object.assign(
      new Promise<RenderOutput>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
      { kill },
    ),
  );
  return {
    inner,
    kill,
    resolve: (v: RenderOutput) => resolve(v),
    reject: (e: unknown) => reject(e),
  };
}

function fileOutput(name: string, url = 'blob:out'): State['output'] {
  const f = new File(['x'], name);
  return {
    isPreview: false,
    outFile: f,
    outFileURL: url,
    elapsedMillis: 0,
    formattedElapsedMillis: '0ms',
    formattedOutFileSize: '1 B',
    artifactId: 'art',
    operationId: 'op',
    sourceRevision: 0,
  };
}

function makeCtx(partial: Partial<State['params']> & { is2D?: boolean; output?: State['output'] }) {
  let state: State = {
    params: {
      activePath: '/a.scad',
      sources: [{ kind: 'text', path: '/a.scad', content: 'cube();' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'off',
      ...partial,
    },
    view: {
      layout: { mode: 'multi', editor: true, viewer: true, customizer: false },
      color: '#000',
    },
    is2D: partial.is2D,
    output: partial.output,
  };
  const host = {
    createObjectURL: vi.fn(() => 'blob:new'),
    revokeObjectURL: vi.fn(),
    download: vi.fn(),
    downloadBlob: vi.fn(),
    playCompletionChime: vi.fn(),
    baseUrl: vi.fn(() => 'http://localhost/'),
  } satisfies HostAdapter;
  const ctx: ServiceContext = {
    getState: () => state,
    // Use the real deep-mutate so the fake matches production identity
    // semantics — a service that read a stale snapshot after a mutate would be
    // caught here, not masked by an in-place fake.
    mutate: (f) => {
      const next = bubbleUpDeepMutations(state, f);
      const changed = next !== state;
      state = next;
      return changed;
    },
    getSourceRevision: () => 0,
    getActiveSource: () => '',
    host,
    fs: { readFileSync: vi.fn(), writeFile: vi.fn() },
    backend: { spawn: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
    sessionId: 'test-session',
  };
  return { ctx, host, getState: () => state };
}

describe('ExportService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloads the rendered file directly on an svg pass-through (2D)', async () => {
    const { ctx, host } = makeCtx({
      is2D: true,
      exportFormat2D: 'svg',
      output: fileOutput('m.svg'),
    });
    await new ExportService(ctx).export();
    expect(host.download).toHaveBeenCalledWith('blob:out', 'm.svg');
    expect(mockRenderExport).not.toHaveBeenCalled();
  });

  it('converts to glb in-browser (no worker render) and downloads a .glb', async () => {
    const { ctx, host } = makeCtx({
      is2D: false,
      exportFormat3D: 'glb',
      output: fileOutput('m.off'),
    });
    await new ExportService(ctx).export();
    expect(host.download).toHaveBeenCalledTimes(1);
    expect(host.download.mock.calls[0][1]).toBe('m.glb');
    // GLB is produced from the OFF in-browser, not via a worker render.
    expect(mockRenderExport).not.toHaveBeenCalled();
  });

  it('opens the multimaterial picker for 3mf without extruder colors', async () => {
    const { ctx, getState } = makeCtx({
      is2D: false,
      exportFormat3D: '3mf',
      output: fileOutput('m.off'),
    });
    await new ExportService(ctx).export();
    expect(getState().view.extruderPickerVisibility).toBe('exporting');
    expect(mockRenderExport).not.toHaveBeenCalled();
  });

  it('converts to 3mf when extruder colors are set, then downloads', async () => {
    const { ctx, host } = makeCtx({
      is2D: false,
      exportFormat3D: '3mf',
      extruderColors: ['#fff'],
      output: fileOutput('m.off'),
    });
    await new ExportService(ctx).export();
    expect(host.download).toHaveBeenCalledTimes(1);
    const [, name] = host.download.mock.calls[0];
    expect(name).toBe('m.3mf');
  });

  it('renders a format conversion for non-passthrough formats (e.g. stl)', async () => {
    const { ctx, host } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    await new ExportService(ctx).export();
    expect(mockRenderExport).toHaveBeenCalledTimes(1);
    // Export runs on its own scheduling priority (preempts background compiles).
    expect(mockRenderExport.mock.calls[0][0].priority).toBe('export');
    expect(host.download).toHaveBeenCalledWith('blob:new', 'model.stl');
  });

  it('drops a superseded export result instead of clobbering the newer one', async () => {
    const { ctx, host, getState } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);

    // First export's conversion hangs; the second resolves immediately.
    const first = hangingRender();
    const secondInner = vi.fn().mockResolvedValue({
      outFile: new File(['second'], 'second.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(first.inner).mockReturnValueOnce(secondInner);

    const p1 = svc.export(); // token 1 — awaits the hanging conversion
    const p2 = svc.export(); // token 2 — resolves and commits
    await p2;
    // The superseding export killed the first render job.
    expect(first.kill).toHaveBeenCalled();
    // Now let the first (superseded) export finish; its token is stale.
    first.resolve({
      outFile: new File(['first'], 'first.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    await p1;

    // Only the newer export downloaded; the stale one was dropped.
    expect(host.download.mock.calls.map((c) => c[1])).toEqual(['second.stl']);
    expect(getState().exporting).toBe(false);
  });

  it('treats a superseded (cancelled) export as supersession, not a user-facing error', async () => {
    const { ctx, host, getState } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    // The delayable rejects a superseded call with DELAYABLE_CANCELLED_MESSAGE.
    mockRenderExport.mockReturnValueOnce(vi.fn().mockRejectedValue(new Error('Cancelled')));

    await new ExportService(ctx).export();

    // No spurious error surfaced and nothing downloaded — the newer export owns
    // the outcome.
    expect(getState().error).toBeUndefined();
    expect(host.download).not.toHaveBeenCalled();
  });

  it('a pass-through export supersedes an in-flight async export (no stale download, spinner cleared)', async () => {
    const { ctx, host, getState } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);

    const first = hangingRender();
    mockRenderExport.mockReturnValueOnce(first.inner);

    const p1 = svc.export(); // token 1 — STL conversion hangs, exporting=true
    // User switches to a pass-through format (OFF) and exports again.
    ctx.mutate((s) => {
      s.params.exportFormat3D = 'off';
    });
    await svc.export(); // token 2 — pass-through downloads the OFF, supersedes token 1

    // The pass-through branch never calls renderExport, but still killed the
    // in-flight STL render rather than letting the worker finish a dropped result.
    expect(first.kill).toHaveBeenCalled();

    first.resolve({
      outFile: new File(['x'], 'first.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    await p1;

    // Only the OFF pass-through downloaded; the stale STL was dropped.
    expect(host.download.mock.calls.map((c) => c[1])).toEqual(['m.off']);
    expect(getState().exporting).toBe(false);
  });

  it('the 3MF picker supersedes an in-flight async export (no stale download, spinner cleared)', async () => {
    const { ctx, host, getState } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);

    const first = hangingRender();
    mockRenderExport.mockReturnValueOnce(first.inner);

    const p1 = svc.export(); // token 1 — exporting=true
    // User switches to 3MF (no extruder colors) and exports → the picker shows.
    ctx.mutate((s) => {
      s.params.exportFormat3D = '3mf';
    });
    await svc.export(); // token 2 — picker branch

    // The picker branch returns early without renderExport, but still killed the
    // in-flight render.
    expect(first.kill).toHaveBeenCalled();

    first.resolve({
      outFile: new File(['x'], 'first.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    await p1;

    expect(getState().view.extruderPickerVisibility).toBe('exporting');
    expect(host.download).not.toHaveBeenCalled(); // stale async dropped; picker just shows
    expect(getState().exporting).toBe(false);
  });

  it('a stale async failure does not clobber the current export', async () => {
    const { ctx, host, getState } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);

    const first = hangingRender();
    const secondInner = vi.fn().mockResolvedValue({
      outFile: new File(['ok'], 'second.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(first.inner).mockReturnValueOnce(secondInner);

    const p1 = svc.export(); // token 1 — hangs
    const p2 = svc.export(); // token 2 — resolves and commits
    await p2;
    // The stale first export now fails with a non-cancellation error.
    first.reject(new Error('boom'));
    await p1;

    // The current export's success is untouched: no error surfaced, only its download.
    expect(getState().error).toBeUndefined();
    expect(getState().exporting).toBe(false);
    expect(host.download.mock.calls.map((c) => c[1])).toEqual(['second.stl']);
  });

  it('clears exporting and surfaces an error when there is no output to convert', async () => {
    const { ctx, getState } = makeCtx({ is2D: false, exportFormat3D: 'stl', output: undefined });
    await new ExportService(ctx).export();
    expect(getState().exporting).toBe(false);
    expect(getState().error).toBeTruthy();
  });
});
