import chroma from 'chroma-js';

import { export3MF } from '../../io/export_3mf.ts';
import { parseOff } from '../../io/import_off.ts';
import { createRenderExportDelayable, type RenderOutput } from '../../runner/actions.ts';
import { isExpectedJobCancellation, type ProcessStreams } from '../../runner/openscad-runner.ts';
import { isUserFacingOperationError } from '../../user-facing-errors.ts';
import { formatBytes, formatMillis, type AbortablePromise } from '../../utils.ts';
import { applyUserFacingError } from '../apply-user-facing-error.ts';
import type { ServiceContext } from './service-context.ts';

/**
 * Owns export orchestration: pass-through of an already-rendered file, the 3MF
 * color/extruder conversion, format conversion via a fresh render, and the
 * browser download. It reads state and writes results through the shared
 * ServiceContext; it never touches the DOM directly (downloads/object URLs go
 * through the host adapter).
 */
export class ExportService {
  constructor(private ctx: ServiceContext) {}

  // Identifies the latest export. A superseded export (e.g. a second click, or
  // the 3MF path which does not run through the delayable) must not clobber the
  // newer one's result/download when its async work finally settles.
  private _exportSeq = 0;

  // This service's own export render scheduler (per session, ADR 0007), kept
  // distinct from the coordinator's render delayable so an auto-preview never
  // cancels an in-flight export.
  private readonly _renderExport = createRenderExportDelayable();

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

  async export() {
    const { mutate, host } = this.ctx;
    // Claim the export token at entry — before any early return — so that EVERY
    // export (pass-through, picker, or async conversion) supersedes an in-flight
    // one. Each terminal path below checks ownership and explicitly settles the
    // `exporting` spinner so a superseded export can neither commit a stale
    // result nor leave the spinner stuck.
    const token = ++this._exportSeq;
    const isCurrent = () => this._exportSeq === token;
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
    if (state.output) {
      // The preview/render output is already in the target format (the SVG for a
      // 2D model, the OFF for a 3D `off` export), so download it directly.
      const normalPassThrough =
        (state.is2D && state.params.exportFormat2D === 'svg') ||
        (!state.is2D && state.params.exportFormat3D === 'off');

      if (normalPassThrough) {
        // Synchronous, so this export stays current through commit. Clear
        // `exporting` to take ownership from any async export it just superseded.
        mutate((s) => {
          s.exporting = false;
          s.export = s.output;
        });
        host.download(state.output.outFileURL, state.output.outFile.name);
        return;
      }
    }
    if (!state.is2D && state.params.exportFormat3D == '3mf' && !state.params.extruderColors) {
      if (!state.params.skipMultimaterialPrompt) {
        // Showing the picker ends this export request; take spinner ownership.
        mutate((s) => {
          s.exporting = false;
          s.view.extruderPickerVisibility = 'exporting';
        });
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

      const { features, exportFormat2D, exportFormat3D } = state.params;
      const exportFormat = state.is2D ? exportFormat2D : exportFormat3D;
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
        const job = this._renderExport({
          mountArchives: false,
          scadPath: '/export.scad',
          sources: [
            {
              path: '/export.scad',
              content: `import("${state.output?.outFile.name}");`,
            },
            {
              path: state.output?.outFile.name,
              url: state.output?.outFileURL,
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
      if (!isCurrent()) return;

      const outFileURL = host.createObjectURL(output.outFile);
      mutate((s) => {
        s.exporting = false;
        if (s.export?.outFileURL?.startsWith('blob:') ?? false) {
          host.revokeObjectURL(s.export!.outFileURL);
        }
        s.export = {
          outFile: output.outFile,
          outFileURL,
          elapsedMillis: output.elapsedMillis,
          formattedElapsedMillis: formatMillis(output.elapsedMillis),
          formattedOutFileSize: formatBytes(output.outFile.size),
        };
        host.download(s.export.outFileURL, output.outFile.name);
      });
    } catch (err) {
      // A superseded export rejects with the delayable's cancellation; that is
      // expected supersession, not a failure — the newer export owns the spinner.
      if (isExpectedJobCancellation(err)) return;
      // A stale export that fails for any other reason must not clobber the
      // current export's spinner or surface its obsolete error.
      if (!isCurrent()) return;
      mutate((s) => {
        s.exporting = false;
        if (!isUserFacingOperationError(err)) {
          console.error('Error while exporting:', err);
        }
        applyUserFacingError(s, err, 'export');
      });
    }
  }
}
