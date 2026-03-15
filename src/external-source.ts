const ABSOLUTE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export const EXTERNAL_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const EXTERNAL_SOURCE_TIMEOUT_MS = 10_000;

interface ExternalSourcePolicy {
  allowCrossOriginHttps?: boolean;
  baseUrl?: string;
}

function getBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  if (typeof globalThis.location?.href === 'string') {
    return globalThis.location.href;
  }
  throw new Error('Missing base URL for external source resolution.');
}

function getBaseOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function getAllowedSourceUrlError(allowCrossOriginHttps: boolean): string {
  return allowCrossOriginHttps
    ? 'source URL must be https:// or same-origin relative/absolute.'
    : 'source URL must be same-origin relative/absolute.';
}

export function isAllowedExternalSourceUrl(
  rawUrl: string,
  { allowCrossOriginHttps = false, baseUrl }: ExternalSourcePolicy = {},
): boolean {
  const value = rawUrl.trim();
  if (value === '') return false;
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
    return true;
  }
  if (!ABSOLUTE_SCHEME_RE.test(value)) return false;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return (
      parsed.origin === getBaseOrigin(getBaseUrl(baseUrl)) ||
      (allowCrossOriginHttps && parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

export function normalizeGitHubBlobUrl(url: string): string {
  const ghBlobRe = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
  const match = url.match(ghBlobRe);
  if (!match) return url;
  const [, user, repo, branch, path] = match;
  return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`;
}

export function resolveExternalSourceUrl(
  rawUrl: string,
  { allowCrossOriginHttps = false, baseUrl }: ExternalSourcePolicy = {},
): URL {
  const resolvedBaseUrl = getBaseUrl(baseUrl);
  const value = rawUrl.trim();
  if (!isAllowedExternalSourceUrl(value, { allowCrossOriginHttps, baseUrl: resolvedBaseUrl })) {
    throw new Error(getAllowedSourceUrlError(allowCrossOriginHttps));
  }

  let resolved: URL;
  try {
    resolved = new URL(value, resolvedBaseUrl);
  } catch {
    throw new Error(`Invalid source URL: ${value.slice(0, 80)}`);
  }

  const normalized = new URL(normalizeGitHubBlobUrl(resolved.href));
  const isSameOrigin = normalized.origin === getBaseOrigin(resolvedBaseUrl);
  if (!isSameOrigin && !(allowCrossOriginHttps && normalized.protocol === 'https:')) {
    throw new Error(getAllowedSourceUrlError(allowCrossOriginHttps));
  }

  return normalized;
}

export async function fetchResolvedExternalSourceBytes(
  url: URL,
  {
    maxBytes = EXTERNAL_SOURCE_MAX_BYTES,
    timeoutMs = EXTERNAL_SOURCE_TIMEOUT_MS,
  }: {
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url.href, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Failed to fetch source: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching source.`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Source file is too large (> ${maxBytes / 1024 / 1024} MB).`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Source file is too large (> ${maxBytes / 1024 / 1024} MB).`);
  }

  return new Uint8Array(buffer);
}

export async function fetchExternalSourceBytes(
  rawUrl: string,
  {
    allowCrossOriginHttps = false,
    baseUrl,
    maxBytes = EXTERNAL_SOURCE_MAX_BYTES,
    timeoutMs = EXTERNAL_SOURCE_TIMEOUT_MS,
  }: ExternalSourcePolicy & {
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<Uint8Array> {
  const resolved = resolveExternalSourceUrl(rawUrl, {
    allowCrossOriginHttps,
    baseUrl,
  });
  return fetchResolvedExternalSourceBytes(resolved, { maxBytes, timeoutMs });
}
