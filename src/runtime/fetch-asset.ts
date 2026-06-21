// Centralized fetching for first-party runtime assets (fonts and library
// archives today). Validates HTTP status and bounds the response size, so a 404
// HTML page or a misbehaving endpoint surfaces as a clear, structured error
// instead of flowing into a downstream parser (e.g. ZipFS) as a confusing failure.

/** Default cap on a single fetched asset (generous; WASM/library zips are large). */
export const DEFAULT_MAX_ASSET_BYTES = 256 * 1024 * 1024;

export class AssetFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AssetFetchError';
  }
}

export interface FetchAssetOptions {
  /** Maximum accepted response size in bytes. Defaults to DEFAULT_MAX_ASSET_BYTES. */
  maxBytes?: number;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

/**
 * Fetch a runtime asset as bytes, validating status and size.
 *
 * @throws {AssetFetchError} on network failure, non-2xx status, or over-size response.
 */
export async function fetchAssetBytes(
  url: string,
  options: FetchAssetOptions = {},
): Promise<ArrayBuffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;

  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (err) {
    throw new AssetFetchError(
      `Failed to fetch asset ${url}: ${err instanceof Error ? err.message : String(err)}`,
      url,
    );
  }

  if (!response.ok) {
    throw new AssetFetchError(
      `Failed to fetch asset ${url}: HTTP ${response.status} ${response.statusText}`.trim(),
      url,
      response.status,
    );
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AssetFetchError(
      `Asset ${url} is too large (${declared} bytes, limit ${maxBytes}).`,
      url,
      response.status,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new AssetFetchError(
      `Asset ${url} is too large (${buffer.byteLength} bytes, limit ${maxBytes}).`,
      url,
      response.status,
    );
  }

  return buffer;
}
