import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

import {
  createOperationFailure,
  formatExternalLoadError,
  normalizeOperationFailure,
} from '../user-facing-errors.ts';

describe('user-facing error helpers', () => {
  it('normalizes worker crash messages for render operations', () => {
    expect(normalizeOperationFailure(new Error('Worker crashed: boom'), 'render').message).toBe(
      'Render failed because the compile worker stopped responding. Try again.',
    );
  });

  it('normalizes OOM messages for export operations', () => {
    expect(normalizeOperationFailure(new Error('Out of memory'), 'export').message).toBe(
      'Export ran out of memory in the browser. Try simplifying the model.',
    );
  });

  it('maps model load HTTP failures to a user-readable message', () => {
    expect(formatExternalLoadError(new Error('HTTP 404 while fetching source.'), 'model')).toBe(
      'Failed to load the model file (HTTP 404).',
    );
  });

  it('turns parser markers into a syntax-focused operation failure', () => {
    const failure = createOperationFailure('preview', 'OpenSCAD invocation failed', {
      logText: 'ERROR: Parser error in file "/home/playground.scad", line 1: syntax error',
      markers: [
        {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 100,
          message: 'syntax error',
          severity: monaco.MarkerSeverity.Error,
        },
      ],
    });

    expect(failure.userFacingError.message).toBe(
      'OpenSCAD reported syntax errors. Review the highlighted lines and logs.',
    );
  });
});
