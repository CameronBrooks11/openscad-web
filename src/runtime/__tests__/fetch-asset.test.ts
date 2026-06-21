import { fetchAssetBytes, AssetFetchError } from '../fetch-asset.ts';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function bytes(n: number): ArrayBuffer {
  return new Uint8Array(n).buffer;
}

describe('fetchAssetBytes (#52)', () => {
  it('returns the body bytes for a 200 response', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(bytes(8), { status: 200, headers: { 'content-length': '8' } }),
      ) as typeof fetch;

    const buf = await fetchAssetBytes('https://x/asset.zip');
    expect(buf.byteLength).toBe(8);
  });

  it('succeeds for a small body with no content-length header', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(bytes(8), { status: 200 })) as typeof fetch;

    const buf = await fetchAssetBytes('https://x/asset.zip');
    expect(buf.byteLength).toBe(8);
  });

  it('throws a structured error on a non-2xx status', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('<html>Not Found</html>', { status: 404 })) as typeof fetch;

    const err = await fetchAssetBytes('https://x/missing.zip').catch((e) => e);
    expect(err).toBeInstanceOf(AssetFetchError);
    expect(err.status).toBe(404);
    expect(err.url).toBe('https://x/missing.zip');
    expect(String(err.message)).toContain('404');
  });

  it('wraps a network failure as an AssetFetchError', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('network down')) as typeof fetch;

    const err = await fetchAssetBytes('https://x/asset.zip').catch((e) => e);
    expect(err).toBeInstanceOf(AssetFetchError);
    expect(String(err.message)).toContain('network down');
  });

  it('rejects when content-length exceeds the limit', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(bytes(4), { status: 200, headers: { 'content-length': '999' } }),
      ) as typeof fetch;

    await expect(fetchAssetBytes('https://x/big.zip', { maxBytes: 10 })).rejects.toBeInstanceOf(
      AssetFetchError,
    );
  });

  it('rejects when the body exceeds the limit despite no content-length', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(bytes(100), { status: 200 })) as typeof fetch;

    await expect(fetchAssetBytes('https://x/big.zip', { maxBytes: 10 })).rejects.toBeInstanceOf(
      AssetFetchError,
    );
  });
});
