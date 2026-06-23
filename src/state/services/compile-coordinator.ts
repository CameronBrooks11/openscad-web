import {
  createRenderDelayable,
  createSyntaxDelayable,
  type RenderArgs,
} from '../../runner/actions.ts';
import { newId } from '../../runner/compile-contract.ts';
import { isExpectedJobCancellation, type ProcessStreams } from '../../runner/openscad-runner.ts';
import { isUserFacingOperationError, UserFacingOperationError } from '../../user-facing-errors.ts';
import { fetchSource, formatBytes, formatMillis } from '../../utils.ts';
import { applyUserFacingError } from '../apply-user-facing-error.ts';
import type { State } from '../app-state.ts';
import { is2DFormatExtension } from '../formats.ts';
import {
  contentOf,
  isProbablyTextPath,
  toWire,
  type SerializableSource,
  type WireSource,
} from '../project-source.ts';
import type { ServiceContext } from './service-context.ts';

/**
 * Owns the compile lifecycle: materializing the active source, syntax checking,
 * and preview/full rendering — including the supersession sequence guards, the
 * source-revision stale-drop, and the dimension-retry. It reads state and writes
 * results through the shared ServiceContext, and plays the completion chime via
 * the host adapter; it never touches the DOM directly.
 */
export class CompileCoordinator {
  constructor(private ctx: ServiceContext) {
    // Built in the constructor body, reading the `ctx` PARAMETER (always bound at
    // call time), rather than a field initializer reading `this.ctx` — whose
    // ordering vs the `ctx` parameter-property assignment depends on
    // `useDefineForClassFields`. Reading the parameter is unconditionally correct.
    this._render = createRenderDelayable(ctx.backend);
    this._checkSyntax = createSyntaxDelayable(ctx.backend);
  }

  // Sequence counters identifying the latest in-flight operation of each kind.
  // checkSyntax/render debounce and supersede one another (turnIntoDelayableExecution),
  // so a superseded call settles (rejects) while a newer one owns the shared UI
  // flags — these guards stop the stale call from clobbering the newer call's
  // previewing/rendering/checkingSyntax state.
  private _previewSeq = 0;
  private _renderSeq = 0;
  private _syntaxSeq = 0;

  // Per-coordinator (= per-session) schedulers, bound to this session's engine,
  // so independent sessions never cross-cancel and run on their own worker. One
  // render delayable shared by preview + full render (they supersede each other);
  // syntax has its own. See ADR 0007.
  private readonly _render: ReturnType<typeof createRenderDelayable>;
  private readonly _checkSyntax: ReturnType<typeof createSyntaxDelayable>;

  /**
   * Convert the typed sources to the flat wire shape, reading each project-local
   * file's bytes off the host FS so the worker's fresh per-job FS receives them
   * (ADR 0006). `/libraries` + `/fonts` locals stay content-less — the worker has
   * them via its read-only mounts. A project-local file with no bytes on disk
   * (e.g. a shared-URL reload that carries the path but not the asset) surfaces a
   * clear error rather than letting the worker compile a broken model.
   */
  private async materializeBinarySources(sources: SerializableSource[]): Promise<WireSource[]> {
    return Promise.all(
      sources.map(async (source): Promise<WireSource> => {
        const isMount = source.path.startsWith('/libraries/') || source.path.startsWith('/fonts/');
        if (source.kind !== 'local' || isMount) return toWire(source);
        try {
          const content = await fetchSource(
            this.ctx.fs,
            { path: source.path },
            { baseUrl: this.ctx.host.baseUrl() },
          );
          return { path: source.path, content };
        } catch {
          throw new UserFacingOperationError({
            message:
              `Asset not available: ${source.path}. It is referenced by the model but ` +
              `its bytes are not in this session (a shared link does not carry binary assets).`,
          });
        }
      }),
    );
  }

  async processSource({ immediatePreview = false }: { immediatePreview?: boolean } = {}) {
    const src = this.ctx
      .getState()
      .params.sources.find((src) => src.path === this.ctx.getState().params.activePath);
    // A source needs its content materialized as TEXT when it is not yet inline:
    // an unloaded remote (fetch its url) or an on-disk text local file (read the
    // fs). A binary `local` asset (non-text extension) must NOT be text-decoded —
    // that corrupts it; like `archive` it stays content-less and its bytes flow
    // through the worker-transfer path instead (ADR 0006).
    const isBinaryLocal = src?.kind === 'local' && !isProbablyTextPath(src.path);
    if (src && src.kind !== 'archive' && !isBinaryLocal && contentOf(src) == null) {
      const requestedPath = src.path;
      const url = src.kind === 'remote' ? src.url : undefined;
      try {
        const content = new TextDecoder().decode(
          await fetchSource(
            this.ctx.fs,
            { path: requestedPath, url },
            { baseUrl: this.ctx.host.baseUrl() },
          ),
        );
        // The active file may have changed while the fetch was in flight. Write
        // the content back to the source it was actually fetched for — never
        // whichever file is active now — and only if that source still needs it.
        let written = false;
        this.ctx.mutate((s) => {
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
        if (!written || requestedPath !== this.ctx.getState().params.activePath) return;
      } catch (err) {
        // Only surface the error if this fetch is still for the active file.
        if (requestedPath === this.ctx.getState().params.activePath) {
          this.ctx.mutate((s) => {
            applyUserFacingError(s, err, 'source');
          });
        }
        return;
      }
    }
    // When autoCompile is explicitly disabled, skip automatic syntax check and render.
    if (this.ctx.getState().params.autoCompile === false) return;
    // Render when there is editable text OR the active file is a non-.scad asset
    // (a binary local has no inline text but renders via the import() wrapper in
    // render(), which materializes its bytes — #121).
    const activePath = this.ctx.getState().params.activePath;
    if (this.ctx.getActiveSource().trim() !== '' || !activePath.endsWith('.scad')) {
      const shouldCheckSyntax = activePath.endsWith('.scad');
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
    this.ctx.mutate((s) => (s.checkingSyntax = true));
    try {
      const checkerRun = await this._checkSyntax({
        activePath: this.ctx.getState().params.activePath,
        // The param/syntax pass never resolves `import()` (it's lazy, evaluated
        // only at geometry time), so a binary `local` asset is not needed here —
        // and sending it content-less makes the worker log "File … does not
        // exist". Drop binary locals; text/.scad sources are kept (#153).
        sources: this.ctx
          .getState()
          .params.sources.filter((s) => !(s.kind === 'local' && !isProbablyTextPath(s.path))),
        revision: this.ctx.getSourceRevision(),
      })({ now: false });
      if (!isCurrent()) return; // a newer syntax check superseded this one
      if (
        checkerRun?.revision !== undefined &&
        checkerRun.revision !== this.ctx.getSourceRevision()
      ) {
        return; // sources changed since this check was requested — drop the stale result
      }
      this.ctx.mutate((s) => {
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
        this.ctx.mutate((s) => {
          applyUserFacingError(s, err, 'syntax');
        });
      }
    } finally {
      if (isCurrent()) {
        this.ctx.mutate((s) => {
          if (s.checkingSyntax) s.checkingSyntax = false;
        });
      }
    }
  }

  rawStreamsCallback(ps: ProcessStreams) {
    this.ctx.mutate((s) => {
      if ('stdout' in ps) {
        s.currentRunLogs?.push(['stdout', ps.stdout]);
      } else {
        s.currentRunLogs?.push(['stderr', ps.stderr]);
      }
    });
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
    mountArchives ??= true;
    retryInOtherDim ??= true;
    // A render and a preview own separate UI flags; track the latest of each so a
    // superseded call cannot turn off the spinner a newer call is still driving.
    const token = isPreview ? ++this._previewSeq : ++this._renderSeq;
    const isCurrent = () => (isPreview ? this._previewSeq : this._renderSeq) === token;
    // One operation id per scheduler invocation (ADR 0008). The dimension retry
    // is a distinct recursive render(), so it mints its own — never shared.
    const operationId = newId();
    const setRendering = (s: State, value: boolean) => {
      if (isPreview) {
        s.previewing = value;
      } else {
        s.rendering = value;
      }
    };
    this.ctx.mutate((s) => {
      s.currentRunLogs = [];
      setRendering(s, true);
      s.error = undefined;
      s.errorDetails = undefined;
    });

    let { activePath, sources } = this.ctx.getState().params;
    const { vars, features } = this.ctx.getState().params;

    let is2D = this.ctx.getState().is2D;

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

    try {
      // Materialize binary /home assets' bytes into the request so the worker's
      // fresh per-job FS has them (ADR 0006). Runs on the FINAL `sources` (after
      // the non-.scad wrapper above) so a kept binary asset is included.
      const renderArgs: RenderArgs = {
        mountArchives,
        scadPath: activePath,
        sources: await this.materializeBinarySources(sources),
        vars,
        features,
        isPreview,
        renderFormat: is2D ? this.ctx.getState().params.exportFormat2D : 'off',
        streamsCallback: this.rawStreamsCallback.bind(this),
        backend: this.ctx.getState().params.backend,
        revision: this.ctx.getSourceRevision(),
      };
      const output = await this._render(renderArgs)({ now });
      if (!isCurrent()) return; // a newer render/preview superseded this one
      if (output.revision !== undefined && output.revision !== this.ctx.getSourceRevision()) {
        // Sources changed since this render was requested — drop the stale result.
        // Unlike the supersession case above, no newer call owns this spinner
        // flag, so we must clear it ourselves or it stays stuck (e.g. after
        // newFile(), which bumps the revision without dispatching a new render).
        this.ctx.mutate((s) => setRendering(s, false));
        return;
      }
      is2D = output.outFile.name.endsWith('.svg') || output.outFile.name.endsWith('.dxf');
      // Everything from the staleness checks above to the commit below is
      // synchronous (the viewer reads the OFF File directly and uses outFileURL
      // for SVG), so no newer render can land in between — no recheck needed.
      const outFileURL = this.ctx.host.createObjectURL(output.outFile);
      this.ctx.mutate((s) => {
        setRendering(s, false);
        s.error = undefined;
        s.errorDetails = undefined;
        s.is2D = is2D;
        s.lastCheckerRun = {
          logText: output.logText,
          markers: output.markers,
        };
        if (s.output?.outFileURL?.startsWith('blob:') ?? false) {
          this.ctx.host.revokeObjectURL(s.output!.outFileURL);
        }

        s.output = {
          isPreview: isPreview,
          outFile: output.outFile,
          outFileURL,
          elapsedMillis: output.elapsedMillis,
          formattedElapsedMillis: formatMillis(output.elapsedMillis),
          formattedOutFileSize: formatBytes(output.outFile.size),
          artifactId: newId(),
          operationId,
          sourceRevision: output.revision ?? this.ctx.getSourceRevision(),
        };

        if (!isPreview) {
          this.ctx.host.playCompletionChime();
        }
      });
    } catch (err) {
      if (!isCurrent()) return; // superseded — the newer call owns the spinner state
      this.ctx.mutate((s) => {
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
      for (const [, line] of this.ctx.getState().currentRunLogs ?? []) {
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
        this.ctx.mutate((s) => (s.is2D = !(is2D === false)));
        this.render({ isPreview, now: true, retryInOtherDim: false });
        return;
      }
    }
  }
}
