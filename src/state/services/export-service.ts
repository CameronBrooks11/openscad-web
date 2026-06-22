import chroma from 'chroma-js';

import { export3MF } from '../../io/export_3mf.ts';
import { parseOff } from '../../io/import_off.ts';
import { render, type RenderOutput } from '../../runner/actions.ts';
import type { ProcessStreams } from '../../runner/openscad-runner.ts';
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
      const normalPassThrough =
        (state.is2D && state.params.exportFormat2D === 'svg') ||
        (!state.is2D && state.params.exportFormat3D === 'off');

      const glbPassThrough =
        !state.is2D &&
        state.params.exportFormat3D === 'glb' &&
        (state.output.displayFile?.name.endsWith('.glb') ?? false) &&
        state.output.displayFileURL != null;

      if (normalPassThrough || glbPassThrough) {
        mutate((s) => (s.export = s.output));
        if (glbPassThrough) {
          host.download(state.output.displayFileURL!, state.output.displayFile!.name);
        } else {
          host.download(state.output.outFileURL, state.output.outFile.name);
        }
        return;
      }
    }
    if (!state.is2D && state.params.exportFormat3D == '3mf' && !state.params.extruderColors) {
      if (!state.params.skipMultimaterialPrompt) {
        mutate((_s) => (state.view.extruderPickerVisibility = 'exporting'));
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
      } else {
        output = await render({
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
          streamsCallback: this.rawStreamsCallback.bind(this),
        })({ now: true });
      }

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
