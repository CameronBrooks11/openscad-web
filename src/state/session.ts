import { Model } from './model.ts';
import { WasmWorkerBackend, type CompileBackend } from '../runner/openscad-runner.ts';
import { newId } from '../runner/compile-contract.ts';
import { ArtifactStore } from './artifact-store.ts';
import type { ProjectFileSystem } from '../fs/project-filesystem.ts';
import type { State, StatePersister } from './app-state.ts';
import type { HostAdapter } from './web-host-adapter.ts';

/**
 * An instance-scoped OpenSCAD session: the unit of isolation (ADR 0007). It owns
 * a `CompileBackend` (its own worker) and a `Model` wired to it, so two sessions
 * on one page share nothing — no worker, id space, pending jobs, or schedulers —
 * and can be torn down independently. The app constructs exactly one; future
 * multi-document hosts construct N.
 */
export class OpenScadSession {
  /** Stable session id, for routing/debug correlation of operations/artifacts. */
  readonly id = newId();
  readonly backend: CompileBackend;
  readonly artifacts = new ArtifactStore();
  readonly model: Model;

  constructor(
    fs: ProjectFileSystem,
    state: State,
    setStateCallback?: (state: State) => void,
    statePersister?: StatePersister,
    host?: HostAdapter,
  ) {
    this.backend = new WasmWorkerBackend();
    this.model = new Model(
      fs,
      state,
      setStateCallback,
      statePersister,
      host,
      this.backend,
      this.id,
      this.artifacts,
    );
  }

  /** Kick off the initial compile (delegates to the model). */
  init(): void {
    this.model.init();
  }

  /** Cancel this session's in-flight compile/export operations (#123). */
  cancel(): void {
    this.model.cancel();
  }

  /** Tear the session down: stop persistence timers and terminate the worker.
   *  Fixes the page-lifetime worker leak the singleton had. */
  dispose(): void {
    this.model.dispose();
    this.backend.dispose();
  }
}
