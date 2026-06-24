import { describe, expect, it } from 'vitest';

import { SessionController, type SessionHost } from '../controller.ts';
import { InProcessTestTransport } from '../../viewer-host/transports/in-process.ts';
import { SESSION_PROTOCOL_VERSION } from '../../protocol/session-transport.ts';
import type { OperationResult } from '../../protocol/session-contract.ts';

const V = SESSION_PROTOCOL_VERSION;
const flush = () => new Promise((r) => setTimeout(r));

class FakeSession implements SessionHost {
  calls: string[] = [];
  disposed = false;
  throwOnUpdate = false;
  throwOnRead = false;
  useDeferredReads = false;
  readonly artifacts = new Map<string, string>(); // artifactId → OFF text
  private op: ((r: OperationResult) => void) | null = null;
  private readDeferreds = new Map<string, (text: string | undefined) => void>();

  setProject(files: { path: string }[], entryPoint?: string) {
    this.calls.push(`setProject:${files.length}:${entryPoint ?? ''}`);
  }
  updateFile(path: string) {
    if (this.throwOnUpdate) throw new Error('ProjectPathError: unsafe path');
    this.calls.push(`updateFile:${path}`);
  }
  removeFile(path: string) {
    this.calls.push(`removeFile:${path}`);
  }
  setEntryPoint(path: string) {
    this.calls.push(`setEntryPoint:${path}`);
  }
  cancel() {
    this.calls.push('cancel');
  }
  dispose() {
    this.disposed = true;
    this.calls.push('dispose');
  }
  onOperation(handler: (r: OperationResult) => void) {
    this.op = handler;
    return () => {
      this.op = null;
    };
  }
  async readArtifactText(id: string) {
    if (this.throwOnRead) throw new Error('blob read failed');
    if (this.useDeferredReads)
      return new Promise<string | undefined>((res) => this.readDeferreds.set(id, res));
    return this.artifacts.get(id);
  }
  /** Resolve a pending deferred read (for out-of-order completion tests). */
  resolveRead(id: string, text: string | undefined) {
    const res = this.readDeferreds.get(id);
    this.readDeferreds.delete(id);
    res?.(text);
  }
  emit(r: OperationResult) {
    this.op?.(r);
  }
  get subscribed() {
    return this.op !== null;
  }
}

function result(over: Partial<OperationResult> & { artifactId?: string }): OperationResult {
  const { artifactId, ...rest } = over;
  return {
    protocolVersion: 1,
    sessionId: 's',
    operationId: 'op',
    sourceRevision: 1,
    kind: 'preview',
    elapsedMillis: 1,
    diagnostics: [],
    logText: '',
    status: 'success',
    ...(artifactId
      ? {
          artifact: {
            artifactId,
            operationId: 'op',
            sourceRevision: (rest.sourceRevision as number) ?? 1,
            format: 'off',
            mediaType: 'text/plain',
            size: 1,
            name: 'out.off',
          },
        }
      : {}),
    ...rest,
  } as OperationResult;
}

function setup() {
  const session = new FakeSession();
  const viewer = { offText: null as string | null };
  const transport = new InProcessTestTransport();
  const controller = new SessionController(session, viewer, transport);
  return { session, viewer, transport, controller };
}

const sentTypes = (t: InProcessTestTransport) => t.sent.map((m) => (m as { type: string }).type);

describe('SessionController', () => {
  it('announces ready (after subscribing) with the supported commands', () => {
    const { transport, session } = setup();
    expect(session.subscribed).toBe(true);
    expect(transport.sent[0]).toMatchObject({
      protocolVersion: V,
      type: 'ready',
      capabilities: [
        'setProject',
        'updateFile',
        'removeFile',
        'setEntryPoint',
        'cancel',
        'dispose',
      ],
    });
  });

  it('dispatches each inbound command to the session', () => {
    const { session, transport } = setup();
    transport.receive({
      protocolVersion: V,
      type: 'setProject',
      files: [{ path: '/a', content: 'x' }],
    });
    transport.receive({ protocolVersion: V, type: 'updateFile', path: '/a', content: 'y' });
    transport.receive({ protocolVersion: V, type: 'removeFile', path: '/a' });
    transport.receive({ protocolVersion: V, type: 'setEntryPoint', path: '/a' });
    transport.receive({ protocolVersion: V, type: 'cancel' });
    expect(session.calls).toEqual([
      'setProject:1:',
      'updateFile:/a',
      'removeFile:/a',
      'setEntryPoint:/a',
      'cancel',
    ]);
  });

  it('rejects an invalid inbound payload with a protocol error and no dispatch', () => {
    const { session, transport } = setup();
    transport.receive({ protocolVersion: V, type: 'updateFile', path: 5 });
    expect(session.calls).toEqual([]);
    expect(transport.sent.at(-1)).toMatchObject({ type: 'error', code: 'invalid-payload' });
  });

  it('catches a thrown ProjectPathError and surfaces it as a session error', () => {
    const { session, transport } = setup();
    session.throwOnUpdate = true;
    transport.receive({ protocolVersion: V, type: 'updateFile', path: '/a', content: 'x' });
    expect(transport.sent.at(-1)).toMatchObject({ type: 'error', code: 'invalid-payload' });
  });

  it('forwards operation results as a push stream', () => {
    const { session, transport } = setup();
    session.emit(result({ kind: 'syntaxCheck', artifactId: undefined }));
    expect(sentTypes(transport)).toEqual(['ready', 'operation-result']);
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'operation-result',
      result: { kind: 'syntaxCheck', status: 'success' },
    });
  });

  it('render bridge: pushes a successful OFF result into the embedded viewer', async () => {
    const { session, viewer } = setup();
    session.artifacts.set('a1', 'OFF 8 6 12\n...');
    session.emit(result({ kind: 'render', sourceRevision: 5, artifactId: 'a1' }));
    await flush();
    expect(viewer.offText).toBe('OFF 8 6 12\n...');
  });

  it('render bridge: ignores non-OFF and non-success results', async () => {
    const { session, viewer } = setup();
    session.artifacts.set('a1', 'OFF');
    // an error result + a 2D (no artifact) result
    session.emit(
      result({ status: 'error', code: 'render-error', reason: 'bad' } as Partial<OperationResult>),
    );
    session.emit(result({ kind: 'preview', artifactId: undefined }));
    await flush();
    expect(viewer.offText).toBeNull();
  });

  it('render bridge: a stale (older-revision) result does not overwrite a newer one', async () => {
    const { session, viewer } = setup();
    session.artifacts.set('new', 'NEW');
    session.artifacts.set('old', 'OLD');
    session.emit(result({ sourceRevision: 9, artifactId: 'new' }));
    await flush();
    session.emit(result({ sourceRevision: 4, artifactId: 'old' }));
    await flush();
    expect(viewer.offText).toBe('NEW');
  });

  it('render bridge: a full render supersedes a same-revision preview (either order)', async () => {
    const { session, viewer } = setup();
    session.artifacts.set('p', 'PREVIEW');
    session.artifacts.set('r', 'RENDER');
    session.emit(result({ kind: 'preview', sourceRevision: 5, artifactId: 'p' }));
    await flush();
    session.emit(result({ kind: 'render', sourceRevision: 5, artifactId: 'r' }));
    await flush();
    expect(viewer.offText).toBe('RENDER');
    // a late preview at the same revision must NOT overwrite the render
    session.emit(result({ kind: 'preview', sourceRevision: 5, artifactId: 'p' }));
    await flush();
    expect(viewer.offText).toBe('RENDER');
  });

  it('render bridge: out-of-order artifact reads can not clobber a higher-quality render', async () => {
    const { session, viewer } = setup();
    session.useDeferredReads = true;
    session.emit(result({ kind: 'preview', sourceRevision: 7, artifactId: 'p' }));
    session.emit(result({ kind: 'render', sourceRevision: 7, artifactId: 'r' }));
    // the render's read resolves first; the preview's lands late and must be dropped
    session.resolveRead('r', 'RENDER');
    await flush();
    session.resolveRead('p', 'PREVIEW');
    await flush();
    expect(viewer.offText).toBe('RENDER');
  });

  it('render bridge: a failed artifact read is swallowed (no crash, no render)', async () => {
    const { session, viewer } = setup();
    session.throwOnRead = true;
    session.emit(result({ kind: 'render', sourceRevision: 3, artifactId: 'a1' }));
    await flush();
    expect(viewer.offText).toBeNull();
  });

  it('dispose: tears down the session, transport, and operation subscription; idempotent', () => {
    const { session, transport, controller } = setup();
    controller.dispose();
    expect(session.disposed).toBe(true);
    expect(session.subscribed).toBe(false);
    // transport detached: further inbound is ignored.
    transport.receive({ protocolVersion: V, type: 'cancel' });
    expect(session.calls).toEqual(['dispose']);
    controller.dispose(); // idempotent
    expect(session.calls).toEqual(['dispose']);
  });

  it('a `dispose` inbound message tears the session down', () => {
    const { session, transport } = setup();
    transport.receive({ protocolVersion: V, type: 'dispose' });
    expect(session.disposed).toBe(true);
  });
});
