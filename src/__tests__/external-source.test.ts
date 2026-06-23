import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchResolvedExternalSourceBytes } from '../external-source.ts';

const URL_OK = new URL('https://example.com/model.scad');

/** A minimal streaming Response: hands out `chunks` from a reader, exposes the
 *  `cancel` spy, and throws if `arrayBuffer()` is used (it shouldn't be). */
function streamResponse(chunks: Uint8Array[], { contentLength }: { contentLength?: string } = {}) {
  let i = 0;
  const cancel = vi.fn(async () => {});
  const getReader = vi.fn(() => ({
    read: async () =>
      i < chunks.length
        ? { done: false as const, value: chunks[i++] }
        : { done: true as const, value: undefined },
    cancel,
  }));
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-length' ? (contentLength ?? null) : null),
    },
    body: { getReader },
    arrayBuffer: async () => {
      throw new Error('arrayBuffer() should not be called on a streaming body');
    },
    _cancel: cancel,
    _getReader: getReader,
  };
}

function bufferedResponse(bytes: Uint8Array, { contentLength }: { contentLength?: string } = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-length' ? (contentLength ?? null) : null),
    },
    body: null,
    arrayBuffer: async () => bytes.buffer,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchResolvedExternalSourceBytes streaming size limit', () => {
  it('streams a body under the limit and returns the concatenated bytes', async () => {
    const res = streamResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );

    const out = await fetchResolvedExternalSourceBytes(URL_OK, { maxBytes: 1024 });
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('aborts the stream as soon as the cumulative size exceeds the budget', async () => {
    // Two 4-byte chunks against a 6-byte budget: the second crosses it.
    const res = streamResponse([new Uint8Array(4), new Uint8Array(4)]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );

    await expect(fetchResolvedExternalSourceBytes(URL_OK, { maxBytes: 6 })).rejects.toThrow(
      /too large/,
    );
    expect(res._cancel).toHaveBeenCalled(); // the download was cancelled, not drained
  });

  it('rejects on an oversized content-length before reading the body', async () => {
    const res = streamResponse([new Uint8Array(1)], { contentLength: '999999' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );

    await expect(fetchResolvedExternalSourceBytes(URL_OK, { maxBytes: 10 })).rejects.toThrow(
      /too large/,
    );
    expect(res._getReader).not.toHaveBeenCalled(); // never started streaming
  });

  it('falls back to a buffered read with the same cap when there is no stream body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bufferedResponse(new Uint8Array([9, 8, 7]))),
    );
    const out = await fetchResolvedExternalSourceBytes(URL_OK, { maxBytes: 1024 });
    expect(Array.from(out)).toEqual([9, 8, 7]);
  });

  it('rejects an oversized buffered body in the no-stream fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bufferedResponse(new Uint8Array(20))),
    );
    await expect(fetchResolvedExternalSourceBytes(URL_OK, { maxBytes: 10 })).rejects.toThrow(
      /too large/,
    );
  });
});
