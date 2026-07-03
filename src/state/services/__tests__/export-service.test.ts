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
import { ArtifactStore } from '../../artifact-store.ts';
import type { OperationResult } from '../../../runner/compile-contract.ts';

/**
 * A renderExport mock whose inner thunk returns an AbortablePromise-shaped value
 * (a Promise with a `kill` spy), mirroring the real delayable so the service can
 * own and kill the in-flight render. The promise stays pending until `resolve`
 * (or `reject`) is called by the test.
 */
/** Flush the conversion branch's `await outFile.text()` so the export reaches
 *  its renderExport spawn before the test's next action (the input is shipped
 *  as content now — the spawn is no longer synchronous). */
const tick = () => new Promise((r) => setTimeout(r, 0));

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
  const results: OperationResult[] = [];
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
    artifacts: new ArtifactStore(),
    onOperationResult: (r) => results.push(r),
  };
  return { ctx, host, results, getState: () => state };
}

describe('ExportService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloads the rendered file directly on an svg pass-through (2D)', async () => {
    const { ctx, host, results } = makeCtx({
      is2D: true,
      exportFormat2D: 'svg',
      output: fileOutput('m.svg'),
    });
    await new ExportService(ctx).export();
    expect(host.download).toHaveBeenCalledWith('blob:out', 'm.svg');
    expect(mockRenderExport).not.toHaveBeenCalled();
    // One terminal success that INHERITS the render's artifact identity (same
    // bytes), keyed to this export operation (ADR 0008 slice 4).
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].kind).toBe('export');
    if (results[0].status === 'success') {
      expect(results[0].artifact?.artifactId).toBe('art');
      expect(results[0].artifact?.operationId).toBe('op');
    }
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
    const { ctx, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: '3mf',
      output: fileOutput('m.off'),
    });
    await new ExportService(ctx).export();
    expect(getState().view.extruderPickerVisibility).toBe('exporting');
    expect(mockRenderExport).not.toHaveBeenCalled();
    // The picker defers the real export to a second call; this op terminates as
    // cancelled so every minted operationId resolves exactly once (ADR 0008).
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
    expect(results[0].kind).toBe('export');
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
    const { ctx, host, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    await new ExportService(ctx).export();
    expect(mockRenderExport).toHaveBeenCalledTimes(1);
    // Export runs on its own scheduling priority (preempts background compiles).
    expect(mockRenderExport.mock.calls[0][0].priority).toBe('export');
    // The conversion input ships as CONTENT, never a blob URL: a webview blob
    // URL's origin can never satisfy the worker's external-source policy
    // (v0.3.1 regression guard).
    const inputSource = mockRenderExport.mock.calls[0][0].sources[1];
    expect(inputSource.path).toBe('m.off');
    expect(inputSource.content).toBe('x');
    expect(inputSource.url).toBeUndefined();
    expect(host.download).toHaveBeenCalledWith('blob:new', 'model.stl');
    // The committed export's artifactId resolves in the store to the exact File
    // (shared id, byte-identical write-through — ADR 0008).
    const exported = getState().export!;
    expect(ctx.artifacts.get(exported.artifactId)?.bytes).toBe(exported.outFile);
    // One terminal success whose fresh artifact ref matches the committed export.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    if (results[0].status === 'success') {
      expect(results[0].artifact?.artifactId).toBe(exported.artifactId);
    }
  });

  it('drops a superseded export result instead of clobbering the newer one', async () => {
    const { ctx, host, getState, results } = makeCtx({
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
    await tick(); // let it reach the (hanging) renderExport spawn
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
    // Two terminal results: the superseded op is cancelled, the newer succeeds.
    expect(results.map((r) => r.status).sort()).toEqual(['cancelled', 'success']);
  });

  it('an export superseded during the input read cancels without spawning its render', async () => {
    const { ctx, host, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);
    const secondInner = vi.fn().mockResolvedValue({
      outFile: new File(['second'], 'second.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(secondInner);

    // NO tick between them: export 1 is still awaiting outFile.text() when
    // export 2 supersedes it, so export 1 must cancel pre-spawn — consuming NO
    // mocked render (the single mock belongs to export 2).
    const p1 = svc.export();
    const p2 = svc.export();
    await Promise.all([p1, p2]);

    expect(mockRenderExport).toHaveBeenCalledTimes(1);
    expect(host.download.mock.calls.map((c) => c[1])).toEqual(['second.stl']);
    expect(results.map((r) => r.status).sort()).toEqual(['cancelled', 'success']);
    expect(getState().exporting).toBe(false);
  });

  it('cancel() during the input read cancels pre-spawn and clears the spinner', async () => {
    const { ctx, host, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);

    const p = svc.export(); // suspended at the outFile.text() read
    svc.cancel(); // no job exists yet — the mark must still take effect
    await p;

    expect(mockRenderExport).not.toHaveBeenCalled();
    expect(host.download).not.toHaveBeenCalled();
    expect(getState().exporting).toBe(false); // still-current → clears its own spinner
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
  });

  it("a superseded export's cancelled terminal echoes the SUPERSEDED request's id (#223)", async () => {
    const { ctx, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);
    const secondInner = vi.fn().mockResolvedValue({
      outFile: new File(['second'], 'second.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(secondInner);

    const p1 = svc.export('stl', 'req-A'); // superseded during its input read
    const p2 = svc.export('stl', 'req-B');
    await Promise.all([p1, p2]);

    const cancelled = results.find((r) => r.status === 'cancelled');
    const success = results.find((r) => r.status === 'success');
    expect(cancelled?.requestId).toBe('req-A'); // the exact #223 scenario
    expect(success?.requestId).toBe('req-B');
  });

  it('targeted cancel only affects the export carrying that requestId (#226)', async () => {
    const { ctx, host, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);
    const inner = vi.fn().mockResolvedValue({
      outFile: new File(['ok'], 'a.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(inner);

    const p = svc.export('stl', 'rq-exp'); // suspended at the input read
    svc.cancel('rq-other'); // wrong id → export must proceed
    await p;
    expect(results.at(-1)?.status).toBe('success');
    expect(host.download).toHaveBeenCalledTimes(1);

    // Matching id cancels pre-spawn, exactly like an untargeted cancel.
    const p2 = svc.export('stl', 'rq-exp2');
    svc.cancel('rq-exp2');
    await p2;
    expect(results.at(-1)?.status).toBe('cancelled');
    expect(getState().exporting).toBe(false);
  });

  it('a targeted cancel for a SUPERSEDED export id no-ops (the newer export survives, #226)', async () => {
    const { ctx, host, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const svc = new ExportService(ctx);
    const secondInner = vi.fn().mockResolvedValue({
      outFile: new File(['second'], 'second.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(secondInner);

    const p1 = svc.export('stl', 'rq-old'); // superseded during its input read
    const p2 = svc.export('stl', 'rq-new');
    svc.cancel('rq-old'); // targets the superseded one → must not touch rq-new
    await Promise.all([p1, p2]);

    expect(host.download.mock.calls.map((c) => c[1])).toEqual(['second.stl']);
    expect(results.find((r) => r.requestId === 'rq-new')?.status).toBe('success');
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
    await tick(); // let it reach the (hanging) renderExport spawn
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
    await tick(); // let it reach the (hanging) renderExport spawn
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
    await tick(); // let it reach the (hanging) renderExport spawn
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
    const { ctx, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: undefined,
    });
    await new ExportService(ctx).export();
    expect(getState().exporting).toBe(false);
    expect(getState().error).toBeTruthy();
    // The failed export terminates as exactly one error result (ADR 0008 slice 4).
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].kind).toBe('export');
  });

  it('cancel() of an in-flight conversion clears the spinner and emits one cancelled result (#123)', async () => {
    const { ctx, getState, results } = makeCtx({
      is2D: false,
      exportFormat3D: 'stl',
      output: fileOutput('m.off'),
    });
    const conversion = hangingRender();
    mockRenderExport.mockReturnValueOnce(conversion.inner);
    const svc = new ExportService(ctx);

    const p = svc.export(); // worker-conversion branch; sets _activeRender, awaits
    await tick();
    expect(getState().exporting).toBe(true);

    svc.cancel();
    expect(conversion.kill).toHaveBeenCalled();
    conversion.reject(new Error('Cancelled')); // the kill rejects the job
    await p;

    // The still-current export was cancelled (not superseded), so it must clear
    // its own spinner — the BLOCKER this test guards.
    expect(getState().exporting).toBe(false);
    expect(getState().error).toBeUndefined();
    expect(results.filter((r) => r.status === 'cancelled')).toHaveLength(1);
  });
});
