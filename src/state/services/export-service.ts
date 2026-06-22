import chroma from 'chroma-js';

import { export3MF } from '../../io/export_3mf.ts';
import { parseOff } from '../../io/import_off.ts';
import { renderExport, type RenderOutput } from '../../runner/actions.ts';
import { isExpectedJobCancellation, type ProcessStreams } from '../../runner/openscad-runner.ts';
import { isUserFacingOperationError } from '../../user-facing-errors.ts';
import { formatBytes, formatMillis } from '../../utils.ts';
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
        mutate((s) => (s.export = s.output));
        host.download(state.output.outFileURL, state.output.outFile.name);
        return;
      }
    }
    if (!state.is2D && state.params.exportFormat3D == '3mf' && !state.params.extruderColors) {
      if (!state.params.skipMultimaterialPrompt) {
        mutate((_s) => (state.view.extruderPickerVisibility = 'exporting'));
        return;
      }
    }
    const token = ++this._exportSeq;
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
        output = await renderExport({
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
      }

      // A newer export superseded this one while its conversion ran; it owns the
      // exporting flag and will commit/download its own result. Drop this one.
      if (this._exportSeq !== token) return;

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
