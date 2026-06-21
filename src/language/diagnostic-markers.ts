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
