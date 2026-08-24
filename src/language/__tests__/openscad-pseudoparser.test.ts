// T3 — openscad-pseudoparser symbol extraction tests
// All tests are pure string manipulation — no external dependencies.

import { parseOpenSCAD, stripComments } from '../openscad-pseudoparser.ts';

// ---------------------------------------------------------------------------
// stripComments helper
// ---------------------------------------------------------------------------

describe('stripComments', () => {
  it('removes single-line comments', () => {
    expect(stripComments('cube(1); // this is a comment')).toBe('cube(1); ');
  });

  it('removes block comments', () => {
    expect(stripComments('/* block */ cube(1);')).toBe(' cube(1);');
  });

  it('removes multi-line block comments', () => {
    const src = 'a = 1;\n/* multi\nline */\nb = 2;';
    expect(stripComments(src)).toBe('a = 1;\n\nb = 2;');
  });

  it('handles source with no comments unchanged', () => {
    expect(stripComments('cube(1);')).toBe('cube(1);');
  });

  it('returns promptly on a long unterminated block comment', () => {
    // Regression: the old /\/\*(.|[\s\S])*?\*\// alternation matched every
    // non-newline character two ways, so an unterminated /* backtracked
    // exponentially. Linear now — this completes in milliseconds.
    const src = `/* ${'a'.repeat(50_000)}`;
    const started = performance.now();
    expect(stripComments(src)).toBe(src);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// describe: module extraction
// ---------------------------------------------------------------------------

describe('openscad-pseudoparser — module extraction', () => {
  it('extracts a top-level module name', () => {
    const result = parseOpenSCAD('/test.scad', 'module myBox() { cube(1); }', false);
    expect(Object.keys(result.modules)).toContain('myBox');
  });

  it('extracts multiple modules from one file', () => {
    const src = `
      module boxA() { cube(1); }
      module boxB() { sphere(1); }
    `;
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(Object.keys(result.modules)).toContain('boxA');
    expect(Object.keys(result.modules)).toContain('boxB');
  });

  it('does not extract module names inside block comments', () => {
    const src = `
      /* module hiddenModule() { cube(1); } */
      module visibleModule() { cube(1); }
    `;
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(Object.keys(result.modules)).not.toContain('hiddenModule');
    expect(Object.keys(result.modules)).toContain('visibleModule');
  });

  it('does not extract module names inside line comments', () => {
    const src = `
      // module commentedOut() { }
      module realModule() { }
    `;
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(Object.keys(result.modules)).not.toContain('commentedOut');
    expect(Object.keys(result.modules)).toContain('realModule');
  });

  it('skips private modules (starting with _) when skipPrivates=true', () => {
    const src = 'module _internal() {} module public() {}';
    const withSkip = parseOpenSCAD('/test.scad', src, true);
    expect(Object.keys(withSkip.modules)).not.toContain('_internal');
    expect(Object.keys(withSkip.modules)).toContain('public');
  });

  it('includes private modules when skipPrivates=false', () => {
    const src = 'module _internal() {} module public() {}';
    const withoutSkip = parseOpenSCAD('/test.scad', src, false);
    expect(Object.keys(withoutSkip.modules)).toContain('_internal');
  });

  it('captures module parameter names', () => {
    const src = 'module box(w=10, h=5) { cube([w,h,h]); }';
    const result = parseOpenSCAD('/test.scad', src, false);
    const params = result.modules['box']?.params ?? [];
    const paramNames = params.map((p) => p.name);
    expect(paramNames).toContain('w');
    expect(paramNames).toContain('h');
  });

  it('records no params for an empty parameter list', () => {
    const result = parseOpenSCAD('/test.scad', 'module box() { cube(1); }', false);
    expect(result.modules['box']?.params).toEqual([]);
  });

  it('records no params for a whitespace-only parameter list', () => {
    const result = parseOpenSCAD('/test.scad', 'module box(   ) { cube(1); }', false);
    expect(result.modules['box']?.params).toEqual([]);
  });

  it('discards the whole list when one param is malformed', () => {
    const result = parseOpenSCAD('/test.scad', 'module box(w=10, , h=5) { cube(1); }', false);
    expect(result.modules['box']?.params).toEqual([]);
  });

  it('discards the whole list for a bracketed default value', () => {
    const result = parseOpenSCAD('/test.scad', 'module box(v=[1,2]) { cube(1); }', false);
    expect(result.modules['box']?.params).toEqual([]);
  });

  it('returns promptly on a long malformed parameter list', () => {
    // Regression: the old whole-list gate nested ambiguous quantifiers and
    // backtracked catastrophically when the list did not match.
    const src = `module box(${'a='.repeat(2_000)}) { cube(1); }`;
    const started = performance.now();
    parseOpenSCAD('/test.scad', src, false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// describe: function extraction
// ---------------------------------------------------------------------------

describe('openscad-pseudoparser — function extraction', () => {
  it('extracts a function definition', () => {
    const src = 'function square(x) = x * x;';
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(Object.keys(result.functions)).toContain('square');
  });

  it('does not mistake use/include paths for function names', () => {
    const src = `
      use <MCAD/shapes.scad>;
      function myFunc(x) = x + 1;
    `;
    const result = parseOpenSCAD('/test.scad', src, false);
    // Only 'myFunc' should be in functions
    expect(Object.keys(result.functions)).toEqual(['myFunc']);
  });
});

// ---------------------------------------------------------------------------
// describe: use/include extraction
// ---------------------------------------------------------------------------

describe('openscad-pseudoparser — use/include extraction', () => {
  it('extracts use <> paths', () => {
    const src = 'use <MCAD/shapes.scad>;';
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(result.uses).toContain('MCAD/shapes.scad');
  });

  it('extracts include <> paths', () => {
    const src = 'include <BOSL2/std.scad>;';
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(result.includes).toContain('BOSL2/std.scad');
  });

  it('handles paths with nested directory components', () => {
    const src = 'use <libs/sub/module.scad>;';
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(result.uses).toContain('libs/sub/module.scad');
  });

  it('does not extract use directives that are inside comments', () => {
    const src = `
      // use <commented.scad>;
      use <real.scad>;
    `;
    const result = parseOpenSCAD('/test.scad', src, false);
    expect(result.uses).not.toContain('commented.scad');
    expect(result.uses).toContain('real.scad');
  });

  it('populates path on module definitions', () => {
    const src = 'module testMod() {}';
    const result = parseOpenSCAD('/my/path.scad', src, false);
    expect(result.modules['testMod']?.path).toBe('/my/path.scad');
  });
});
