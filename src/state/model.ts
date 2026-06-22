// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { checkSyntax, render, RenderArgs } from '../runner/actions.ts';
import {
  MultiLayoutComponentId,
  SingleLayoutComponentId,
  State,
  StatePersister,
} from './app-state.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from './formats.ts';
import { bubbleUpDeepMutations } from './deep-mutate.ts';
import { fetchSource, formatBytes, formatMillis, readFileAsDataURL } from '../utils.ts';
import { openLocalFile, saveViaHandle } from '../fs/filesystem.ts';
import { ProjectFileSystem } from '../fs/project-filesystem.ts';
import { contentOf } from './project-source.ts';
import { ProjectStore } from './project-store.ts';
import { HostAdapter, WebHostAdapter } from './web-host-adapter.ts';
import { isExpectedJobCancellation, ProcessStreams } from '../runner/openscad-runner.ts';
import { is2DFormatExtension } from './formats.ts';
import { isUserFacingOperationError } from '../user-facing-errors.ts';
import { applyUserFacingError } from './apply-user-facing-error.ts';
import { ExportService } from './services/export-service.ts';
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

  // Sequence counters identifying the latest in-flight operation of each kind.
  // checkSyntax/render debounce and supersede one another (turnIntoDelayableExecution),
  // so a superseded call settles (rejects) while a newer one owns the shared UI
  // flags — these guards stop the stale call from clobbering the newer call's
  // previewing/rendering/checkingSyntax state.
  private _previewSeq = 0;
  private _renderSeq = 0;
  private _syntaxSeq = 0;

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
      this.processSource({ immediatePreview: true });
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
    if (value) {
      if (this.state.view.layout.mode === 'single') {
        this.changeSingleVisibility('editor');
      } else {
        this.changeMultiVisibility('editor', true);
      }
    }
    this.mutate((s) => (s.view.logs = value));
  }

  isComponentFullyVisible(id: SingleLayoutComponentId) {
    if (this.state.view.layout.mode === 'multi') {
      return this.state.view.layout[id];
    } else {
      return this.state.view.layout.focus === id;
    }
  }

  changeLayout(mode: 'multi' | 'single') {
    if (this.state.view.layout.mode === mode) return;
    this.mutate((s) => {
      s.view.layout =
        s.view.layout.mode === 'multi'
          ? {
              mode: 'single',
              focus: s.view.layout.editor
                ? 'editor'
                : s.view.layout.viewer
                  ? 'viewer'
                  : 'customizer',
            }
          : {
              mode: 'multi',
              editor: s.view.layout.focus === 'editor',
              viewer: s.view.layout.focus === 'viewer',
              customizer: s.view.layout.focus === 'customizer',
            };
    });
  }
  changeSingleVisibility(focus: SingleLayoutComponentId) {
    this.mutate((s) => {
      if (s.view.layout.mode !== 'single') throw new Error('Wrong mode');
      s.view.layout.focus = focus;
      if (focus !== 'editor') {
        s.view.logs = false;
      }
    });
  }

  changeMultiVisibility(target: MultiLayoutComponentId, visible: boolean) {
    this.mutate((s) => {
      if (s.view.layout.mode !== 'multi') throw new Error('Wrong mode');
      s.view.layout[target] = visible;
      if (
        (s.view.layout.customizer ? 1 : 0) +
          (s.view.layout.editor ? 1 : 0) +
          (s.view.layout.viewer ? 1 : 0) ==
        0
      ) {
        // Select at least one panel
        // s.view.layout.editor = true;
        s.view.layout[target] = !visible;
        if (target === 'editor' && !visible) {
          s.view.logs = false;
        }
      }
    });
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
    this.processSource();
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
      this.processSource();
    }
  }

  private async processSource({
    immediatePreview = false,
  }: {
    immediatePreview?: boolean;
  } = {}) {
    const src = this.state.params.sources.find((src) => src.path === this.state.params.activePath);
    // A source needs its content materialized when it is not yet inline text: an
    // unloaded remote (fetch its url) or an on-disk local file (read the fs).
    if (src && src.kind !== 'archive' && contentOf(src) == null) {
      const requestedPath = src.path;
      const url = src.kind === 'remote' ? src.url : undefined;
      try {
        const content = new TextDecoder().decode(
          await fetchSource(
            this.fs,
            { path: requestedPath, url },
            { baseUrl: this.host.baseUrl() },
          ),
        );
        // The active file may have changed while the fetch was in flight. Write
        // the content back to the source it was actually fetched for — never
        // whichever file is active now — and only if that source still needs it.
        let written = false;
        this.mutate((s) => {
          const target = s.params.sources.find((cur) => cur.path === requestedPath);
          if (!target || contentOf(target) != null) return; // removed or already filled
          s.params.sources = s.params.sources.map((cur) => {
            if (cur.path !== requestedPath) return cur;
            // A remote stays remote (now loaded, keeps its url); a local file's
            // content is inlined as text.
            return cur.kind === 'remote'
              ? { ...cur, content }
              : { kind: 'text', path: cur.path, content };
          });
          s.error = undefined;
          s.errorDetails = undefined;
          written = true;
        });
        // If the user has since switched away, a newer processSource owns the
        // active file's compilation — don't drive a render for the file they left.
        if (!written || requestedPath !== this.state.params.activePath) return;
      } catch (err) {
        // Only surface the error if this fetch is still for the active file.
        if (requestedPath === this.state.params.activePath) {
          this.mutate((s) => {
            applyUserFacingError(s, err, 'source');
          });
        }
        return;
      }
    }
    // When autoCompile is explicitly disabled, skip automatic syntax check and render.
    if (this.state.params.autoCompile === false) return;
    if (this.source.trim() !== '') {
      const shouldCheckSyntax = this.state.params.activePath.endsWith('.scad');
      if (immediatePreview) {
        // Keep the boot-time preview immediate and enqueue syntax only after the
        // first visible render has settled so startup stays user-visible first.
        await this.render({ isPreview: true, now: true });
        if (shouldCheckSyntax) {
          this.checkSyntax();
        }
        return;
      }
      if (shouldCheckSyntax) {
        this.checkSyntax();
      }
      this.render({ isPreview: true, now: false });
    }
  }

  async checkSyntax() {
    const token = ++this._syntaxSeq;
    const isCurrent = () => this._syntaxSeq === token;
    this.mutate((s) => (s.checkingSyntax = true));
    try {
      const checkerRun = await checkSyntax({
        activePath: this.state.params.activePath,
        sources: this.state.params.sources,
        revision: this._sourceRevision,
      })({ now: false });
      if (!isCurrent()) return; // a newer syntax check superseded this one
      if (checkerRun?.revision !== undefined && checkerRun.revision !== this._sourceRevision) {
        return; // sources changed since this check was requested — drop the stale result
      }
      this.mutate((s) => {
        s.lastCheckerRun = checkerRun;
        s.parameterSet = checkerRun?.parameterSet;
        s.checkingSyntax = false;
      });
    } catch (err) {
      if (!isCurrent()) return; // superseded — the newer check owns checkingSyntax
      if (!isExpectedJobCancellation(err)) {
        if (!isUserFacingOperationError(err)) {
          console.error('Error while checking syntax:', err);
        }
        this.mutate((s) => {
          applyUserFacingError(s, err, 'syntax');
        });
      }
    } finally {
      if (isCurrent()) {
        this.mutate((s) => {
          if (s.checkingSyntax) s.checkingSyntax = false;
        });
      }
    }
  }

  rawStreamsCallback(ps: ProcessStreams) {
    this.mutate((s) => {
      if ('stdout' in ps) {
        s.currentRunLogs?.push(['stdout', ps.stdout]);
      } else {
        s.currentRunLogs?.push(['stderr', ps.stderr]);
      }
    });
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
      this.processSource();
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
    this.processSource();
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
      this.host.download(this.host.createObjectURL(file), file.name);
    } else {
      try {
        const blob = await this.projectStore.buildZip(this.state.params.sources);
        const file = new File([blob], 'project.zip');
        this.host.download(this.host.createObjectURL(file), file.name);
      } catch (err) {
        this.mutate((s) => {
          applyUserFacingError(s, err, 'model');
        });
      }
    }
  }

  async render({
    isPreview,
    mountArchives,
    now,
    retryInOtherDim,
  }: {
    isPreview: boolean;
    mountArchives?: boolean;
    now: boolean;
    retryInOtherDim?: boolean;
  }) {
    // console.log(JSON.stringify(this.state, null, 2));
    mountArchives ??= true;
    retryInOtherDim ??= true;
    // A render and a preview own separate UI flags; track the latest of each so a
    // superseded call cannot turn off the spinner a newer call is still driving.
    const token = isPreview ? ++this._previewSeq : ++this._renderSeq;
    const isCurrent = () => (isPreview ? this._previewSeq : this._renderSeq) === token;
    const setRendering = (s: State, value: boolean) => {
      if (isPreview) {
        s.previewing = value;
      } else {
        s.rendering = value;
      }
    };
    this.mutate((s) => {
      s.currentRunLogs = [];
      setRendering(s, true);
      s.error = undefined;
      s.errorDetails = undefined;
    });

    let { activePath, sources } = this.state.params;
    const { vars, features } = this.state.params;

    let is2D = this.state.is2D;

    const extension = activePath.split('.').pop() ?? '';
    if (!activePath.endsWith('.scad')) {
      const resourcePath = activePath;
      const loaderPath = '/load-resource.scad';
      is2D = is2DFormatExtension(extension);

      mountArchives = false;
      activePath = loaderPath;
      sources = [
        {
          kind: 'text',
          path: activePath,
          content: `${is2D ? 'linear_extrude(1) ' : ''} import("${resourcePath}");`,
        },
        ...sources.filter((s) => s.path === resourcePath),
      ];
    }

    const renderArgs: RenderArgs = {
      mountArchives,
      scadPath: activePath,
      sources,
      vars,
      features,
      isPreview,
      renderFormat: is2D ? this.state.params.exportFormat2D : 'off',
      streamsCallback: this.rawStreamsCallback.bind(this),
      backend: this.state.params.backend,
      revision: this._sourceRevision,
    };
    try {
      const output = await render(renderArgs)({ now });
      if (!isCurrent()) return; // a newer render/preview superseded this one
      if (output.revision !== undefined && output.revision !== this._sourceRevision) {
        // Sources changed since this render was requested — drop the stale result.
        // Unlike the supersession case above, no newer call owns this spinner
        // flag, so we must clear it ourselves or it stays stuck (e.g. after
        // newFile(), which bumps the revision without dispatching a new render).
        this.mutate((s) => setRendering(s, false));
        return;
      }
      const displayFile = output.outFile;
      if (output.outFile.name.endsWith('.svg') || output.outFile.name.endsWith('.dxf')) {
        is2D = true;
      } else {
        is2D = false;
      }
      const outFileURL = this.host.createObjectURL(output.outFile);
      const displayFileURL = displayFile && (await readFileAsDataURL(displayFile));
      this.mutate((s) => {
        setRendering(s, false);
        s.error = undefined;
        s.errorDetails = undefined;
        s.is2D = is2D;
        s.lastCheckerRun = {
          logText: output.logText,
          markers: output.markers,
        };
        if (s.output?.outFileURL?.startsWith('blob:') ?? false) {
          this.host.revokeObjectURL(s.output!.outFileURL);
        }
        if (s.output?.displayFileURL?.startsWith('blob:') ?? false) {
          this.host.revokeObjectURL(s.output!.displayFileURL!);
        }

        s.output = {
          isPreview: isPreview,
          outFile: output.outFile,
          outFileURL,
          displayFile,
          displayFileURL,
          elapsedMillis: output.elapsedMillis,
          formattedElapsedMillis: formatMillis(output.elapsedMillis),
          formattedOutFileSize: formatBytes(output.outFile.size),
        };

        if (!isPreview) {
          this.host.playCompletionChime();
        }
      });
    } catch (err) {
      if (!isCurrent()) return; // superseded — the newer call owns the spinner state
      this.mutate((s) => {
        setRendering(s, false);
        if (!isExpectedJobCancellation(err)) {
          if (!isUserFacingOperationError(err)) {
            console.error('Error while doing ' + (isPreview ? 'preview' : 'rendering') + ':', err);
          }
          applyUserFacingError(s, err, isPreview ? 'preview' : 'render');
        }
      });
    }
    if (retryInOtherDim) {
      let is2D: boolean | undefined;
      let is3D: boolean | undefined;
      for (const [, line] of this.state.currentRunLogs ?? []) {
        if (line == 'Current top level object is not a 3D object.') {
          is3D = false;
        } else if (line == 'Top level object is a 3D object:') {
          is3D = true;
        } else if (line == 'Current top level object is not a 2D object.') {
          is2D = false;
        } else if (line == 'Top level object is a 2D object:') {
          is2D = true;
        }
      }
      if (is2D === false || is3D === false) {
        //} || isMixed !== undefined) {
        this.mutate((s) => (s.is2D = !(is2D === false)));
        this.render({ isPreview, now: true, retryInOtherDim: false });
        return;
      }
    }
  }
}
