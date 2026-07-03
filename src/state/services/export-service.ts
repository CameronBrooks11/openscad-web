import chroma from 'chroma-js';

import { export3MF } from '../../io/export_3mf.ts';
import { parseOff } from '../../io/import_off.ts';
import { createRenderExportDelayable, type RenderOutput } from '../../runner/actions.ts';
import {
  formatOfName,
  mediaTypeForFormat,
  newId,
  operationCancelled,
  operationFailure,
  operationSuccess,
  OPERATION_FAILED,
  type OperationBase,
  type OperationResult,
} from '../../runner/compile-contract.ts';
import { isExpectedJobCancellation, type ProcessStreams } from '../../runner/openscad-runner.ts';
import { isUserFacingOperationError, normalizeOperationFailure } from '../../user-facing-errors.ts';
import { formatBytes, formatMillis, type AbortablePromise } from '../../utils.ts';
import { applyUserFacingError } from '../apply-user-facing-error.ts';
import type { ExportFormat } from '../formats.ts';
import type { ServiceContext } from './service-context.ts';

/**
 * Owns export orchestration: pass-through of an already-rendered file, the 3MF
 * color/extruder conversion, format conversion via a fresh render, and the
 * browser download. It reads state and writes results through the shared
 * ServiceContext; it never touches the DOM directly (downloads/object URLs go
 * through the host adapter).
 */
export class ExportService {
  constructor(private ctx: ServiceContext) {
    // Built here reading the `ctx` PARAMETER (always bound), not a field
    // initializer reading `this.ctx` — unconditionally correct regardless of
    // `useDefineForClassFields` ordering.
    this._renderExport = createRenderExportDelayable(ctx.backend);
  }

  // Identifies the latest export. A superseded export (e.g. a second click, or
  // the 3MF path which does not run through the delayable) must not clobber the
  // newer one's result/download when its async work finally settles.
  private _exportSeq = 0;

  // This service's own export render scheduler (per session, ADR 0007), bound to
  // this session's engine and kept distinct from the coordinator's render
  // delayable so an auto-preview never cancels an in-flight export.
  private readonly _renderExport: ReturnType<typeof createRenderExportDelayable>;

  // The in-flight format-conversion render job, if any. The export-token logic
  // stops a superseded export from committing a stale result, but the branches
  // that supersede WITHOUT calling renderExport (pass-through, 3MF picker, GLB,
  // 3MF) never trigger the delayable's own cancellation. Owning the handle lets
  // every export cancel the previous render at entry: this drops it if still
  // queued and settles the superseded export's promise immediately rather than
  // leaving it to be dropped by token later. A render already executing in the
  // worker can't be interrupted (its synchronous callMain runs to completion and
  // the host discards the result by id), but it no longer holds up the new
  // export's state. See #122.
  private _activeRender: AbortablePromise<RenderOutput> | null = null;

  private rawStreamsCallback(ps: ProcessStreams) {
    this.ctx.mutate((s) => {
      if ('stdout' in ps) {
        s.currentRunLogs?.push(['stdout', ps.stdout]);
      } else {
        s.currentRunLogs?.push(['stderr', ps.stderr]);
      }
    });
  }

  /** Cancel an in-flight export (best-effort, #123). The killed job rejects
   *  with an expected cancellation, so the existing catch emits one terminal
   *  `cancelled` result and clears the exporting spinner. The mark also covers
   *  the pre-spawn window (reading the conversion input is async): an export
   *  cancelled before its job exists checks the mark after the read.
   *
   *  With `requestId` (#226) only the export started by the command carrying
   *  that id is cancelled — a mismatching id no-ops (that export is already
   *  superseded or was never ours to kill). */
  cancel(requestId?: string): void {
    if (requestId !== undefined && requestId !== this._latestRequestId) return;
    this._cancelledToken = this._exportSeq;
    this._activeRender?.kill();
  }

  /** The export token cancel() was called against (-1 = none) — lets an export
   *  that has not yet spawned its job observe the cancellation. */
  private _cancelledToken = -1;
  /** The correlation id of the LATEST export invocation (undefined when it
   *  carried none) — the target a `cancel { requestId }` must match (#226). */
  private _latestRequestId: string | undefined;

  /** Route a terminal result to the optional sink, guarding the commit path: a
   *  throwing sink must never corrupt committed state or double-emit (ADR 0008).
   *  No-op when no sink is wired. */
  private emitResult(result: OperationResult) {
    try {
      this.ctx.onOperationResult?.(result);
    } catch (err) {
      console.error('onOperationResult sink threw:', err);
    }
  }

  /**
   * Export the current output. With no argument (the app's export button) the
   * target format comes from the persisted `exportFormat2D/3D` settings; a wire
   * host passes `requested` explicitly (#216) so a per-request format never
   * mutates persistent state (which would silently flip subsequent 2D previews'
   * render format — and via the pass-through, could even mislabel the result).
   */
  async export(requested?: ExportFormat, requestId?: string) {
    const { mutate, host } = this.ctx;
    // Claim the export token at entry — before any early return — so that EVERY
    // export (pass-through, picker, or async conversion) supersedes an in-flight
    // one. Each terminal path below checks ownership and explicitly settles the
    // `exporting` spinner so a superseded export can neither commit a stale
    // result nor leave the spinner stuck.
    const token = ++this._exportSeq;
    this._latestRequestId = requestId;
    const isCurrent = () => this._exportSeq === token;
    const operationId = newId(); // one per export() invocation (ADR 0008)
    // The status-independent fields for this export's single terminal result. The
    // revision is captured at submit time so a cancelled result echoes the
    // revision the op was submitted at; emits route through emitResult so a
    // throwing sink cannot disturb the byte-identical commit (ADR 0008).
    const submittedRevision = this.ctx.getSourceRevision();
    const base = (over: Partial<OperationBase> = {}): OperationBase => ({
      sessionId: this.ctx.sessionId,
      operationId,
      sourceRevision: submittedRevision,
      kind: 'export',
      elapsedMillis: 0,
      diagnostics: [],
      logText: '',
      // Echo the initiating command's correlation id on EVERY terminal of this
      // op — success, failure, cancelled, pass-through, picker (#223).
      ...(requestId !== undefined ? { requestId } : {}),
      ...over,
    });
    // Cancel any in-flight conversion render so a superseding export — including
    // a pass-through or picker branch that never calls renderExport — drops a
    // still-queued render and promptly settles the previous export's await with a
    // cancellation it treats as supersession (#122). A render already executing
    // in the worker still finishes there; its result is discarded by id.
    this._activeRender?.kill();
    this._activeRender = null;
    // Snapshot is safe: export never mutates output/params/is2D, only the
    // export/exporting/error/log/view fields it writes via the mutate callback.
    const state = this.ctx.getState();
    const targetFormat: ExportFormat =
      requested ?? (state.is2D ? state.params.exportFormat2D : state.params.exportFormat3D);
    if (state.output) {
      // The rendered output is ALREADY in the target format (the SVG/DXF of a 2D
      // preview, the OFF of a 3D one), so download it directly. Keyed on the
      // output file's ACTUAL format, not a format setting — a setting can point
      // at a format the current output is not (review of #216, mislabeling).
      const normalPassThrough = formatOfName(state.output.outFile.name) === targetFormat;

      if (normalPassThrough) {
        // Synchronous, so this export stays current through commit. Clear
        // `exporting` to take ownership from any async export it just superseded.
        const passThrough = state.output;
        mutate((s) => {
          s.exporting = false;
          s.export = s.output;
        });
        host.download(passThrough.outFileURL, passThrough.outFile.name);
        // Inherits the render's immutable artifact identity (same bytes, ADR 0008);
        // the result is keyed to THIS export op.
        const passFormat = formatOfName(passThrough.outFile.name);
        this.emitResult(
          operationSuccess(base(), {
            artifactId: passThrough.artifactId,
            operationId: passThrough.operationId,
            sourceRevision: passThrough.sourceRevision,
            format: passFormat,
            mediaType: mediaTypeForFormat(passFormat),
            size: passThrough.outFile.size,
            name: passThrough.outFile.name,
          }),
        );
        return;
      }
    }
    if (!state.is2D && targetFormat == '3mf' && !state.params.extruderColors) {
      if (!state.params.skipMultimaterialPrompt) {
        // Showing the picker ends this export request; take spinner ownership.
        mutate((s) => {
          s.exporting = false;
          s.view.extruderPickerVisibility = 'exporting';
        });
        // No artifact produced — the real export is a second export() once the
        // user picks colors; this minted op terminates as cancelled (ADR 0008).
        this.emitResult(operationCancelled(base()));
        return;
      }
    }
    mutate((s) => {
      s.currentRunLogs ??= [];
      s.exporting = true;
      s.error = undefined;
      s.errorDetails = undefined;
    });

    try {
      if (!state.output?.outFile || !state.output?.outFileURL) {
        throw new Error('No output file to export');
      }

      const { features } = state.params;
      const exportFormat = targetFormat;
      let output: RenderOutput;
      if (exportFormat === '3mf') {
        const start = performance.now();
        const data = parseOff(await state.output.outFile.text());
        const exportedData = export3MF(
          data,
          state.params.extruderColors?.map((c) => chroma(c)),
        );
        const elapsedMillis = performance.now() - start;
        output = {
          outFile: new File([exportedData], state.output.outFile.name.replace('.off', '.3mf')),
          elapsedMillis,
          logText: '',
          markers: [],
        };
      } else if (exportFormat === 'glb') {
        // GLB is produced in-browser from the rendered OFF (OpenSCAD's WASM build
        // has no glTF writer). Three.js is heavy, so load the converter lazily.
        const start = performance.now();
        const data = parseOff(await state.output.outFile.text());
        const { exportGLB } = await import('../../io/export_glb.ts');
        const glb = await exportGLB(data);
        const elapsedMillis = performance.now() - start;
        output = {
          outFile: new File([glb], state.output.outFile.name.replace(/\.off$/, '.glb')),
          elapsedMillis,
          logText: '',
          markers: [],
        };
      } else {
        // Ship the rendered output's CONTENT, not its blob URL: the worker's
        // external-source policy requires a blob URL's origin to match the base
        // origin, which holds on a normal page but not in a VS Code webview
        // (blob URLs mint under the webview's own opaque origin while the asset
        // base is the vscode-resource origin) — the fetch was rejected outright
        // and every conversion export failed there. The output is OFF/SVG text,
        // so the plain content source works everywhere.
        const inputName = state.output.outFile.name;
        const inputText = await state.output.outFile.text();
        if (!isCurrent()) {
          // Superseded during the read: the newer export owns the spinner.
          this.emitResult(operationCancelled(base()));
          return;
        }
        if (this._cancelledToken === token) {
          // cancel() landed during the read, before any job existed: still
          // current, so clear our own spinner (nothing newer owns it).
          mutate((s) => {
            s.exporting = false;
          });
          this.emitResult(operationCancelled(base()));
          return;
        }
        const job = this._renderExport({
          mountArchives: false,
          scadPath: '/export.scad',
          sources: [
            {
              path: '/export.scad',
              content: `import("${inputName}");`,
            },
            {
              path: inputName,
              content: inputText,
            },
          ],
          extraArgs: [],
          isPreview: false,
          features,
          renderFormat: exportFormat,
          priority: 'export',
          streamsCallback: this.rawStreamsCallback.bind(this),
        })({ now: true });
        // Own the handle so a later export can kill this render if it supersedes
        // before the worker finishes.
        this._activeRender = job;
        try {
          output = await job;
        } finally {
          if (this._activeRender === job) this._activeRender = null;
        }
      }

      // A newer export superseded this one while its conversion ran; it owns the
      // exporting flag and will commit/download its own result. Drop this one.
      if (!isCurrent()) {
        this.emitResult(operationCancelled(base()));
        return;
      }

      const outFileURL = host.createObjectURL(output.outFile);
      // One immutable artifact id, shared by state.export and the store entry, so
      // getArtifact(artifactId) returns these exact exported bytes (ADR 0008).
      const artifactId = newId();
      // The ref carries the GEOMETRY's provenance — the revision of the output
      // this conversion consumed — matching the pass-through branch. Stamping the
      // current counter would claim a just-edited revision for old geometry.
      const sourceRevision = state.output.sourceRevision;
      const format = formatOfName(output.outFile.name);
      const artifactRef = {
        artifactId,
        operationId,
        sourceRevision,
        format,
        mediaType: mediaTypeForFormat(format),
        size: output.outFile.size,
        name: output.outFile.name,
      };
      this.ctx.artifacts.put(output.outFile, artifactRef);
      mutate((s) => {
        s.exporting = false;
        // A prior pass-through export ALIASES the live output's URL
        // (s.export = s.output); that URL is the viewer/download URL of the
        // LIVE output, so revoking it here would break it for everyone still
        // holding it (review of #216).
        if (
          (s.export?.outFileURL?.startsWith('blob:') ?? false) &&
          s.export!.outFileURL !== s.output?.outFileURL
        ) {
          host.revokeObjectURL(s.export!.outFileURL);
        }
        s.export = {
          outFile: output.outFile,
          outFileURL,
          elapsedMillis: output.elapsedMillis,
          formattedElapsedMillis: formatMillis(output.elapsedMillis),
          formattedOutFileSize: formatBytes(output.outFile.size),
          artifactId,
          operationId,
          sourceRevision,
        };
        host.download(s.export.outFileURL, output.outFile.name);
      });
      this.emitResult(operationSuccess(base({ elapsedMillis: output.elapsedMillis }), artifactRef));
    } catch (err) {
      // An expected cancellation is either supersession (a newer export, which
      // owns the spinner — leave it) or an explicit cancel() of THIS still-current
      // export (nothing newer owns the spinner, so we must clear it ourselves or
      // it stays stuck). Distinguish by ownership, then emit one cancelled result.
      if (isExpectedJobCancellation(err)) {
        if (isCurrent()) mutate((s) => (s.exporting = false));
        this.emitResult(operationCancelled(base()));
        return;
      }
      // A stale export that fails for any other reason must not clobber the
      // current export's spinner or surface its obsolete error.
      if (!isCurrent()) {
        this.emitResult(operationCancelled(base()));
        return;
      }
      mutate((s) => {
        s.exporting = false;
        if (!isUserFacingOperationError(err)) {
          console.error('Error while exporting:', err);
        }
        applyUserFacingError(s, err, 'export');
      });
      this.emitResult(
        operationFailure(
          base(),
          OPERATION_FAILED,
          normalizeOperationFailure(err, 'export').message,
        ),
      );
    }
  }
}
