import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompileCoordinator } from '../compile-coordinator.ts';
import type { ServiceContext } from '../service-context.ts';
import type { State } from '../../app-state.ts';

// render() is `factory(renderArgs)({ now })` → Promise<RenderOutput>; we drive the
// promise it returns. readFileAsDataURL is the async artifact step whose await is
// where a source change can sneak in — we control it to exercise the recheck.
const renderImpl = vi.fn();
const readFileAsDataURL = vi.fn();

vi.mock('../../../runner/actions.ts', () => ({
  render: (renderArgs: unknown) => (opts: unknown) => renderImpl(renderArgs, opts),
  checkSyntax: vi.fn(),
}));

vi.mock('../../../utils.ts', async (importActual) => ({
  ...(await importActual<typeof import('../../../utils.ts')>()),
  readFileAsDataURL: (file: unknown) => readFileAsDataURL(file),
}));

function makeContext(revision: number) {
  const state = {
    params: {
      sources: [{ kind: 'text', path: '/main.scad', content: 'cube();' }],
      activePath: '/main.scad',
      vars: {},
      features: [],
      exportFormat2D: 'svg',
      backend: 'manifold',
    },
    is2D: false,
    currentRunLogs: [],
  } as unknown as State;

  const host = {
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
    playCompletionChime: vi.fn(),
    baseUrl: () => 'http://localhost/',
  };

  let rev = revision;
  const ctx: ServiceContext = {
    getState: () => state,
    mutate: (f) => {
      f(state);
      return true;
    },
    getSourceRevision: () => rev,
    getActiveSource: () => 'cube();',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    host: host as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs: {} as any,
  };

  return { ctx, state, host, setRevision: (n: number) => (rev = n) };
}

function renderOutput(revision: number) {
  return {
    outFile: new File(['solid'], 'out.off', { type: 'text/plain' }),
    logText: '',
    markers: [],
    elapsedMillis: 1,
    revision,
  };
}

describe('CompileCoordinator render staleness', () => {
  beforeEach(() => {
    renderImpl.mockReset();
    readFileAsDataURL.mockReset();
  });

  it('commits the result and revokes nothing on the happy path', async () => {
    const { ctx, state, host } = makeContext(1);
    renderImpl.mockResolvedValue(renderOutput(1));
    readFileAsDataURL.mockResolvedValue('data:text/plain;base64,c29saWQ=');

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output?.outFileURL).toBe('blob:fake-url');
    expect(host.revokeObjectURL).not.toHaveBeenCalled();
    expect(host.playCompletionChime).toHaveBeenCalledTimes(1);
    expect(state.rendering).toBe(false);
  });

  it('drops a result gone stale during readFileAsDataURL and revokes the blob URL', async () => {
    const { ctx, state, host, setRevision } = makeContext(1);
    renderImpl.mockResolvedValue(renderOutput(1));
    // The source changes while the data URL is being read: bump the revision
    // mid-await so the recheck after readFileAsDataURL sees a newer revision.
    readFileAsDataURL.mockImplementation(async () => {
      setRevision(2);
      return 'data:text/plain;base64,c29saWQ=';
    });

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output).toBeUndefined();
    expect(host.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    expect(host.playCompletionChime).not.toHaveBeenCalled();
    expect(state.rendering).toBe(false);
  });

  it('revokes the blob URL when readFileAsDataURL throws', async () => {
    const { ctx, state, host } = makeContext(1);
    renderImpl.mockResolvedValue(renderOutput(1));
    readFileAsDataURL.mockRejectedValue(new Error('read failed'));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output).toBeUndefined();
    expect(host.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});
