import { Model } from './model.ts';
import { WasmWorkerBackend, type CompileBackend } from '../runner/openscad-runner.ts';
import { newId } from '../runner/compile-contract.ts';
import { ArtifactStore } from './artifact-store.ts';
import type { ProjectFile, ProjectContract } from './project-contract.ts';
import type { ProjectFileSystem } from '../fs/project-filesystem.ts';
import type { State, StatePersister } from './app-state.ts';
import type { HostAdapter } from './web-host-adapter.ts';
import type { WorkerLibrary } from '../runner/worker-protocol.ts';
import type { ExportFormat } from './formats.ts';

/**
 * An instance-scoped OpenSCAD session: the unit of isolation (ADR 0007). It owns
 * a `CompileBackend` (its own worker) and a `Model` wired to it, so two sessions
 * on one page share nothing — no worker, id space, pending jobs, or schedulers —
 * and can be torn down independently. The app constructs exactly one; future
 * multi-document hosts construct N.
 *
 * It implements the host-drivable {@link ProjectContract} (#123) by delegating to
 * its Model — the in-process binding a future transport maps onto (ADR 0005).
 */
export class OpenScadSession implements ProjectContract {
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

  /** Whether the host has pushed a project yet — a wire render before that
   *  would silently full-render the DEFAULT playground model (the session
   *  entry never init()s precisely to avoid showing it). */
  private hostProjectSet = false;

  // --- ProjectContract (#123): host-drivable project ops, delegated to Model ---
  setProject(files: ProjectFile[], entryPoint?: string): void {
    this.hostProjectSet = true;
    this.model.setProject(files, entryPoint);
  }
  updateFile(path: string, content: string): void {
    this.model.updateFile(path, content);
  }
  removeFile(path: string): void {
    this.model.removeFile(path);
  }
  setEntryPoint(path: string): void {
    this.model.setEntryPoint(path);
  }

  /** Replace the runtime user-library set (ADR 0010 / #195): declarative full
   *  set, revision-bumping (the resulting recompile correlates via the ack). */
  setLibraries(libraries: WorkerLibrary[]): void {
    // Pre-project, apply WITHOUT recompiling: nothing of the host's exists to
    // compile yet, and compiling would render (and display!) the default
    // playground model — the same trap the render guard closes (#219 review).
    this.model.setLibraries(libraries, this.hostProjectSet);
  }

  /** Run a FULL render of the current model (#219) — `$preview = false`,
   *  render-quality geometry. The terminal lands on the operation stream as a
   *  `kind: 'render'` result echoing `requestId`; its OFF commits as the
   *  session output, so a subsequent export converts render-quality geometry
   *  (and the embedded viewer shows it). */
  render(requestId?: string): void {
    if (!this.hostProjectSet) {
      // Never render (and display!) the default playground model on a host
      // bug — fail the request loudly instead (#219 review).
      this.model.emitOperationFailure(
        'render',
        'no-project',
        'no project has been pushed — send setProject before render',
        requestId,
      );
      return;
    }
    void this.model.render({ isPreview: false, now: true, requestId });
  }

  /** Export the current model as `format` (#216); the terminal lands on the
   *  operation stream as a `kind: 'export'` result. */
  exportArtifact(format: ExportFormat, requestId?: string): void {
    this.model.exportArtifact(format, requestId);
  }

  /** Cancel in-flight operations (#123): all of them, or — with `requestId`
   *  (#226) — only the operation started by the command carrying that id. */
  cancel(requestId?: string): void {
    this.model.cancel(requestId);
  }

  /** Tear the session down: stop persistence timers and terminate the worker.
   *  Fixes the page-lifetime worker leak the singleton had. */
  dispose(): void {
    this.model.dispose();
    this.backend.dispose();
  }
}
