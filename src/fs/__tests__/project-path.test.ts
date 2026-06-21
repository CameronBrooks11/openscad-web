import { normalizeProjectPath, ProjectPathError } from '../project-path.ts';

describe('normalizeProjectPath (#50)', () => {
  it('accepts and normalizes plain relative paths', () => {
    expect(normalizeProjectPath('main.scad')).toBe('main.scad');
    expect(normalizeProjectPath('lib/util.scad')).toBe('lib/util.scad');
  });

  it('collapses "." segments and redundant slashes', () => {
    expect(normalizeProjectPath('./a/./b.scad')).toBe('a/b.scad');
    expect(normalizeProjectPath('a//b///c.scad')).toBe('a/b/c.scad');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeProjectPath('lib\\sub\\file.scad')).toBe('lib/sub/file.scad');
  });

  it('rejects parent-directory traversal', () => {
    expect(() => normalizeProjectPath('../evil.scad')).toThrow(ProjectPathError);
    expect(() => normalizeProjectPath('a/../../evil.scad')).toThrow(ProjectPathError);
    expect(() => normalizeProjectPath('lib\\..\\..\\evil.scad')).toThrow(ProjectPathError);
  });

  it('rejects absolute, drive-letter, and UNC paths', () => {
    expect(() => normalizeProjectPath('/etc/passwd')).toThrow(ProjectPathError);
    expect(() => normalizeProjectPath('C:\\Windows\\system32')).toThrow(ProjectPathError);
    // UNC: backslashes become slashes first, so it reads as an absolute path.
    expect(() => normalizeProjectPath('\\\\server\\share\\f.scad')).toThrow(ProjectPathError);
  });

  it('keeps literal dotted segments (... ) as harmless filenames, not traversal', () => {
    expect(normalizeProjectPath('.../f.scad')).toBe('.../f.scad');
    expect(normalizeProjectPath('a/.../b.scad')).toBe('a/.../b.scad');
  });

  it('rejects NUL and control characters', () => {
    expect(() => normalizeProjectPath('a\x00b.scad')).toThrow(ProjectPathError);
    expect(() => normalizeProjectPath('a\nb.scad')).toThrow(ProjectPathError);
  });

  it('rejects empty paths and paths that resolve to nothing', () => {
    expect(() => normalizeProjectPath('')).toThrow(ProjectPathError);
    expect(() => normalizeProjectPath('.')).toThrow(ProjectPathError);
    expect(() => normalizeProjectPath('./')).toThrow(ProjectPathError);
  });

  it('rejects over-long paths', () => {
    expect(() => normalizeProjectPath('a/'.repeat(600) + 'f.scad')).toThrow(ProjectPathError);
  });
});
