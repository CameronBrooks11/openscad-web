import type { ProjectFileSystem } from '../../fs/project-filesystem.ts';
import type { OperationResult } from '../../runner/compile-contract.ts';
import type { CompileBackend } from '../../runner/openscad-runner.ts';
import type { ArtifactStore } from '../artifact-store.ts';
import type { State } from '../app-state.ts';
import type { HostAdapter } from '../web-host-adapter.ts';

/**
 * The slice of `Model` that extracted domain services depend on. Model wires
 * every service to a single shared context so services read state and route all
 * writes through `mutate` (the central funnel that fires the `'state'` event,
 * schedules persistence, and bumps the source revision) — never touching those
 * concerns directly.
 */
export interface ServiceContext {
  /**
   * The current app state. Each `mutate` replaces the top-level state identity
   * (deep-mutate bubbles new identities along the changed spine), so a held
   * reference goes stale across a mutation — call `getState()` again, or only
   * snapshot fields no subsequent mutation in scope will touch.
   */
  getState(): State;
  /** Apply a mutation; returns true if state changed. */
  mutate(f: (state: State) => void): boolean;
  /** Monotonic source/project revision (bumped centrally on source change). */
  getSourceRevision(): number;
  /** Content of the active source ('' if absent or not yet loaded). */
  getActiveSource(): string;
  /** Browser side effects (object URLs, downloads, completion chime, base URL). */
  readonly host: HostAdapter;
  /** The project filesystem (narrow read/write surface). */
  readonly fs: ProjectFileSystem;
  /** This session's compile engine; the schedulers submit jobs to it (ADR 0007). */
  readonly backend: CompileBackend;
  /** This session's id, for operation/artifact correlation (ADR 0008). */
  readonly sessionId: string;
  /** This session's artifact store — bytes by immutable artifactId (ADR 0008). */
  readonly artifacts: ArtifactStore;
  /**
   * Optional sink for the one terminal `OperationResult` each operation produces
   * (ADR 0008). When unset the emit short-circuits, so the deploy-critical commit
   * path stays byte-identical; wiring it (e.g. to a Model event for the future MCP
   * binding) is a one-line change. The UI commit and embed events are unchanged —
   * they still derive from `FileOutput`; this is the correlated parallel record.
   */
  readonly onOperationResult?: (result: OperationResult) => void;
}
