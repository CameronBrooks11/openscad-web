import { describe, expect, it } from 'vitest';

import { isProjectScopedPath, staleModelPaths } from '../editor-model-ownership.ts';

describe('isProjectScopedPath', () => {
  it('owns editable project files (under /home or top-level)', () => {
    expect(isProjectScopedPath('/home/demo.scad')).toBe(true);
    expect(isProjectScopedPath('/home/lib/part.scad')).toBe(true);
    expect(isProjectScopedPath('/top.scad')).toBe(true);
  });

  it('does not own library files or directory mounts', () => {
    expect(isProjectScopedPath('/libraries/BOSL2/std.scad')).toBe(false);
    expect(isProjectScopedPath('/home/')).toBe(false);
    expect(isProjectScopedPath('/libraries/')).toBe(false);
  });
});

describe('staleModelPaths', () => {
  it('flags owned paths no longer in the project for disposal', () => {
    const owned = ['/home/a.scad', '/home/b.scad', '/home/c.scad'];
    const live = new Set(['/home/a.scad']); // b and c removed (project replaced)
    expect(staleModelPaths(owned, live, '/home/a.scad')).toEqual(['/home/b.scad', '/home/c.scad']);
  });

  it('never disposes the active model, even if absent from sources', () => {
    const owned = ['/home/a.scad'];
    const live = new Set<string>(); // active not yet reflected in sources
    expect(staleModelPaths(owned, live, '/home/a.scad')).toEqual([]);
  });

  it('keeps every model when all are still live', () => {
    const owned = ['/home/a.scad', '/home/b.scad'];
    const live = new Set(owned);
    expect(staleModelPaths(owned, live, '/home/a.scad')).toEqual([]);
  });
});
