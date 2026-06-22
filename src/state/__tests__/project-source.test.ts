import { describe, expect, it } from 'vitest';

import {
  fromFragment,
  fromWire,
  toFragment,
  toWire,
  type ProjectSource,
  type WireSource,
} from '../project-source.ts';

describe('fromWire — classification', () => {
  it('classifies a text source', () => {
    expect(fromWire({ path: '/a.scad', content: 'cube(10);' })).toEqual({
      kind: 'text',
      path: '/a.scad',
      content: 'cube(10);',
    });
  });

  it('classifies binary content as a binary source', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(fromWire({ path: '/a.stl', content: bytes })).toEqual({
      kind: 'binary',
      path: '/a.stl',
      content: bytes,
    });
  });

  it('classifies a url-only source as an unloaded remote', () => {
    expect(fromWire({ path: '/a.scad', url: 'https://x/a.scad' })).toEqual({
      kind: 'remote',
      path: '/a.scad',
      url: 'https://x/a.scad',
    });
  });

  it('classifies a url+content source as a loaded remote', () => {
    expect(fromWire({ path: '/a.scad', url: 'https://x/a.scad', content: 'sphere(5);' })).toEqual({
      kind: 'remote',
      path: '/a.scad',
      url: 'https://x/a.scad',
      content: 'sphere(5);',
    });
  });

  it('classifies a trailing-slash path with a url as an archive', () => {
    expect(fromWire({ path: '/lib/', url: 'https://x/lib.zip' })).toEqual({
      kind: 'archive',
      path: '/lib/',
      url: 'https://x/lib.zip',
    });
  });

  it('ignores binary content on a remote source (url wins, bytes dropped)', () => {
    // url present → remote branch; non-string content is not carried.
    expect(fromWire({ path: '/a.scad', url: 'https://x/a', content: new Uint8Array([9]) })).toEqual(
      { kind: 'remote', path: '/a.scad', url: 'https://x/a' },
    );
  });

  it('classifies a bare path (no url, no content) as an on-disk local source', () => {
    expect(fromWire({ path: '/a.scad' })).toEqual({ kind: 'local', path: '/a.scad' });
  });
});

describe('toWire — flattening', () => {
  it('flattens text', () => {
    expect(toWire({ kind: 'text', path: '/a.scad', content: 'x' })).toEqual({
      path: '/a.scad',
      content: 'x',
    });
  });

  it('flattens binary', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(toWire({ kind: 'binary', path: '/a.stl', content: bytes })).toEqual({
      path: '/a.stl',
      content: bytes,
    });
  });

  it('flattens an unloaded remote without a content key', () => {
    const wire = toWire({ kind: 'remote', path: '/a.scad', url: 'u' });
    expect(wire).toEqual({ path: '/a.scad', url: 'u' });
    expect('content' in wire).toBe(false);
  });

  it('flattens a loaded remote with its content', () => {
    expect(toWire({ kind: 'remote', path: '/a.scad', url: 'u', content: 'c' })).toEqual({
      path: '/a.scad',
      url: 'u',
      content: 'c',
    });
  });

  it('flattens an archive', () => {
    expect(toWire({ kind: 'archive', path: '/lib/', url: 'z' })).toEqual({
      path: '/lib/',
      url: 'z',
    });
  });

  it('flattens a local source to a bare path', () => {
    const wire = toWire({ kind: 'local', path: '/disk.scad' });
    expect(wire).toEqual({ path: '/disk.scad' });
    expect('content' in wire).toBe(false);
    expect('url' in wire).toBe(false);
  });
});

describe('round-trip: toWire(fromWire(x)) === x for real source shapes', () => {
  const corpus: WireSource[] = [
    { path: '/a.scad', content: 'cube(10);' },
    { path: '/empty.scad', content: '' },
    { path: '/disk.scad' }, // bare path → local, now lossless
    { path: '/r.scad', url: 'https://x/r.scad' },
    { path: '/r.scad', url: 'https://x/r.scad', content: 'loaded' },
    { path: '/lib/', url: 'https://x/lib.zip' },
    { path: '/a.stl', content: new Uint8Array([1, 2, 3, 4]) },
  ];

  for (const wire of corpus) {
    it(`round-trips ${JSON.stringify(wire.path)}`, () => {
      expect(toWire(fromWire(wire))).toEqual(wire);
    });
  }

  it('round-trips representable union variants through fromWire(toWire(x))', () => {
    // Excludes the two deliberately-normalized shapes (a url+binary source, and
    // a remote whose path ends with '/'): those collide with the binary and
    // archive discriminants and are documented in project-source.ts as not
    // round-tripping. Neither is produced by the codebase.
    const sources: ProjectSource[] = [
      { kind: 'text', path: '/a.scad', content: 'x' },
      { kind: 'local', path: '/disk.scad' },
      { kind: 'remote', path: '/r.scad', url: 'u' },
      { kind: 'remote', path: '/r.scad', url: 'u', content: 'c' },
      { kind: 'archive', path: '/lib/', url: 'z' },
      { kind: 'binary', path: '/b.stl', content: new Uint8Array([7]) },
    ];
    for (const s of sources) {
      expect(fromWire(toWire(s))).toEqual(s);
    }
  });
});

describe('fragment helpers — text-only projection', () => {
  it('fromFragment classifies a loaded remote', () => {
    expect(fromFragment({ path: '/a.scad', url: 'u', content: 'c' })).toEqual({
      kind: 'remote',
      path: '/a.scad',
      url: 'u',
      content: 'c',
    });
  });

  it('toFragment flattens a text source', () => {
    expect(toFragment({ kind: 'text', path: '/a.scad', content: 'cube();' })).toEqual({
      path: '/a.scad',
      content: 'cube();',
    });
  });

  it('round-trips serializable sources through the fragment shape', () => {
    const sources = [
      { path: '/a.scad', content: 'cube();' },
      { path: '/disk.scad' },
      { path: '/r.scad', url: 'u' },
      { path: '/r.scad', url: 'u', content: 'c' },
      { path: '/lib/', url: 'z' },
    ];
    for (const s of sources) {
      expect(toFragment(fromFragment(s))).toEqual(s);
    }
  });
});
