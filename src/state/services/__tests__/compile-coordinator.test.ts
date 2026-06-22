import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompileCoordinator } from '../compile-coordinator.ts';
import type { ServiceContext } from '../service-context.ts';
import type { State } from '../../app-state.ts';

// render() is `factory(renderArgs)({ now })` → Promise<RenderOutput>; we drive the
// promise it returns and the source revision to exercise the staleness drop.
const renderImpl = vi.fn();

vi.mock('../../../runner/actions.ts', () => ({
  render: (renderArgs: unknown) => (opts: unknown) => renderImpl(renderArgs, opts),
  checkSyntax: vi.fn(),
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
  });

  it('commits the result and revokes nothing on the happy path', async () => {
    const { ctx, state, host } = makeContext(1);
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output?.outFileURL).toBe('blob:fake-url');
    expect(host.revokeObjectURL).not.toHaveBeenCalled();
    expect(host.playCompletionChime).toHaveBeenCalledTimes(1);
    expect(state.rendering).toBe(false);
  });

  it('drops a result whose revision is stale and never creates a blob URL', async () => {
    // The render was requested at revision 1, but the sources moved to 2 by the
    // time the result arrives (e.g. the user edited while rendering).
    const { ctx, state, host } = makeContext(2);
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output).toBeUndefined();
    // The stale result is dropped before any object URL is created, so there is
    // nothing to leak or revoke.
    expect(host.createObjectURL).not.toHaveBeenCalled();
    expect(host.revokeObjectURL).not.toHaveBeenCalled();
    expect(host.playCompletionChime).not.toHaveBeenCalled();
    expect(state.rendering).toBe(false);
  });

  it('revokes the previous output blob URL when committing a new result', async () => {
    const { ctx, state, host } = makeContext(1);
    // Seed a prior committed output with a blob URL.
    (state as unknown as { output: State['output'] }).output = {
      isPreview: false,
      outFile: new File(['old'], 'old.off'),
      outFileURL: 'blob:old-url',
      elapsedMillis: 0,
      formattedElapsedMillis: '0ms',
      formattedOutFileSize: '1 B',
    };
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(host.revokeObjectURL).toHaveBeenCalledWith('blob:old-url');
    expect(state.output?.outFileURL).toBe('blob:fake-url');
  });
});
