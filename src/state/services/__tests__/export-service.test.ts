import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy compile/IO deps the format-conversion + 3MF paths touch.
vi.mock('../../../runner/actions.ts', () => ({
  renderExport: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({
      outFile: new File(['converted'], 'model.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    }),
  ),
}));
vi.mock('../../../io/import_off.ts', () => ({ parseOff: vi.fn(() => ({})) }));
vi.mock('../../../io/export_3mf.ts', () => ({
  export3MF: vi.fn(() => new Uint8Array([1, 2, 3])),
}));
vi.mock('chroma-js', () => ({ default: vi.fn((c: string) => c) }));

import { renderExport as _mockRenderExport, type RenderOutput } from '../../../runner/actions.ts';
import type { State } from '../../app-state.ts';
import { bubbleUpDeepMutations } from '../../deep-mutate.ts';
import type { HostAdapter } from '../../web-host-adapter.ts';
import { ExportService } from '../export-service.ts';
import type { ServiceContext } from '../service-context.ts';

const mockRenderExport = _mockRenderExport as ReturnType<typeof vi.fn>;

function fileOutput(name: string, url = 'blob:out'): State['output'] {
  const f = new File(['x'], name);
  return {
    isPreview: false,
    outFile: f,
    outFileURL: url,
    displayFile: f,
    displayFileURL: url,
    elapsedMillis: 0,
    formattedElapsedMillis: '0ms',
    formattedOutFileSize: '1 B',
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

  it('downloads the display file on a glb pass-through', async () => {
    const { ctx, host } = makeCtx({
      is2D: false,
      exportFormat3D: 'glb',
      output: fileOutput('m.glb', 'blob:glb'),
    });
    await new ExportService(ctx).export();
    expect(host.download).toHaveBeenCalledWith('blob:glb', 'm.glb');
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
    let resolveFirst!: (v: RenderOutput) => void;
    const firstInner = vi.fn(() => new Promise<RenderOutput>((r) => (resolveFirst = r)));
    const secondInner = vi.fn().mockResolvedValue({
      outFile: new File(['second'], 'second.stl'),
      logText: '',
      markers: [],
      elapsedMillis: 1,
    });
    mockRenderExport.mockReturnValueOnce(firstInner).mockReturnValueOnce(secondInner);

    const p1 = svc.export(); // token 1 — awaits the hanging conversion
    const p2 = svc.export(); // token 2 — resolves and commits
    await p2;
    // Now let the first (superseded) export finish; its token is stale.
    resolveFirst({
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

  it('clears exporting and surfaces an error when there is no output to convert', async () => {
    const { ctx, getState } = makeCtx({ is2D: false, exportFormat3D: 'stl', output: undefined });
    await new ExportService(ctx).export();
    expect(getState().exporting).toBe(false);
    expect(getState().error).toBeTruthy();
  });
});
