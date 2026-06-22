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

describe('parseMergedOutputs – diagnostics carry the source file path', () => {
  it('populates path from a parser-error line', () => {
    const markers = parseMergedOutputs(mockOutputs(3), {
      shiftSourceLines: { sourcePath: '/playground.scad', skipLines: 0 },
    });
    expect(markers[0].path).toBe('/playground.scad');
    expect(markers[0].severity).toBe('error');
  });

  it('populates path for a different (non-active) file so it can route there', () => {
    const markers = parseMergedOutputs(
      [
        {
          stderr: 'ERROR: Parser error in file "/home/lib.scad", line 7: bad token',
          stdout: undefined,
          error: undefined,
        },
      ],
      { shiftSourceLines: { sourcePath: '/home/main.scad', skipLines: 2 } },
    );
    // Not the active file, so the line is NOT shifted by skipLines.
    expect(markers[0].path).toBe('/home/lib.scad');
    expect(markers[0].startLineNumber).toBe(7);
  });

  it('populates path on warnings', () => {
    const markers = parseMergedOutputs(
      [
        {
          stderr: 'WARNING: Ignoring unknown variable, in file /home/main.scad, line 4',
          stdout: undefined,
          error: undefined,
        },
      ],
      { shiftSourceLines: { sourcePath: '/home/main.scad', skipLines: 0 } },
    );
    expect(markers[0].severity).toBe('warning');
    expect(markers[0].path).toBe('/home/main.scad');
  });
});
