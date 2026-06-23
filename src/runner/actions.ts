// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import type { Diagnostic } from '../diagnostics.ts';
import {
  ProcessStreams,
  isExpectedJobCancellation,
  spawnOpenSCAD,
  type JobPriority,
} from './openscad-runner.ts';
import { processMergedOutputs } from './output-parser.ts';
import { AbortablePromise, turnIntoDelayableExecution } from '../utils.ts';
import type { WireSource } from '../state/project-source.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from '../state/formats.ts';
import { ParameterSet } from '../state/customizer-types.ts';
import { createOperationFailure } from '../user-facing-errors.ts';

const syntaxDelay = 300;

type SyntaxCheckArgs = {
  activePath: string;
  sources: WireSource[];
  revision?: number;
};
type SyntaxCheckOutput = {
  logText: string;
  markers: Diagnostic[];
  parameterSet?: ParameterSet;
  revision?: number;
};
export const checkSyntax = turnIntoDelayableExecution(syntaxDelay, (sargs: SyntaxCheckArgs) => {
  const { activePath, sources, revision } = sargs;

  const outFile = 'out.json';
  const job = spawnOpenSCAD(
    {
      mountArchives: true,
      inputs: sources,
      args: buildOpenScadArgs({ scadPath: activePath, outFile, exportFormat: 'param' }),
      outputPaths: [outFile],
      revision,
    },
    (_streams) => {},
    'syntax',
  );

  return AbortablePromise<SyntaxCheckOutput>((res, rej) => {
    (async () => {
      try {
        const result = await job;

        let parameterSet: ParameterSet | undefined = undefined;
        if (result.outputs && result.outputs.length == 1) {
          const [[, rawContent]] = result.outputs;
          const decoded = new TextDecoder().decode(rawContent);
          try {
            parameterSet = JSON.parse(decoded);
          } catch (e) {
            console.error(`Error while parsing parameter set: ${e}\n${decoded}`);
          }
        } else if (result.outputs && result.outputs.length > 1) {
          console.warn(
            `[syntax] Expected one parameter output file, got ${result.outputs.length}; ignoring.`,
          );
        }

        res({
          ...processMergedOutputs(result.mergedOutputs, {
            shiftSourceLines: {
              sourcePath: activePath,
              skipLines: 0,
            },
          }),
          parameterSet,
          revision: result.revision,
        });
      } catch (e) {
        if (!isExpectedJobCancellation(e)) {
          console.error(e);
        }
        rej(e);
      }
    })();
    return () => job.kill();
  });
});

const renderDelay = 1000;
export type RenderOutput = {
  outFile: File;
  logText: string;
  markers: Diagnostic[];
  elapsedMillis: number;
  revision?: number;
};

export type RenderArgs = {
  scadPath: string;
  sources: WireSource[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vars?: { [name: string]: any };
  features?: string[];
  extraArgs?: string[];
  isPreview: boolean;
  mountArchives: boolean;
  renderFormat: keyof typeof VALID_EXPORT_FORMATS_2D | keyof typeof VALID_EXPORT_FORMATS_3D;
  streamsCallback: (ps: ProcessStreams) => void;
  backend?: 'manifold' | 'cgal';
  revision?: number;
  /**
   * Host-side scheduling priority. Defaults to preview/render by `isPreview`;
   * export passes `'export'` so it preempts background work and is not preempted
   * by it. (See the separate `renderExport` delayable below.)
   */
  priority?: JobPriority;
};

/** Maximum array-nesting depth accepted for a customizer value. */
const MAX_VALUE_DEPTH = 16;

/**
 * Render an OpenSCAD customizer value into a `-D` literal. Only the value shapes
 * OpenSCAD parameters can hold are accepted — string, finite number, boolean, and
 * (bounded) nested arrays of those. Anything else (NaN/Infinity, objects,
 * functions, null/undefined, over-deep arrays) throws, so malformed values surface
 * as a clear error instead of producing garbage like `-Dx=[object Object]`.
 */
export function formatValue(value: unknown): string {
  return formatValueAtDepth(value, 0);
}

function formatValueAtDepth(value: unknown, depth: number): string {
  if (depth > MAX_VALUE_DEPTH) {
    throw new Error('array nesting is too deep');
  }
  if (typeof value === 'string') {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number (${value})`);
    return `${value}`;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatValueAtDepth(v, depth + 1)).join(', ')}]`;
  }
  throw new Error(`unsupported value type (${value === null ? 'null' : typeof value})`);
}
export interface OpenScadArgsRequest {
  /** Entry-point .scad path passed positionally to OpenSCAD. */
  scadPath: string;
  /** Output file path (`-o`). */
  outFile: string;
  /** `--export-format` value (e.g. `param`, `off`, `binstl`, `svg`). */
  exportFormat: string;
  /** Compute backend; omit for syntax/parameter passes that don't render geometry. */
  backend?: 'manifold' | 'cgal';
  /** Customizer variable overrides, emitted as `-D` literals. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vars?: { [name: string]: any };
  /** Experimental feature flags, emitted as `--enable=`. */
  features?: string[];
  /** Extra raw args appended verbatim. */
  extraArgs?: string[];
}

/**
 * Single source of truth for OpenSCAD command-line arguments. Every compile path
 * (syntax check, preview, render, export) builds its args here so flag handling
 * and `-D`/feature-flag formatting stay consistent and individually testable.
 */
export function buildOpenScadArgs(request: OpenScadArgsRequest): string[] {
  const args = [request.scadPath, '-o', request.outFile];
  if (request.backend) args.push(`--backend=${request.backend}`);
  args.push(`--export-format=${request.exportFormat}`);
  for (const [k, v] of Object.entries(request.vars ?? {})) {
    try {
      args.push(`-D${k}=${formatValue(v)}`);
    } catch (e) {
      throw new Error(`Invalid value for parameter "${k}": ${(e as Error).message}`);
    }
  }
  for (const f of request.features ?? []) args.push(`--enable=${f}`);
  args.push(...(request.extraArgs ?? []));
  return args;
}

const renderJob = (renderArgs: RenderArgs) => {
  const {
    scadPath,
    sources,
    isPreview,
    mountArchives,
    vars,
    features,
    extraArgs,
    renderFormat,
    streamsCallback,
    backend,
    revision,
    priority,
  } = renderArgs;

  const prefixLines: string[] = [];
  if (isPreview) {
    // TODO: add render-modifiers feature to OpenSCAD.
    prefixLines.push('$preview=true;');
  }
  if (!scadPath.endsWith('.scad'))
    throw new Error('First source must be a .scad file, got ' + sources[0].path + ' instead');

  const source = sources.filter((s) => s.path === scadPath)[0];
  if (!source) throw new Error('Active path not found in sources!');

  if (source.content == null) throw new Error('Source content is null!');
  const content = [...prefixLines, source.content].join('\n');

  const actualRenderFormat = renderFormat == 'glb' || renderFormat == '3mf' ? 'off' : renderFormat;
  const stem = scadPath
    .replace(/\.scad$/, '')
    .split('/')
    .pop();
  const outFile = `${stem}.${actualRenderFormat}`;
  const args = buildOpenScadArgs({
    scadPath,
    outFile,
    exportFormat: actualRenderFormat == 'stl' ? 'binstl' : actualRenderFormat,
    backend: backend ?? 'manifold',
    vars,
    features,
    extraArgs,
  });

  const job = spawnOpenSCAD(
    {
      mountArchives: mountArchives,
      inputs: sources.map((s) => (s.path === scadPath ? { path: s.path, content } : s)),
      args,
      outputPaths: [outFile],
      revision,
    },
    streamsCallback,
    priority ?? (isPreview ? 'preview' : 'render'),
  );

  return AbortablePromise<RenderOutput>((resolve, reject) => {
    (async () => {
      try {
        const result = await job;
        // console.log(result);

        const { logText, markers } = processMergedOutputs(result.mergedOutputs, {
          shiftSourceLines: {
            sourcePath: source.path,
            skipLines: prefixLines.length,
          },
        });

        if (result.error) {
          reject(
            createOperationFailure(isPreview ? 'preview' : 'render', result.error, {
              markers,
              logText,
            }),
          );
          return;
        }

        const [output] = result.outputs ?? [];
        if (!output) {
          reject(
            createOperationFailure(isPreview ? 'preview' : 'render', 'No output from runner!', {
              markers,
              logText,
            }),
          );
          return;
        }
        const [filePath, content] = output;
        const filePathFragments = filePath.split('/');
        const fileName = filePathFragments[filePathFragments.length - 1];

        // TODO: have the runner accept and return files.
        const type = filePath.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blob = new Blob([content as any]);
        const outFile = new File([blob], fileName, { type });
        resolve({
          outFile,
          logText,
          markers,
          elapsedMillis: result.elapsedMillis,
          revision: result.revision,
        });
      } catch (e) {
        if (!isExpectedJobCancellation(e)) {
          console.error(e);
        }
        reject(e);
      }
    })();

    return () => job.kill();
  });
};

// Preview and full render share one delayable instance: they debounce and
// supersede each other (only one geometry compile should be live at a time).
export const render = turnIntoDelayableExecution(renderDelay, renderJob);

// Export gets its OWN delayable instance so it does not share the supersession
// signal with preview/render — an auto-preview must not cancel an in-flight
// export, nor an export an in-flight preview. Callers pass `priority: 'export'`
// for host-side scheduling precedence.
export const renderExport = turnIntoDelayableExecution(renderDelay, renderJob);
