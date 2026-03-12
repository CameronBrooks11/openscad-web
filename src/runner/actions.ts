// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { ProcessStreams, spawnOpenSCAD } from "./openscad-runner.ts";
import { processMergedOutputs } from "./output-parser.ts";
import { AbortablePromise, turnIntoDelayableExecution } from '../utils.ts';
import { Source } from '../state/app-state.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from '../state/formats.ts';
import { ParameterSet } from '../state/customizer-types.ts';

const syntaxDelay = 300;

type SyntaxCheckArgs = {
  activePath: string,
  sources: Source[],
}
type SyntaxCheckOutput = {logText: string, markers: monaco.editor.IMarkerData[], parameterSet?: ParameterSet};
export const checkSyntax =
  turnIntoDelayableExecution(syntaxDelay, (sargs: SyntaxCheckArgs) => {
    const {
      activePath,
      sources,
    } = sargs;

    const outFile = 'out.json';
    const job = spawnOpenSCAD({
      mountArchives: true,
      inputs: sources,
      args: [activePath, "-o", outFile, "--export-format=param"],
      outputPaths: [outFile],
    }, (_streams) => {}, 'syntax');

    return AbortablePromise<SyntaxCheckOutput>((res, rej) => {
      (async () => {
        try {
          const result = await job;

          let parameterSet: ParameterSet | undefined = undefined;
          if (result.outputs && result.outputs.length == 1) {
            const [[, rawContent]] = result.outputs;
            const decoded = new TextDecoder().decode(rawContent);
            try {
              parameterSet = JSON.parse(decoded)
            } catch (e) {
              console.error(`Error while parsing parameter set: ${e}\n${decoded}`);
            }
          } else {
            console.error('No output from runner!');
          }

          res({
            ...processMergedOutputs(result.mergedOutputs, {shiftSourceLines: {
              sourcePath: sources[0].path,
              skipLines: 0,
            }}),
            parameterSet,
          });
        } catch (e) {
          console.error(e);
          rej(e);
        }
      })()
      return () => job.kill();
    });
  });

const renderDelay = 1000;
export type RenderOutput = {
  outFile: File,
  logText: string,
  markers: monaco.editor.IMarkerData[],
  elapsedMillis: number}

export type RenderArgs = {
  scadPath: string,
  sources: Source[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vars?: {[name: string]: any},
  features?: string[],
  extraArgs?: string[],
  isPreview: boolean,
  mountArchives: boolean,
  renderFormat: keyof typeof VALID_EXPORT_FORMATS_2D | keyof typeof VALID_EXPORT_FORMATS_3D,
  streamsCallback: (ps: ProcessStreams) => void,
  backend?: 'manifold' | 'cgal',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatValue(value: any): string {
  if (typeof value === 'string') {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  } else if (value instanceof Array) {
    return `[${value.map(formatValue).join(', ')}]`;
  } else {
    return `${value}`;
  }
}
/**
 * Returns the fixed compile-time args shared by all render invocations.
 * Exported for testability — the feature-flag test (T5) asserts that
 * no non-default experimental flags (e.g. --enable=lazy-union) are present.
 */
export function getDefaultCompileArgs(): string[] {
  // The only constant arg is the backend selector. Feature flags (--enable=X) are
  // user-controlled and come from renderArgs.features[], NOT from a hard-coded list.
  return [`--backend=manifold`];
}

export const render =
 turnIntoDelayableExecution(renderDelay, (renderArgs: RenderArgs) => {
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
    }  = renderArgs;

    const prefixLines: string[] = [];
    if (isPreview) {
      // TODO: add render-modifiers feature to OpenSCAD.
      prefixLines.push('$preview=true;');
    }
    if (!scadPath.endsWith('.scad')) throw new Error('First source must be a .scad file, got ' + sources[0].path + ' instead');
    
    const source = sources.filter(s => s.path === scadPath)[0];
    if (!source) throw new Error('Active path not found in sources!');

    if (source.content == null) throw new Error('Source content is null!');
    const content = [...prefixLines, source.content].join('\n');

    const actualRenderFormat = renderFormat == 'glb' || renderFormat == '3mf' ? 'off' : renderFormat;
    const stem = scadPath.replace(/\.scad$/, '').split('/').pop();
    const outFile = `${stem}.${actualRenderFormat}`;
    const args = [
      scadPath,
      "-o", outFile,
      `--backend=${backend ?? 'manifold'}`,
      "--export-format=" + (actualRenderFormat == 'stl' ? 'binstl' : actualRenderFormat),
      ...(Object.entries(vars ?? {}).flatMap(([k, v]) => [`-D${k}=${formatValue(v)}`])),
      ...(features ?? []).map(f => `--enable=${f}`),
      ...(extraArgs ?? [])
    ]
    
    const job = spawnOpenSCAD({
      mountArchives: mountArchives,
      inputs: sources.map(s => s.path === scadPath ? {path: s.path, content} : s),
      args,
      outputPaths: [outFile],
    }, streamsCallback, isPreview ? 'preview' : 'render');

    return AbortablePromise<RenderOutput>((resolve, reject) => {
      (async () => {
        try {
          const result = await job;
          // console.log(result);

          const {logText, markers} = processMergedOutputs(result.mergedOutputs, {
            shiftSourceLines: {
              sourcePath: source.path,
              skipLines: prefixLines.length
            }
          });
    
          if (result.error) {
            reject(result.error);
          }
          
          const [output] = result.outputs ?? [];
          if (!output) {
            reject(new Error('No output from runner!'));
            return;
          }
          const [filePath, content] = output;
          const filePathFragments = filePath.split('/');
          const fileName = filePathFragments[filePathFragments.length - 1];

          // TODO: have the runner accept and return files.
          const type = filePath.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const blob = new Blob([content as any]);
          const outFile = new File([blob], fileName, {type});
          resolve({outFile, logText, markers, elapsedMillis: result.elapsedMillis});
        } catch (e) {
          console.error(e);
          reject(e);
        }
      })();

      return () => job.kill()
    });
  });

