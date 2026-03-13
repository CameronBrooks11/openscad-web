// Tests for BUG-3 — checkSyntax passes original sources but uses skipLines:1
// We test output-parser directly (no need to spawn OpenSCAD).

import { parseMergedOutputs } from '../runner/output-parser.ts';

const mockOutputs = (line: number) => [
  {
    stderr: `ERROR: Parser error in file "/playground.scad", line ${line}: some error`,
    stdout: undefined,
    error: undefined,
  },
];

describe('parseMergedOutputs – skipLines shifts marker line numbers (BUG-3)', () => {
  it('skipLines: 0 returns marker at the actual source line', () => {
    const markers = parseMergedOutputs(mockOutputs(5), {
      shiftSourceLines: { sourcePath: '/playground.scad', skipLines: 0 },
    });
    expect(markers[0].startLineNumber).toBe(5);
  });

  it('skipLines: 1 incorrectly shifts line numbers by -1', () => {
    // BUG: checkSyntax sends original sources (no prefix) but uses skipLines:1
    // This makes all errors appear one line above the actual location
    const markers = parseMergedOutputs(mockOutputs(5), {
      shiftSourceLines: { sourcePath: '/playground.scad', skipLines: 1 },
    });
    // With skipLines:1, the marker is incorrectly shifted to line 4
    expect(markers[0].startLineNumber).toBe(4);
  });
});
