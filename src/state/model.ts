// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import {
  MultiLayoutComponentId,
  SingleLayoutComponentId,
  State,
  StatePersister,
} from './app-state.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from './formats.ts';
import { bubbleUpDeepMutations } from './deep-mutate.ts';
import { openLocalFile, saveViaHandle } from '../fs/filesystem.ts';
import { ProjectFileSystem } from '../fs/project-filesystem.ts';
import { contentOf } from './project-source.ts';
import { ProjectStore } from './project-store.ts';
import { HostAdapter, WebHostAdapter } from './web-host-adapter.ts';
import { applyUserFacingError } from './apply-user-facing-error.ts';
import { CompileCoordinator } from './services/compile-coordinator.ts';
import { ExportService } from './services/export-service.ts';
import { LayoutController } from './services/layout-controller.ts';
import type { ServiceContext } from './services/service-context.ts';

/** Debounce window for durable-state persistence (coalesces rapid edits/drags). */
const PERSIST_DEBOUNCE_MS = 500;
/** Cap so persistence still flushes during sustained activity (e.g. log streaming). */
const PERSIST_MAX_WAIT_MS = 2000;

/** The durable slice of State that is persisted (matches the fragment encoder). */
type PersistedSlice = Pick<State, 'params' | 'view' | 'preview'>;
const durableSlice = (state: State): PersistedSlice => ({
  params: state.params,
  view: state.view,
  preview: state.preview,
});

export class Model extends EventTarget {
  /** Owns project-source logic (lookup, edits, file ops, ZIP import/export). */
  private readonly projectStore: ProjectStore;
  private readonly serviceCtx: ServiceContext;
  private readonly exportService: ExportService;
  private readonly compile: CompileCoordinator;
  private readonly layout: LayoutController;

  constructor(
    private fs: ProjectFileSystem,
    public state: State,
    private setStateCallback?: (state: State) => void,
    private statePersister?: StatePersister,
    private host: HostAdapter = new WebHostAdapter(),
  ) {
    super();
    this.projectStore = new ProjectStore(fs);
    this._prevSources = state.params.sources;
    this._lastPersistedJson = JSON.stringify(durableSlice(state));
    this.serviceCtx = this.buildServiceContext();
    this.exportService = new ExportService(this.serviceCtx);
    this.compile = new CompileCoordinator(this.serviceCtx);
    this.layout = new LayoutController(this.serviceCtx);
  }

  /** The shared surface the extracted services read state and mutate through. */
  private buildServiceContext(): ServiceContext {
    return {
      getState: () => this.state,
      mutate: (f) => this.mutate(f),
      getSourceRevision: () => this._sourceRevision,
      getActiveSource: () => this.source,
      host: this.host,
      fs: this.fs,
    };
  }

  // Monotonic source/project revision (#56). Bumped centrally in setState
  // whenever params.sources changes identity, stamped onto each compile request,
  // and checked when a result lands: a result produced from a since-superseded
  // revision is dropped. This is source-identity defense complementing the
  // call-ordering sequence guards above.
  private _sourceRevision = 0;
  private _prevSources: State['params']['sources'];

  // FSAPI write-back handles, keyed by source path (Chromium only). Scoping the
  // handle to a path keeps `saveProject()` writing back to the source the handle
  // was opened for, rather than whichever file was opened last.
  private fsapiHandles = new Map<string, FileSystemFileHandle>();

  // Scoped persistence: only the durable slice (params/view/preview) is written,
  // so transient mutations (rendering flags, logs, errors, output URLs) don't
  // cause writes. Writes are debounced and serialized. deep-mutate only re-bumps
  // the top-level State identity (nested objects mutate in place), so durable
  // changes are detected by comparing a JSON signature of the slice — computed
  // once per debounce window, not per mutation.
  private _lastPersistedJson: string;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private _persistDeadline: number | null = null;
  private _persistInFlight = false;
  private _persistPending = false;

  init() {
    if (
      !this.state.output &&
      !this.state.lastCheckerRun &&
      !this.state.previewing &&
      !this.state.checkingSyntax &&
      !this.state.rendering
    ) {
      this.compile.processSource({ immediatePreview: true });
    }
  }

  private setState(state: State) {
    // bubbleUpDeepMutations gives params.sources a fresh identity exactly when
    // its contents change (and not on view/var-only edits), so a reference
    // change here is a reliable "the project sources changed" signal.
    if (state.params.sources !== this._prevSources) {
      this._prevSources = state.params.sources;
      this._sourceRevision++;
    }
    this.state = state;
    this.schedulePersist();
    this.setStateCallback?.(state);
    this.dispatchEvent(new CustomEvent<State>('state', { detail: state }));
  }

  /**
   * Debounce a persistence check; the actual durable-change test runs at flush.
   * A max-wait deadline ensures the timer still fires under sustained activity
   * (e.g. a render streaming logs) rather than being pushed back indefinitely.
   */
  private schedulePersist() {
    if (!this.statePersister) return;
    const now = Date.now();
    if (this._persistDeadline == null) this._persistDeadline = now + PERSIST_MAX_WAIT_MS;
    const delay = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, this._persistDeadline - now));
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistDeadline = null;
      void this.flushPersist();
    }, delay);
  }

  /**
   * Persist the durable slice, but only if it actually changed (so transient-only
   * mutations write nothing). Serialized so writes can't overlap or reorder; the
   * latest state is coalesced into a single follow-up write, and errors are logged.
   */
  private async flushPersist() {
    if (!this.statePersister) return;
    if (this._persistInFlight) {
      this._persistPending = true; // re-check & persist the latest once the current write finishes
      return;
    }
    const json = JSON.stringify(durableSlice(this.state));
    if (json === this._lastPersistedJson) return; // durable state unchanged — skip the write
    this._persistInFlight = true;
    try {
      await this.statePersister.set(this.state);
      this._lastPersistedJson = json; // record only on success so a failed write retries
    } catch (e) {
      console.error('Failed to persist state:', e);
    } finally {
      this._persistInFlight = false;
      if (this._persistPending) {
        this._persistPending = false;
        void this.flushPersist();
      }
    }
  }

  mutate(f: (state: State) => void) {
    const mutated = bubbleUpDeepMutations(this.state, f);
    // No matter how deep the mutation happened, the top-level object's identity
    // will have changed iff the mutated values are different.
    if (mutated !== this.state) {
      this.setState(mutated);
      return true;
    }

    return false;
  }

  clearError() {
    this.mutate((s) => {
      s.error = undefined;
      s.errorDetails = undefined;
    });
  }

  setFormats(
    exportFormat2D: keyof typeof VALID_EXPORT_FORMATS_2D | undefined,
    exportFormat3D: keyof typeof VALID_EXPORT_FORMATS_3D | undefined,
  ) {
    let rerender2DPreview = false;
    this.mutate((s) => {
      if (exportFormat2D != null && s.params.exportFormat2D !== exportFormat2D) {
        s.params.exportFormat2D = exportFormat2D;
        rerender2DPreview = s.is2D === true && s.params.autoCompile !== false;
      }
      if (exportFormat3D != null) s.params.exportFormat3D = exportFormat3D;
    });
    if (rerender2DPreview) {
      this.render({ isPreview: true, now: true });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setVar(name: string, value: any) {
    this.mutate((s) => (s.params.vars = { ...(s.params.vars ?? {}), [name]: value }));
    this.render({ isPreview: true, now: false });
  }

  set logsVisible(value: boolean) {
    this.layout.setLogsVisible(value);
  }

  isComponentFullyVisible(id: SingleLayoutComponentId) {
    return this.layout.isComponentFullyVisible(id);
  }

  changeLayout(mode: 'multi' | 'single') {
    this.layout.changeLayout(mode);
  }

  changeSingleVisibility(focus: SingleLayoutComponentId) {
    this.layout.changeSingleVisibility(focus);
  }

  changeMultiVisibility(target: MultiLayoutComponentId, visible: boolean) {
    this.layout.changeMultiVisibility(target, visible);
  }

  openFile(path: string) {
    const next = this.projectStore.openFile(
      this.state.params.sources,
      this.state.params.activePath,
      path,
    );
    if (!next) return; // already the active file
    this.mutate((s) => {
      s.params.sources = next.sources;
      s.params.activePath = next.activePath;
      s.lastCheckerRun = undefined;
      s.output = undefined;
      s.export = undefined;
      s.preview = undefined;
      s.currentRunLogs = undefined;
      s.error = undefined;
      s.errorDetails = undefined;
      s.is2D = undefined;
    });
    this.compile.processSource();
  }

  get source(): string {
    return this.projectStore.activeContent(this.state.params.sources, this.state.params.activePath);
  }
  set source(source: string) {
    if (
      this.mutate((s) => {
        s.params.sources = this.projectStore.withActiveContent(
          s.params.sources,
          s.params.activePath,
          source,
        );
      })
    ) {
      this.compile.processSource();
    }
  }

  /** Run a syntax check on the active source (delegates to the coordinator). */
  checkSyntax() {
    return this.compile.checkSyntax();
  }

  export() {
    return this.exportService.export();
  }

  /** Creates a new empty .scad file in /home/ and activates it. */
  newFile(): void {
    const next = this.projectStore.newFile(this.state.params.sources);
    this.mutate((s) => {
      s.params.sources = next.sources;
      s.params.activePath = next.activePath;
      s.lastCheckerRun = undefined;
      s.output = undefined;
      s.error = undefined;
      s.errorDetails = undefined;
    });
  }

  /** Extracts a ZIP archive into /home/ and activates the entry .scad. */
  async importProjectZip(zipBuffer: ArrayBuffer): Promise<void> {
    try {
      const next = await this.projectStore.importZip(zipBuffer);
      if (!next) return; // archive had no files
      // A ZIP import replaces the whole project — none of the imported sources
      // were opened via FSAPI, so drop every retained handle (a surviving
      // handle for a colliding path would write archive content to the user's
      // original on-disk file).
      this.fsapiHandles.clear();
      this.mutate((s) => {
        s.params.sources = next.sources;
        s.params.activePath = next.activePath;
        s.lastCheckerRun = undefined;
        s.output = undefined;
        s.error = undefined;
        s.errorDetails = undefined;
      });
      this.compile.processSource();
    } catch (err) {
      this.mutate((s) => {
        applyUserFacingError(s, err, 'model');
      });
    }
  }

  /** Opens a local file via the File System Access API. Returns true if opened. */
  async openFileViaFSAPI(): Promise<boolean> {
    const result = await openLocalFile();
    if (!result) return false;
    const path = `/home/${result.name}`;
    const next = this.projectStore.addFile(this.state.params.sources, path, result.content);
    this.fsapiHandles.set(path, result.handle);
    this.mutate((s) => {
      s.params.sources = next.sources;
      s.params.activePath = next.activePath;
      s.lastCheckerRun = undefined;
      s.output = undefined;
      s.error = undefined;
      s.errorDetails = undefined;
    });
    this.compile.processSource();
    return true;
  }

  async saveProject() {
    if (this.state.params.sources.length == 1) {
      const content = contentOf(this.state.params.sources[0]) ?? '';
      // Write back through the FSAPI handle for the *active* source, if it was
      // opened that way; otherwise fall back to a download.
      const activePath = this.state.params.activePath;
      const handle = this.fsapiHandles.get(activePath);
      if (handle) {
        if (await saveViaHandle(handle, content)) return;
        this.fsapiHandles.delete(activePath); // handle invalidated — drop it
      }
      // TextEncoder.encode() always returns an ArrayBuffer-backed Uint8Array;
      // cast required because the TS lib defines encode() → Uint8Array (= <ArrayBufferLike>)
      // while Blob's BlobPart expects ArrayBufferView<ArrayBuffer>. TS 5.7+ issue.
      const contentBytes = new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
      const blob = new Blob([contentBytes], { type: 'text/plain' });
      const file = new File([blob], this.state.params.activePath.split('/').pop()!);
      this.host.downloadBlob(file, file.name);
    } else {
      try {
        const blob = await this.projectStore.buildZip(this.state.params.sources);
        const file = new File([blob], 'project.zip');
        this.host.downloadBlob(file, file.name);
      } catch (err) {
        this.mutate((s) => {
          applyUserFacingError(s, err, 'model');
        });
      }
    }
  }

  /** Run a preview or full render (delegates to the coordinator). */
  render(args: {
    isPreview: boolean;
    mountArchives?: boolean;
    now: boolean;
    retryInOtherDim?: boolean;
  }) {
    return this.compile.render(args);
  }
}
