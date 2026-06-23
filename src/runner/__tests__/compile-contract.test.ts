import { describe, expect, it } from 'vitest';

import { formatOfName, mediaTypeForFormat, newId } from '../compile-contract.ts';

describe('newId', () => {
  it('mints unique, well-formed v4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000); // no collisions
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of ids) expect(id).toMatch(uuid);
  });
});

describe('mediaTypeForFormat', () => {
  it('maps known formats and defaults unknown ones to octet-stream', () => {
    expect(mediaTypeForFormat('svg')).toBe('image/svg+xml');
    expect(mediaTypeForFormat('GLB')).toBe('model/gltf-binary'); // case-insensitive
    expect(mediaTypeForFormat('3mf')).toBe('model/3mf');
    expect(mediaTypeForFormat('wat')).toBe('application/octet-stream');
  });
});

describe('formatOfName', () => {
  it('extracts the lower-cased extension', () => {
    expect(formatOfName('part.STL')).toBe('stl');
    expect(formatOfName('model.scad')).toBe('scad');
    expect(formatOfName('noext')).toBe('');
  });
});
