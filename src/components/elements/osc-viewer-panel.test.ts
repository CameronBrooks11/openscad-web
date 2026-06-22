// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Control the async hashing step so we can interleave two SVG loads.
const imageToThumbhash = vi.fn();
vi.mock('../../io/image_hashes.ts', async (importActual) => ({
  ...(await importActual<typeof import('../../io/image_hashes.ts')>()),
  imageToThumbhash: (p: string) => imageToThumbhash(p),
}));

import { OscViewerPanel } from './osc-viewer-panel.ts';

function makePanel() {
  const el = new OscViewerPanel();
  const mutations: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any)._model = {
    mutate: (f: (s: { preview?: { thumbhash: string } }) => void) => {
      const s: { preview?: { thumbhash: string } } = {};
      f(s);
      mutations.push(s.preview);
      return true;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const load = (url: string) => (el as any)._loadSvgPreview(url) as Promise<void>;
  return { load, mutations };
}

describe('osc-viewer-panel SVG preview staleness', () => {
  beforeEach(() => imageToThumbhash.mockReset());

  it('does not let a stale SVG hash overwrite a newer one', async () => {
    const { load, mutations } = makePanel();

    // First load hangs on hashing; second resolves immediately.
    let resolveFirst!: (h: string) => void;
    imageToThumbhash
      .mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)))
      .mockResolvedValueOnce('hash-2');

    const p1 = load('blob:svg-1'); // begins hashing, hangs
    const p2 = load('blob:svg-2'); // supersedes, resolves 'hash-2'
    await p2;

    // The stale first hash now arrives — it must be dropped.
    resolveFirst('hash-1');
    await p1;

    expect(mutations).toEqual([{ thumbhash: 'hash-2' }]);
  });

  it('ignores a repeat load of the same SVG URL', async () => {
    const { load, mutations } = makePanel();
    imageToThumbhash.mockResolvedValue('hash');

    await load('blob:svg-1');
    await load('blob:svg-1'); // same URL → no-op

    expect(imageToThumbhash).toHaveBeenCalledTimes(1);
    expect(mutations).toEqual([{ thumbhash: 'hash' }]);
  });
});
