// Adapter from host-neutral Diagnostics to Monaco editor markers. This is the
// only place the editor's marker representation meets the core diagnostics, so
// Monaco stays out of domain and runner code.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { Diagnostic, DiagnosticSeverity } from '../diagnostics.ts';

const MONACO_SEVERITY: Record<DiagnosticSeverity, monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
};

export function toMonacoMarkers(diagnostics: Diagnostic[]): monaco.editor.IMarkerData[] {
  return diagnostics.map((d) => ({
    severity: MONACO_SEVERITY[d.severity],
    message: d.message,
    startLineNumber: d.startLineNumber,
    startColumn: d.startColumn,
    endLineNumber: d.endLineNumber,
    endColumn: d.endColumn,
    source: d.source,
  }));
}

/**
 * Group diagnostics into Monaco markers keyed by their file path, preserving
 * order within each file. The `undefined` key holds diagnostics with no path
 * (the host applies those to the active model). Lets a multi-file project show
 * each file's markers on its own editor model instead of all on the active one.
 */
export function groupMarkersByPath(
  diagnostics: Diagnostic[],
): Map<string | undefined, monaco.editor.IMarkerData[]> {
  const groups = new Map<string | undefined, monaco.editor.IMarkerData[]>();
  for (const d of diagnostics) {
    const [marker] = toMonacoMarkers([d]);
    const list = groups.get(d.path);
    if (list) list.push(marker);
    else groups.set(d.path, [marker]);
  }
  return groups;
}
