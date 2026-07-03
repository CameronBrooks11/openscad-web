// Transport-agnostic Layer-1 session controller (ADR 0009 / #192). The compile
// counterpart to the read-only `ViewerController`: it binds a compiling session to
// a `Transport`, validates inbound commands, drives the session's `ProjectContract`,
// streams the session's operation results back to the host, and — under the
// embedded-viewer model (#179) — renders the produced geometry IN-PROCESS into the
// session webview's own viewer (no geometry crosses the wire).
//
// It depends only on the protocol, the payload-agnostic `Transport`, and a minimal
// `SessionHost` seam (so it's unit-testable without a real OpenSCAD worker); the
// `OpenScadSession` adapter lives in ./session-host.ts.

import {
  SESSION_COMMANDS,
  sessionArtifact,
  sessionError,
  sessionOperationResult,
  sessionReady,
  validateSessionInbound,
} from '../protocol/session-transport.ts';
import type { SessionExportFormat } from '../protocol/session-transport.ts';
import type { ArtifactRef, OperationResult, ProjectFile } from '../protocol/session-contract.ts';
import type { Transport } from '../viewer-host/transport.ts';

/** The minimal session surface the controller drives (adapted from `OpenScadSession`). */
export interface SessionHost {
  setProject(files: ProjectFile[], entryPoint?: string): void;
  updateFile(path: string, content: string): void;
  removeFile(path: string): void;
  setEntryPoint(path: string): void;
  /** Export the current model as `format` (#216). Fire-and-observe: the terminal
   *  lands on the operation stream as a `kind: 'export'` result (success with an
   *  ArtifactRef, or a failure — e.g. a dimensionality mismatch). */
  exportArtifact(format: SessionExportFormat): void;
  cancel(): void;
  dispose(): void;
  /** Subscribe to terminal operation results (the Model's `'operation'` stream);
   *  returns an unsubscribe. */
  onOperation(handler: (result: OperationResult) => void): () => void;
  /** The exact OFF text of a produced artifact (race-free, by id), or undefined. */
  readArtifactText(artifactId: string): Promise<string | undefined>;
  /** A produced artifact's immutable identity + exact bytes (by id), for the
   *  `getArtifact` export round-trip (#197); undefined if unknown/evicted. */
  getArtifact(
    artifactId: string,
  ): Promise<{ artifact: ArtifactRef; bytes: Uint8Array } | undefined>;
}

/** The minimal viewer surface the render bridge sets (the embedded geometry viewer). */
export interface SessionViewer {
  offText: string | null;
}

export class SessionController {
  private disposed = false;
  private readonly unsubscribeOperations: () => void;
  /** The (revision, quality-rank) of the geometry currently shown, so a stale or
   *  lower-quality result can't overwrite it even if its async read finishes late. */
  private renderedRevision = -1;
  private renderedRank = -1;

  constructor(
    private readonly session: SessionHost,
    private readonly viewer: SessionViewer,
    private readonly transport: Transport,
  ) {
    this.unsubscribeOperations = session.onOperation(this.onOperation);
    // Subscribe BEFORE announcing readiness, so a host that sends a command the
    // instant it sees `ready` is never racing our inbound handler.
    transport.subscribe(this.onInbound);
    transport.send(sessionReady(SESSION_COMMANDS));
  }

  private onInbound = (payload: unknown): void => {
    if (this.disposed) return;
    const result = validateSessionInbound(payload);
    if (!result.ok) {
      this.transport.send(sessionError(result.code, result.reason));
      return;
    }
    const msg = result.message;
    try {
      switch (msg.type) {
        case 'setProject':
          this.session.setProject(msg.files, msg.entryPoint);
          break;
        case 'updateFile':
          this.session.updateFile(msg.path, msg.content);
          break;
        case 'removeFile':
          this.session.removeFile(msg.path);
          break;
        case 'setEntryPoint':
          this.session.setEntryPoint(msg.path);
          break;
        case 'export':
          this.session.exportArtifact(msg.format);
          break;
        case 'getArtifact':
          void this.sendArtifact(msg.requestId, msg.artifactId);
          break;
        case 'cancel':
          this.session.cancel();
          break;
        case 'dispose':
          this.dispose();
          break;
      }
    } catch (e) {
      // Defensive: `Model` catches contract errors internally (ProjectPathError →
      // state.error, invisible on the wire — a known gap), so this only fires for
      // a genuinely escaping throw; surface it rather than letting it kill the
      // transport's message pump. Skip if a `dispose` command's teardown threw —
      // the transport is already gone.
      if (this.disposed) return;
      this.transport.send(sessionError('invalid-payload', String((e as Error)?.message ?? e)));
    }
  };

  /** Answer `getArtifact` with the bytes, or `available: false` for an unknown/
   *  evicted id OR a failed read — a live session always sends a terminal reply
   *  for the `requestId`. (After dispose no reply is sent: the host initiated
   *  teardown and the transport may already be gone.) */
  private async sendArtifact(requestId: string, artifactId: string): Promise<void> {
    let resolved: { artifact: ArtifactRef; bytes: Uint8Array } | undefined;
    try {
      resolved = await this.session.getArtifact(artifactId);
    } catch {
      resolved = undefined; // blob read failed — report unavailable, not silence.
    }
    if (this.disposed) return;
    this.transport.send(sessionArtifact(requestId, resolved));
  }

  private onOperation = (result: OperationResult): void => {
    if (this.disposed) return;
    this.transport.send(sessionOperationResult(result));
    void this.render(result);
  };

  /** Render bridge: push a successful 3D (OFF) result's bytes into the embedded
   *  viewer. Supersession is by (revision, quality): a newer revision always wins,
   *  and at the same revision a full `render` beats a fast `preview` — checked both
   *  before and after the async read so out-of-order completions can't clobber it. */
  private async render(result: OperationResult): Promise<void> {
    if (result.status !== 'success' || result.artifact?.format !== 'off') return;
    const rank = renderRank(result.kind);
    if (!this.supersedesRender(result.sourceRevision, rank)) return;
    let text: string | undefined;
    try {
      text = await this.session.readArtifactText(result.artifact.artifactId);
    } catch {
      return; // artifact read failed (evicted / blob error) — leave the current render.
    }
    if (text === undefined || this.disposed) return;
    if (!this.supersedesRender(result.sourceRevision, rank)) return; // a newer/better render landed
    this.renderedRevision = result.sourceRevision;
    this.renderedRank = rank;
    this.viewer.offText = text;
  }

  private supersedesRender(revision: number, rank: number): boolean {
    return (
      revision > this.renderedRevision ||
      (revision === this.renderedRevision && rank > this.renderedRank)
    );
  }

  /** Tear down: stop forwarding, dispose the session (terminating its worker), and
   *  detach the transport last (via finally, so a throwing session teardown still
   *  releases the transport). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeOperations();
    try {
      this.session.dispose();
    } finally {
      this.transport.dispose();
    }
  }
}

/** Render quality rank: a full `render` supersedes a fast `preview` at the same revision. */
function renderRank(kind: OperationResult['kind']): number {
  return kind === 'render' ? 1 : kind === 'preview' ? 0 : -1;
}
