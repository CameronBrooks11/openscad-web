// URL-mode parsing, external model fetching, and customizer share URL builder.

export type AppMode = 'editor' | 'customizer' | 'embed';

export interface UrlModeParams {
  mode: AppMode;
  modelUrl: string | null;
  prePopulatedVars: Record<string, string>;
  embedControls: boolean;
  embedDownload: boolean;
  viewOverrides: {
    showAxes?: boolean;
    color?: string;
    lineNumbers?: boolean;
  };
}

const ABSOLUTE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Query-param keys that are reserved by the router and must NOT be treated
 *  as pre-populated customizer variables. */
const KNOWN_PARAMS = new Set([
  'mode', 'model', 'controls', 'download',
  'showAxes', 'color', 'lineNumbers',
  'skipMultimaterialPrompt', 'autoCompile',
]);

/** Returns true for same-origin relative paths (./  ../  /) and https:// URLs.
 *  Rejects non-HTTPS absolute URLs and all other schemes (javascript:, data:, etc.). */
export function isAllowedModelUrl(modelUrl: string): boolean {
  const value = modelUrl.trim();
  if (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/')
  ) {
    return true;
  }
  if (!ABSOLUTE_SCHEME_RE.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse `window.location.search` into a UrlModeParams object.
 *  Returns `{ error: string }` on validation failure (caller decides how to surface it). */
export function parseUrlMode(search: string): UrlModeParams | { error: string } {
  const params = new URLSearchParams(search);
  const rawMode = params.get('mode') ?? 'editor';
  if (!(['editor', 'customizer', 'embed'] as string[]).includes(rawMode)) {
    return { error: `Unknown mode: ${rawMode}` };
  }
  const mode = rawMode as AppMode;

  const modelUrl = params.get('model');
  if (modelUrl !== null && !isAllowedModelUrl(modelUrl)) {
    return {
      error: `model URL must be https:// or same-origin relative. Got: ${modelUrl.slice(0, 40)}`,
    };
  }

  const prePopulatedVars: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (!KNOWN_PARAMS.has(key)) {
      prePopulatedVars[key] = value;
    }
  }

  return {
    mode,
    modelUrl,
    prePopulatedVars,
    embedControls: params.get('controls') === 'true',
    embedDownload: params.get('download') === 'true',
    viewOverrides: {
      ...(params.has('showAxes') && { showAxes: params.get('showAxes') === 'true' }),
      ...(params.has('color') && { color: params.get('color')! }),
      ...(params.has('lineNumbers') && { lineNumbers: params.get('lineNumbers') === 'true' }),
    },
  };
}

// ---------------------------------------------------------------------------
// U2 — External model fetching
// ---------------------------------------------------------------------------

const MODEL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB hard cap

/** Convert a github.com blob URL to the equivalent raw.githubusercontent.com URL. */
export function normalizeGitHubUrl(url: string): string {
  const ghBlobRe =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
  const match = url.match(ghBlobRe);
  if (match) {
    const [, user, repo, branch, path] = match;
    return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`;
  }
  return url;
}

/** Resolve a model URL relative to the current page origin. */
function resolveModelUrl(modelUrl: string): URL | { error: string } {
  try {
    // Relative paths resolve against current page; absolute HTTPS pass through.
    return new URL(modelUrl, window.location.href);
  } catch {
    return { error: `Invalid model URL: ${modelUrl.slice(0, 80)}` };
  }
}

/** Show a one-per-session trust notice before fetching from a new origin.
 *  Returns true if the fetch should proceed. */
function checkTrustNotice(origin: string): boolean {
  const key = `urlmode_trusted_${origin}`;
  if (sessionStorage.getItem(key)) return true;
  // Prompt user once per session per origin.
  const ok = window.confirm(
    `This page will load a model from:\n${origin}\n\nDo you want to proceed?`,
  );
  if (ok) sessionStorage.setItem(key, '1');
  return ok;
}

/** Fetch an external model file.
 *  Returns the text content or `{ error: string }`. */
export async function fetchExternalModel(
  modelUrl: string,
): Promise<string | { error: string }> {
  if (!isAllowedModelUrl(modelUrl)) {
    return { error: `model URL must be https:// or same-origin relative.` };
  }

  const resolved = resolveModelUrl(modelUrl);
  if ('error' in resolved) return resolved;

  // Normalize GitHub blob URLs to raw content URLs.
  const finalUrl = normalizeGitHubUrl(resolved.href);
  let fetchUrl: URL;
  try {
    fetchUrl = new URL(finalUrl);
  } catch {
    return { error: `Invalid resolved URL.` };
  }

  // Cross-origin fetch: show trust notice once per origin per session.
  if (fetchUrl.origin !== window.location.origin) {
    if (!checkTrustNotice(fetchUrl.origin)) {
      return { error: 'Fetch cancelled by user.' };
    }
  }

  let response: Response;
  try {
    response = await fetch(fetchUrl.href, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { error: `Failed to fetch model: ${(e as Error).message}` };
  }

  if (!response.ok) {
    return { error: `HTTP ${response.status} while fetching model.` };
  }

  // Guard against oversized responses.
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MODEL_MAX_BYTES) {
    return {
      error: `Model file is too large (> ${MODEL_MAX_BYTES / 1024 / 1024} MB).`,
    };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MODEL_MAX_BYTES) {
    return {
      error: `Model file is too large (> ${MODEL_MAX_BYTES / 1024 / 1024} MB).`,
    };
  }

  return new TextDecoder().decode(buffer);
}

// ---------------------------------------------------------------------------
// U8 — Customizer share URL builder
// ---------------------------------------------------------------------------

/** Build a shareable URL for the current customizer state.
 *  Only non-default values are included in the query string. */
export function buildCustomizerShareUrl(
  baseUrl: string,
  modelUrl: string,
  currentVars: Record<string, unknown>,
  defaultVars: Record<string, unknown>,
): string {
  const url = new URL(baseUrl);
  url.search = '';
  url.searchParams.set('mode', 'customizer');
  url.searchParams.set('model', modelUrl);
  for (const [key, value] of Object.entries(currentVars)) {
    const defaultValue = defaultVars[key];
    if (value !== defaultValue) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
