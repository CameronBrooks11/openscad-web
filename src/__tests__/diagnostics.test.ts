import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import {
  countDiagnostics,
  maxDiagnosticSeverity,
  hasErrorDiagnostic,
  type Diagnostic,
} from '../diagnostics.ts';
import { toMonacoMarkers } from '../language/diagnostic-markers.ts';

function diag(severity: Diagnostic['severity'], line = 1): Diagnostic {
  return {
    severity,
    message: `${severity} at ${line}`,
    startLineNumber: line,
    startColumn: 1,
    endLineNumber: line,
    endColumn: 10,
  };
}

describe('diagnostics helpers (#55)', () => {
  it('counts diagnostics by severity', () => {
    const counts = countDiagnostics([diag('error'), diag('error'), diag('warning'), diag('info')]);
    expect(counts).toEqual({ error: 2, warning: 1, info: 1 });
  });

  it('reports the most severe level present', () => {
    expect(maxDiagnosticSeverity([diag('info'), diag('warning')])).toBe('warning');
    expect(maxDiagnosticSeverity([diag('warning'), diag('error'), diag('info')])).toBe('error');
    expect(maxDiagnosticSeverity([])).toBeNull();
  });

  it('detects an error diagnostic', () => {
    expect(hasErrorDiagnostic([diag('warning'), diag('info')])).toBe(false);
    expect(hasErrorDiagnostic([diag('warning'), diag('error')])).toBe(true);
  });
});

describe('toMonacoMarkers adapter (#55)', () => {
  it('maps host-neutral severities to Monaco MarkerSeverity and preserves the range', () => {
    const markers = toMonacoMarkers([diag('error', 3), diag('warning', 5), diag('info', 7)]);

    expect(markers.map((m) => m.severity)).toEqual([
      monaco.MarkerSeverity.Error,
      monaco.MarkerSeverity.Warning,
      monaco.MarkerSeverity.Info,
    ]);
    expect(markers[0]).toMatchObject({
      message: 'error at 3',
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 10,
    });
  });

  it('round-trips the optional source field', () => {
    const [marker] = toMonacoMarkers([{ ...diag('warning'), source: 'openscad' }]);
    expect(marker.source).toBe('openscad');
  });
});
