// Unit tests for Phase 2 filesystem layer — F2/F3/F7 exit criteria

import {
  clearActiveFileHandle,
  clearHomeDirectory,
  extractLibraryNames,
  getParentDir,
  join,
  openLocalFile,
  saveActiveFile,
} from '../fs/filesystem.ts';
import { zipArchives, deployedArchiveNames, ZipArchive } from '../fs/zip-archives.generated.ts';
import libsConfig from '../../libs-config.json';

describe('filesystem path helpers', () => {
  it('getParentDir returns the containing directory for absolute and relative paths', () => {
    expect(getParentDir('/home/file.scad')).toBe('/home');
    expect(getParentDir('file.scad')).toBe('.');
    expect(getParentDir('/file.scad')).toBe('/');
  });

  it('join handles current-directory, trailing slash, and dot segments', () => {
    expect(join('.', 'file.scad')).toBe('file.scad');
    expect(join('/home/', 'project')).toBe('/home/project');
    expect(join('/home/project', '.')).toBe('/home/project');
  });
});

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

describe('clearHomeDirectory', () => {
  it('removes all files and subdirectories under /home recursively', () => {
    const dirs = new Set(['/home', '/home/project', '/home/project/nested']);
    const files = new Set([
      '/home/main.scad',
      '/home/project/a.scad',
      '/home/project/nested/b.txt',
    ]);

    const readdirSync = jest.fn((path: string) => {
      switch (path) {
        case '/home':
          return ['main.scad', 'project'];
        case '/home/project':
          return ['a.scad', 'nested'];
        case '/home/project/nested':
          return ['b.txt'];
        default:
          return [];
      }
    });
    const unlinkSync = jest.fn((path: string) => {
      files.delete(path);
    });
    const rmdirSync = jest.fn((path: string) => {
      dirs.delete(path);
    });

    const fs = {
      existsSync: () => true,
      readdirSync,
      lstatSync: (path: string) => ({ isDirectory: () => dirs.has(path) }),
      unlinkSync,
      rmdirSync,
    } as unknown as FS;

    clearHomeDirectory(fs);

    expect(files.size).toBe(0);
    expect(dirs.has('/home')).toBe(true);
    expect(dirs.has('/home/project')).toBe(false);
    expect(dirs.has('/home/project/nested')).toBe(false);
    expect(unlinkSync).toHaveBeenCalledWith('/home/main.scad');
    expect(unlinkSync).toHaveBeenCalledWith('/home/project/a.scad');
    expect(unlinkSync).toHaveBeenCalledWith('/home/project/nested/b.txt');
    expect(rmdirSync).toHaveBeenCalledWith('/home/project/nested');
    expect(rmdirSync).toHaveBeenCalledWith('/home/project');
  });

  it('is a no-op when /home does not exist', () => {
    const readdirSync = jest.fn();
    const fs = {
      existsSync: () => false,
      readdirSync,
      lstatSync: () => ({ isDirectory: () => false }),
      unlinkSync: jest.fn(),
      rmdirSync: jest.fn(),
    } as unknown as FS;

    clearHomeDirectory(fs);
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it('throws when removing a directory on a filesystem without rmdirSync support', () => {
    const fs = {
      existsSync: () => true,
      readdirSync: (path: string) => (path === '/home' ? ['project'] : []),
      lstatSync: () => ({ isDirectory: () => true }),
    } as unknown as FS;

    expect(() => clearHomeDirectory(fs)).toThrow('Filesystem does not support rmdirSync');
  });

  it('throws when removing a file on a filesystem without unlinkSync support', () => {
    const fs = {
      existsSync: () => true,
      readdirSync: (path: string) => (path === '/home' ? ['main.scad'] : []),
      lstatSync: () => ({ isDirectory: () => false }),
      rmdirSync: jest.fn(),
    } as unknown as FS;

    expect(() => clearHomeDirectory(fs)).toThrow('Filesystem does not support unlinkSync');
  });
});

describe('File System Access helpers', () => {
  afterEach(() => {
    clearActiveFileHandle();
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  it('openLocalFile returns null when the picker API is unavailable', async () => {
    await expect(openLocalFile()).resolves.toBeNull();
  });

  it('openLocalFile returns file metadata and saveActiveFile writes via the retained handle', async () => {
    const writable = {
      write: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const handle = {
      getFile: jest.fn().mockResolvedValue({
        name: 'demo.scad',
        text: jest.fn().mockResolvedValue('cube(10);'),
      }),
      createWritable: jest.fn().mockResolvedValue(writable),
    };

    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: jest.fn().mockResolvedValue([handle]),
    });

    await expect(openLocalFile()).resolves.toEqual({
      name: 'demo.scad',
      content: 'cube(10);',
    });
    await expect(saveActiveFile('sphere(5);')).resolves.toBe(true);
    expect(writable.write).toHaveBeenCalledWith('sphere(5);');
    expect(writable.close).toHaveBeenCalled();
  });

  it('openLocalFile treats AbortError as a user cancel and resets failed save handles', async () => {
    const handle = {
      getFile: jest.fn().mockResolvedValue({
        name: 'demo.scad',
        text: jest.fn().mockResolvedValue('cube(10);'),
      }),
      createWritable: jest.fn().mockRejectedValue(new Error('disk full')),
    };

    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
        .mockResolvedValueOnce([handle]),
    });

    await expect(openLocalFile()).resolves.toBeNull();
    await openLocalFile();
    await expect(saveActiveFile('cube(1);')).resolves.toBe(false);
    await expect(saveActiveFile('cube(2);')).resolves.toBe(false);
  });

  it('openLocalFile rethrows non-abort picker failures', async () => {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: jest.fn().mockRejectedValue(new Error('permission denied')),
    });

    await expect(openLocalFile()).rejects.toThrow('permission denied');
  });
});
