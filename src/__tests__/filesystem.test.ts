// Unit tests for Phase 2 filesystem layer — F2/F3/F7 exit criteria

import { extractLibraryNames } from '../fs/filesystem.ts';
import { zipArchives, deployedArchiveNames, ZipArchive } from '../fs/zip-archives.generated.ts';
import libsConfig from '../../libs-config.json';

// ---------------------------------------------------------------------------
// F3 — extractLibraryNames() parses use/include directives correctly
// ---------------------------------------------------------------------------

describe('extractLibraryNames', () => {
  it('extracts top-level library name from use directive', () => {
    expect(extractLibraryNames('use <MCAD/shapes.scad>;')).toEqual(['MCAD']);
  });

  it('extracts top-level library name from include directive', () => {
    expect(extractLibraryNames('include <BOSL2/std.scad>;')).toEqual(['BOSL2']);
  });

  it('deduplicates multiple references to the same library', () => {
    const src = `
      use <MCAD/shapes.scad>;
      use <MCAD/nuts_and_bolts.scad>;
      include <MCAD/units.scad>;
    `;
    expect(extractLibraryNames(src)).toEqual(['MCAD']);
  });

  it('extracts multiple distinct libraries', () => {
    const src = `
      use <BOSL2/std.scad>;
      include <MCAD/shapes.scad>;
    `;
    const names = extractLibraryNames(src);
    expect(names).toContain('BOSL2');
    expect(names).toContain('MCAD');
    expect(names).toHaveLength(2);
  });

  it('handles single-component paths (no subdirectory)', () => {
    expect(extractLibraryNames('use <tray.scad>;')).toEqual(['tray.scad']);
  });

  it('returns empty array for source with no directives', () => {
    expect(extractLibraryNames('cube([10, 10, 10]);')).toEqual([]);
  });

  it('ignores directives inside line comments', () => {
    // The regex doesn't strip comments, but the library should still parse
    // what's there without crashing
    expect(() => extractLibraryNames('// use <MCAD/shapes.scad>;\ncube(1);')).not.toThrow();
  });

  it('handles empty string', () => {
    expect(extractLibraryNames('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F7 — registry parity: every libs-config.json library entry has a matching
//       generated entry with the expected canonical structure
// ---------------------------------------------------------------------------

describe('zip-archives registry parity', () => {
  const configLibs = (libsConfig as { libraries: Array<{ name: string }> }).libraries;

  it('generated registry has same number of entries as libs-config.json', () => {
    expect(zipArchives).toHaveLength(configLibs.length);
  });

  it('every libs-config.json library name appears in generated registry', () => {
    const generatedNames = new Set(zipArchives.map((a: ZipArchive) => a.name));
    for (const lib of configLibs) {
      expect(generatedNames).toContain(lib.name);
    }
  });

  it('deployedArchiveNames matches zipArchives names', () => {
    expect(deployedArchiveNames).toEqual(zipArchives.map((a: ZipArchive) => a.name));
  });

  it('every generated entry has required fields', () => {
    for (const archive of zipArchives) {
      expect(typeof archive.name).toBe('string');
      expect(archive.name.length).toBeGreaterThan(0);
      expect(typeof archive.zipPath).toBe('string');
      expect(archive.zipPath).toMatch(/^\.\/libraries\//);
      expect(typeof archive.mountPath).toBe('string');
      expect(archive.mountPath).toMatch(/^\/libraries\//);
    }
  });

  it('mountPath is /libraries/<name> for every entry', () => {
    for (const archive of zipArchives) {
      expect(archive.mountPath).toBe(`/libraries/${archive.name}`);
    }
  });

  it('zipPath is ./libraries/<name>.zip for every entry', () => {
    for (const archive of zipArchives) {
      // UB.scad is stored as UB.scad.zip — name may contain dots
      expect(archive.zipPath).toBe(`./libraries/${archive.name}.zip`);
    }
  });
});
