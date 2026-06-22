// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import type { Diagnostic } from '../diagnostics.ts';
import { ParameterSet } from './customizer-types.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from './formats.ts';
import type { SerializableSource } from './project-source.ts';

export type MultiLayoutComponentId = 'editor' | 'viewer' | 'customizer';
export type SingleLayoutComponentId = MultiLayoutComponentId;

/**
 * The flat, untagged source shape used at the worker/runner boundary and in the
 * serialized fragment / state.json. In-memory project state uses the typed
 * `ProjectSource` union (see project-source.ts) and converts to this flat shape
 * at those boundaries.
 */
export type Source = {
  // If path ends w/ /, it's a directory, and URL should contain a ZIP file that can be mounted
  path: string;
  url?: string;
  content?: string;
};

export interface FileOutput {
  outFile: File;
  outFileURL: string;
  elapsedMillis: number;
  formattedElapsedMillis: string;
  formattedOutFileSize: string;
}

export interface State {
  params: {
    activePath: string;
    sources: SerializableSource[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vars?: { [name: string]: any };
    features: string[];
    exportFormat2D: keyof typeof VALID_EXPORT_FORMATS_2D;
    exportFormat3D: keyof typeof VALID_EXPORT_FORMATS_3D;
    extruderColors?: string[];
    backend?: 'manifold' | 'cgal';
    /** When false, source changes do not trigger automatic render/checkSyntax. */
    autoCompile?: boolean;
    /** When true, the multimaterial color prompt is skipped for this session. */
    skipMultimaterialPrompt?: boolean;
  };

  preview?: {
    thumbhash?: string;
    blurhash?: string;
  };

  view: {
    logs?: boolean;
    extruderPickerVisibility?: 'editing' | 'exporting';
    layout:
      | {
          mode: 'single';
          focus: SingleLayoutComponentId;
        }
      | ({
          mode: 'multi';
        } & { [K in MultiLayoutComponentId]: boolean });

    collapsedCustomizerTabs?: string[];
    /** When true, all customizer groups start collapsed. */
    customizerGroupsCollapsed?: boolean;
    /** Persisted Three.js camera position / target / zoom. */
    camera?: CameraState;

    color: string;
    showAxes?: boolean;
    lineNumbers?: boolean;
  };

  currentRunLogs?: ['stderr' | 'stdout', string][];

  lastCheckerRun?: {
    logText: string;
    markers: Diagnostic[];
  };
  rendering?: boolean;
  previewing?: boolean;
  exporting?: boolean;
  checkingSyntax?: boolean;

  parameterSet?: ParameterSet;
  error?: string;
  errorDetails?: string;
  is2D?: boolean;
  output?: FileOutput & {
    isPreview: boolean;
  };
  export?: FileOutput;
}

export interface StatePersister {
  set(state: State): Promise<void>;
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

export {};
