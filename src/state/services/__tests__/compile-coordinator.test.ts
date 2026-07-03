import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompileCoordinator } from '../compile-coordinator.ts';
import { UserFacingOperationError } from '../../../user-facing-errors.ts';
import type { ServiceContext } from '../service-context.ts';
import { ArtifactStore } from '../../artifact-store.ts';
import type { OperationResult } from '../../../runner/compile-contract.ts';
import type { State } from '../../app-state.ts';

// render() is `factory(renderArgs)({ now })` → Promise<RenderOutput>; we drive the
// promise it returns and the source revision to exercise the staleness drop.
const renderImpl = vi.fn();
const checkSyntaxImpl = vi.fn();

vi.mock('../../../runner/actions.ts', () => ({
  createRenderDelayable: () => (renderArgs: unknown) => (opts: unknown) =>
    renderImpl(renderArgs, opts),
  createSyntaxDelayable: () => (args: unknown) => (opts: unknown) => checkSyntaxImpl(args, opts),
}));

function makeContext(revision: number, onResult?: (r: OperationResult) => void) {
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
  const results: OperationResult[] = [];
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
    backend: { spawn: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
    sessionId: 'test-session',
    artifacts: new ArtifactStore(),
    onOperationResult: onResult ?? ((r) => results.push(r)),
  };

  return { ctx, state, host, results, setRevision: (n: number) => (rev = n) };
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeBinaryContext(readFileSync: () => any) {
  const state = {
    params: {
      sources: [
        { kind: 'text', path: '/home/main.scad', content: 'import("part.stl");' },
        { kind: 'local', path: '/home/part.stl' }, // project-local binary asset
        { kind: 'local', path: '/libraries/foo/bar.scad' }, // mount — stays content-less
      ],
      activePath: '/home/main.scad',
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
  const ctx: ServiceContext = {
    getState: () => state,
    mutate: (f) => {
      f(state);
      return true;
    },
    getSourceRevision: () => 1,
    getActiveSource: () => 'import("part.stl");',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    host: host as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs: { readFileSync } as any,
    backend: { spawn: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
    sessionId: 'test-session',
    artifacts: new ArtifactStore(),
  };
  return { ctx, state };
}

describe('CompileCoordinator binary-asset materialization (#121)', () => {
  beforeEach(() => renderImpl.mockReset());

  it('materializes a project-local asset’s bytes into the request; mounts stay content-less', async () => {
    const stl = new Uint8Array([0, 65, 200, 255]);
    const { ctx } = makeBinaryContext(() => stl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let captured: any;
    renderImpl.mockImplementation((renderArgs: unknown) => {
      captured = renderArgs;
      return Promise.resolve(renderOutput(1));
    });

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    const byPath = (p: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      captured.sources.find((s: any) => s.path === p);
    expect(Array.from(byPath('/home/part.stl').content as Uint8Array)).toEqual(Array.from(stl));
    expect(byPath('/libraries/foo/bar.scad').content).toBeUndefined();
    expect(byPath('/home/main.scad').content).toBe('import("part.stl");');
  });

  it('surfaces a clear error when a referenced local asset is missing from the FS', async () => {
    const { ctx, state } = makeBinaryContext(() => {
      throw new Error('ENOENT');
    });
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(String(state.error)).toMatch(/Asset not available/);
    expect(renderImpl).not.toHaveBeenCalled();
  });

  it('excludes binary local assets from the syntax-check inputs, keeping .scad sources (#153)', async () => {
    const { ctx } = makeBinaryContext(() => new Uint8Array());
    checkSyntaxImpl.mockReset();
    checkSyntaxImpl.mockResolvedValue({ markers: [], parameterSet: undefined, revision: 1 });

    await new CompileCoordinator(ctx).checkSyntax();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = checkSyntaxImpl.mock.calls[0][0] as any;
    const paths = args.sources.map((s: { path: string }) => s.path);
    expect(paths).toContain('/home/main.scad'); // active .scad kept
    expect(paths).toContain('/libraries/foo/bar.scad'); // a .scad local is text → kept
    expect(paths).not.toContain('/home/part.stl'); // binary local dropped (no worker noise)
  });
});

describe('CompileCoordinator render staleness', () => {
  beforeEach(() => {
    renderImpl.mockReset();
  });

  it('commits the result and revokes nothing on the happy path', async () => {
    const { ctx, state, host, results } = makeContext(1);
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output?.outFileURL).toBe('blob:fake-url');
    expect(host.revokeObjectURL).not.toHaveBeenCalled();
    expect(host.playCompletionChime).toHaveBeenCalledTimes(1);
    expect(state.rendering).toBe(false);
    // The committed output carries immutable artifact identity (ADR 0008).
    expect(state.output?.artifactId).toMatch(/[0-9a-f-]{36}/);
    expect(state.output?.operationId).toMatch(/[0-9a-f-]{36}/);
    expect(state.output?.sourceRevision).toBe(1);
    // The same artifactId resolves in the store to the exact committed File —
    // the slice's central guarantee (shared id, byte-identical write-through).
    expect(ctx.artifacts.get(state.output!.artifactId)?.bytes).toBe(state.output!.outFile);
    // Exactly one terminal OperationResult: a success keyed to the operation, its
    // artifact ref matching the committed output (ADR 0008 slice 4).
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.status).toBe('success');
    expect(result.kind).toBe('render');
    expect(result.operationId).toBe(state.output?.operationId);
    if (result.status === 'success') {
      expect(result.artifact?.artifactId).toBe(state.output?.artifactId);
      expect(result.artifact?.operationId).toBe(state.output?.operationId);
    }
  });

  it('drops a result whose revision is stale and never creates a blob URL', async () => {
    // The render was requested at revision 1, but the sources moved to 2 by the
    // time the result arrives (e.g. the user edited while rendering).
    const { ctx, state, host, results } = makeContext(2);
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(state.output).toBeUndefined();
    // The stale result is dropped before any object URL is created, so there is
    // nothing to leak or revoke.
    expect(host.createObjectURL).not.toHaveBeenCalled();
    expect(host.revokeObjectURL).not.toHaveBeenCalled();
    expect(host.playCompletionChime).not.toHaveBeenCalled();
    expect(state.rendering).toBe(false);
    // The stale-drop still terminates the operation — exactly one cancelled result.
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
    expect(results[0].kind).toBe('render');
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
      artifactId: 'art',
      operationId: 'op',
      sourceRevision: 0,
    };
    renderImpl.mockResolvedValue(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(host.revokeObjectURL).toHaveBeenCalledWith('blob:old-url');
    expect(state.output?.outFileURL).toBe('blob:fake-url');
  });
});

describe('CompileCoordinator terminal OperationResult (ADR 0008 slice 4)', () => {
  beforeEach(() => {
    renderImpl.mockReset();
    checkSyntaxImpl.mockReset();
  });

  it('emits one error result when the render rejects', async () => {
    const { ctx, results } = makeContext(1);
    renderImpl.mockRejectedValue(new Error('boom'));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true });

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.status).toBe('error');
    expect(result.kind).toBe('render');
    if (result.status === 'error') {
      expect(result.code).toBe('operation_failed');
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('a superseded render terminates as cancelled while the newer one succeeds', async () => {
    const { ctx, results } = makeContext(1);
    let resolveFirst: (v: unknown) => void = () => {};
    renderImpl.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    renderImpl.mockResolvedValueOnce(renderOutput(1));
    const coord = new CompileCoordinator(ctx);

    const first = coord.render({ isPreview: false, now: true });
    const second = coord.render({ isPreview: false, now: true }); // supersedes the first
    resolveFirst(renderOutput(1));
    await Promise.all([first, second]);

    expect(results).toHaveLength(2);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['cancelled', 'success']);
    // Distinct operations: the cancelled and the success never share an id.
    expect(results[0].operationId).not.toBe(results[1].operationId);
  });

  it('the 2D/3D dimension retry emits ONE terminal — the retry owns the request (#219)', async () => {
    const { ctx, results } = makeContext(1);
    // The first render logs a dimension mismatch via the streams callback; the
    // wrong-dimension attempt must emit and commit NOTHING (a correlated host
    // would otherwise see a spurious first terminal for its requestId).
    renderImpl.mockImplementationOnce((renderArgs: { streamsCallback: (p: unknown) => void }) => {
      renderArgs.streamsCallback({ stderr: 'Current top level object is not a 3D object.' });
      return Promise.resolve(renderOutput(1));
    });
    renderImpl.mockResolvedValueOnce(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true, requestId: 'rq-dim' });
    // The retry is dispatched without await (fire-and-return), so let its own
    // async commit settle before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].requestId).toBe('rq-dim');
  });

  it('a mismatch FAILURE also retries without a spurious terminal, reading the job-local log (#219)', async () => {
    const { ctx, results } = makeContext(1);
    renderImpl.mockRejectedValueOnce(
      new UserFacingOperationError({
        message: 'render failed',
        logText: 'Current top level object is not a 3D object.',
      }),
    );
    renderImpl.mockResolvedValueOnce(renderOutput(1));

    await new CompileCoordinator(ctx).render({ isPreview: false, now: true, requestId: 'rq-f' });
    await new Promise((r) => setTimeout(r, 0));

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].requestId).toBe('rq-f');
  });

  it('a superseded render terminates as cancelled carrying its requestId (#219/#223)', async () => {
    const { ctx, results } = makeContext(1);
    let resolveFirst: (v: unknown) => void = () => {};
    renderImpl.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    renderImpl.mockResolvedValueOnce(renderOutput(1));
    const coord = new CompileCoordinator(ctx);

    const first = coord.render({ isPreview: false, now: true, requestId: 'rq-old' });
    const second = coord.render({ isPreview: false, now: true, requestId: 'rq-new' });
    resolveFirst(renderOutput(1));
    await Promise.all([first, second]);

    const cancelled = results.find((r) => r.status === 'cancelled');
    const success = results.find((r) => r.status === 'success');
    expect(cancelled?.requestId).toBe('rq-old');
    expect(success?.requestId).toBe('rq-new');
  });

  it('targeted cancel kills only the render carrying that requestId (#226)', async () => {
    const { ctx, results } = makeContext(1);
    let rejectFn: (e: unknown) => void = () => {};
    const hang = new Promise((_res, rej) => (rejectFn = rej)) as Promise<unknown> & {
      kill: () => void;
    };
    hang.kill = vi.fn(() => rejectFn(new Error('Cancelled')));
    renderImpl.mockReturnValueOnce(hang);
    const coord = new CompileCoordinator(ctx);

    const p = coord.render({ isPreview: false, now: true, requestId: 'rq-target' });
    await new Promise((r) => setTimeout(r, 0)); // let it reach the spawn
    coord.cancel('rq-other'); // wrong id → must NOT kill
    expect(hang.kill).not.toHaveBeenCalled();
    coord.cancel('rq-target'); // right id → kills
    expect(hang.kill).toHaveBeenCalledTimes(1);
    await p;

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
    expect(results[0].requestId).toBe('rq-target');
  });

  it('a targeted cancel during source materialization cancels pre-spawn (#226)', async () => {
    const { ctx, results } = makeContext(1);
    renderImpl.mockResolvedValueOnce(renderOutput(1)); // must never be consumed
    const coord = new CompileCoordinator(ctx);

    const p = coord.render({ isPreview: false, now: true, requestId: 'rq-early' });
    coord.cancel('rq-early'); // lands before the job exists
    await p;

    expect(renderImpl).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
    expect(results[0].requestId).toBe('rq-early');
  });

  it('targeted cancel spares a render that carries NO requestId (auto previews survive, #226)', async () => {
    const { ctx, results } = makeContext(1);
    let resolveFn: (v: unknown) => void = () => {};
    const hang = new Promise((res) => (resolveFn = res)) as Promise<unknown> & {
      kill: () => void;
    };
    hang.kill = vi.fn();
    renderImpl.mockReturnValueOnce(hang);
    const coord = new CompileCoordinator(ctx);

    const p = coord.render({ isPreview: true, now: true }); // an auto preview
    coord.cancel('rq-whatever'); // targeted → must not touch it
    expect(hang.kill).not.toHaveBeenCalled();
    resolveFn(renderOutput(1));
    await p;
    expect(results[0].status).toBe('success');
  });

  it('a killed render does not poison its id — a later render reusing it runs (#226 review)', async () => {
    const { ctx, results } = makeContext(1);
    let rejectFn: (e: unknown) => void = () => {};
    const hang = new Promise((_res, rej) => (rejectFn = rej)) as Promise<unknown> & {
      kill: () => void;
    };
    hang.kill = vi.fn(() => rejectFn(new Error('Cancelled')));
    renderImpl.mockReturnValueOnce(hang);
    renderImpl.mockResolvedValueOnce(renderOutput(1));
    const coord = new CompileCoordinator(ctx);

    const p1 = coord.render({ isPreview: false, now: true, requestId: 'rq-reuse' });
    await new Promise((r) => setTimeout(r, 0));
    coord.cancel('rq-reuse'); // kills post-spawn; the mark must not linger
    await p1;

    const p2 = coord.render({ isPreview: false, now: true, requestId: 'rq-reuse' });
    await p2;
    expect(renderImpl).toHaveBeenCalledTimes(2); // the reuse actually spawned
    expect(results.map((r) => r.status)).toEqual(['cancelled', 'success']);
  });

  it('a targeted cancel AFTER an op finished does not cancel a future op with the same id (#226 review)', async () => {
    const { ctx, results } = makeContext(1);
    renderImpl.mockResolvedValueOnce(renderOutput(1));
    renderImpl.mockResolvedValueOnce(renderOutput(1));
    const coord = new CompileCoordinator(ctx);

    await coord.render({ isPreview: false, now: true, requestId: 'rq-late' });
    coord.cancel('rq-late'); // late no-op — nothing in flight
    await coord.render({ isPreview: false, now: true, requestId: 'rq-late' });

    expect(results.map((r) => r.status)).toEqual(['success', 'success']);
  });

  it('checkSyntax emits one success result with no artifact', async () => {
    const { ctx, results } = makeContext(1);
    checkSyntaxImpl.mockResolvedValue({ revision: 1, markers: [], logText: '' });

    await new CompileCoordinator(ctx).checkSyntax();

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.status).toBe('success');
    expect(result.kind).toBe('syntaxCheck');
    if (result.status === 'success') {
      expect(result.artifact).toBeUndefined();
    }
  });

  it('checkSyntax emits one error result when the check rejects', async () => {
    const { ctx, results } = makeContext(1);
    checkSyntaxImpl.mockRejectedValue(new Error('parse failure'));

    await new CompileCoordinator(ctx).checkSyntax();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].kind).toBe('syntaxCheck');
  });

  it('a throwing sink cannot corrupt the committed render or surface an error', async () => {
    // The result sink throws; emitResult must swallow it so the success commit is
    // not re-entered by the catch (no clobbered output, no spurious error).
    const { ctx, state } = makeContext(1, () => {
      throw new Error('sink boom');
    });
    renderImpl.mockResolvedValue(renderOutput(1));

    await expect(
      new CompileCoordinator(ctx).render({ isPreview: false, now: true }),
    ).resolves.toBeUndefined();

    expect(state.output?.outFileURL).toBe('blob:fake-url');
    expect(state.error).toBeUndefined();
    expect(state.rendering).toBe(false);
  });
});

describe('CompileCoordinator cancel() (#123)', () => {
  beforeEach(() => {
    renderImpl.mockReset();
    checkSyntaxImpl.mockReset();
  });

  // A never-resolving job whose kill() rejects with the expected-cancellation
  // message — exactly what the real delayable does when superseded/killed.
  function hangingJob() {
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise((_resolve, rej) => (reject = rej));
    return Object.assign(promise, { kill: () => reject(new Error('Cancelled')) });
  }

  it('cancel() kills an in-flight render: one cancelled result, spinner cleared', async () => {
    const { ctx, state, results } = makeContext(1);
    renderImpl.mockReturnValueOnce(hangingJob());
    const coord = new CompileCoordinator(ctx);

    const p = coord.render({ isPreview: true, now: true });
    await new Promise((r) => setTimeout(r, 0)); // let render() submit + retain the handle
    coord.cancel();
    await p;

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
    expect(results[0].kind).toBe('preview');
    expect(state.previewing).toBe(false); // spinner cleared, no error surfaced
    expect(state.error).toBeUndefined();
  });

  it('cancel() kills an in-flight syntax check: one cancelled result', async () => {
    const { ctx, state, results } = makeContext(1);
    checkSyntaxImpl.mockReturnValueOnce(hangingJob());
    const coord = new CompileCoordinator(ctx);

    const p = coord.checkSyntax();
    await new Promise((r) => setTimeout(r, 0));
    coord.cancel();
    await p;

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
    expect(results[0].kind).toBe('syntaxCheck');
    expect(state.checkingSyntax).toBe(false);
  });

  it('cancel() is a no-op when nothing is in flight', () => {
    const { ctx } = makeContext(1);
    expect(() => new CompileCoordinator(ctx).cancel()).not.toThrow();
  });
});
