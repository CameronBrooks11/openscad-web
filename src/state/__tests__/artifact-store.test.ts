import { describe, expect, it } from 'vitest';

import type { ArtifactRef } from '../../runner/compile-contract.ts';
import { ArtifactStore } from '../artifact-store.ts';

function ref(artifactId: string, name = 'm.off'): ArtifactRef {
  return {
    artifactId,
    operationId: 'op',
    sourceRevision: 0,
    format: 'off',
    mediaType: 'text/plain',
    size: 1,
    name,
  };
}

function file(bytes: string, name = 'm.off'): File {
  return new File([bytes], name);
}

describe('ArtifactStore', () => {
  it('returns the exact bytes stored under an artifactId', async () => {
    const store = new ArtifactStore();
    store.put(file('hello'), ref('a'));
    const found = store.get('a');
    expect(found?.ref.artifactId).toBe('a');
    expect(await found?.bytes.text()).toBe('hello');
  });

  it('returns undefined for an unknown id', () => {
    const store = new ArtifactStore();
    expect(store.get('nope')).toBeUndefined();
  });

  it('keeps distinct ids isolated, returning each operation’s own bytes', async () => {
    const store = new ArtifactStore();
    store.put(file('first'), ref('a'));
    store.put(file('second'), ref('b'));
    expect(await store.get('a')?.bytes.text()).toBe('first');
    expect(await store.get('b')?.bytes.text()).toBe('second');
  });

  it('re-putting the same id replaces the bytes', async () => {
    const store = new ArtifactStore();
    store.put(file('old'), ref('a'));
    store.put(file('new'), ref('a'));
    expect(store.size).toBe(1);
    expect(await store.get('a')?.bytes.text()).toBe('new');
  });

  it('evicts the least-recently-used once over capacity', () => {
    const store = new ArtifactStore(2);
    store.put(file('1'), ref('a'));
    store.put(file('2'), ref('b'));
    store.put(file('3'), ref('c')); // evicts 'a'
    expect(store.size).toBe(2);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });

  it('a get bumps recency, sparing that entry from the next eviction', () => {
    const store = new ArtifactStore(2);
    store.put(file('1'), ref('a'));
    store.put(file('2'), ref('b'));
    store.get('a'); // 'a' is now most-recent; 'b' is the LRU
    store.put(file('3'), ref('c')); // evicts 'b', not 'a'
    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBeDefined();
  });
});
