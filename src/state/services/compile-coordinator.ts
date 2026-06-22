import { checkSyntax, render, type RenderArgs } from '../../runner/actions.ts';
import { isExpectedJobCancellation, type ProcessStreams } from '../../runner/openscad-runner.ts';
import { isUserFacingOperationError } from '../../user-facing-errors.ts';
import { fetchSource, formatBytes, formatMillis } from '../../utils.ts';
import { applyUserFacingError } from '../apply-user-facing-error.ts';
import type { State } from '../app-state.ts';
import { is2DFormatExtension } from '../formats.ts';
import { contentOf } from '../project-source.ts';
import type { ServiceContext } from './service-context.ts';

/**
 * Owns the compile lifecycle: materializing the active source, syntax checking,
 * and preview/full rendering — including the supersession sequence guards, the
 * source-revision stale-drop, and the dimension-retry. It reads state and writes
 * results through the shared ServiceContext, and plays the completion chime via
 * the host adapter; it never touches the DOM directly.
 */
export class CompileCoordinator {
  constructor(private ctx: ServiceContext) {}

  // Sequence counters identifying the latest in-flight operation of each kind.
  // checkSyntax/render debounce and supersede one another (turnIntoDelayableExecution),
  // so a superseded call settles (rejects) while a newer one owns the shared UI
  // flags — these guards stop the stale call from clobbering the newer call's
  // previewing/rendering/checkingSyntax state.
  private _previewSeq = 0;
  private _renderSeq = 0;
  private _syntaxSeq = 0;

  async processSource({ immediatePreview = false }: { immediatePreview?: boolean } = {}) {
    const src = this.ctx
      .getState()
      .params.sources.find((src) => src.path === this.ctx.getState().params.activePath);
    // A source needs its content materialized when it is not yet inline text: an
    // unloaded remote (fetch its url) or an on-disk local file (read the fs).
    if (src && src.kind !== 'archive' && contentOf(src) == null) {
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
    if (this.ctx.getActiveSource().trim() !== '') {
      const shouldCheckSyntax = this.ctx.getState().params.activePath.endsWith('.scad');
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
      const checkerRun = await checkSyntax({
        activePath: this.ctx.getState().params.activePath,
        sources: this.ctx.getState().params.sources,
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

    const renderArgs: RenderArgs = {
      mountArchives,
      scadPath: activePath,
      sources,
      vars,
      features,
      isPreview,
      renderFormat: is2D ? this.ctx.getState().params.exportFormat2D : 'off',
      streamsCallback: this.rawStreamsCallback.bind(this),
      backend: this.ctx.getState().params.backend,
      revision: this.ctx.getSourceRevision(),
    };
    try {
      const output = await render(renderArgs)({ now });
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
