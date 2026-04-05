// URL-mode parsing, external model fetching, and customizer share URL builder.

import {
  EXTERNAL_SOURCE_MAX_BYTES,
  fetchResolvedExternalSourceBytes,
  isAllowedExternalSourceUrl,
  normalizeGitHubBlobUrl,
  resolveExternalSourceUrl,
} from '../external-source.ts';
import { formatExternalLoadError } from '../user-facing-errors.ts';

export type AppMode = 'editor' | 'customizer' | 'embed';

export interface UrlModeParams {
  mode: AppMode;
  modelUrl: string | null;
  parentOrigin: string | null;
  prePopulatedVars: Record<string, string>;
  embedControls: boolean;
  embedDownload: boolean;
  viewOverrides: {
    showAxes?: boolean;
    color?: string;
    lineNumbers?: boolean;
  };
}

/** Query-param keys that are reserved by the router and must NOT be treated
 *  as pre-populated customizer variables. */
const KNOWN_PARAMS = new Set([
  'mode',
  'model',
  'parentOrigin',
  'controls',
  'download',
  'showAxes',
  'color',
  'lineNumbers',
  'skipMultimaterialPrompt',
  'autoCompile',
]);

/** Returns true for same-origin relative/absolute paths and HTTPS cross-origin URLs.
 *  Rejects non-HTTPS cross-origin URLs and all other schemes (javascript:, data:, etc.). */
export function isAllowedModelUrl(modelUrl: string): boolean {
  return isAllowedExternalSourceUrl(modelUrl, {
    allowCrossOriginHttps: true,
    baseUrl: window.location.href,
  });
}

function normalizeParentOrigin(parentOrigin: string): string | null {
  const value = parentOrigin.trim();
  if (value === '') return null;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
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
      error: `model URL must be https:// or same-origin. Got: ${modelUrl.slice(0, 40)}`,
    };
  }

  const rawParentOrigin = params.get('parentOrigin');
  const parentOrigin = rawParentOrigin === null ? null : normalizeParentOrigin(rawParentOrigin);
  if (rawParentOrigin !== null && parentOrigin === null) {
    return {
      error: `parentOrigin must be an absolute http(s) origin. Got: ${rawParentOrigin.slice(0, 40)}`,
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
    parentOrigin,
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

const MODEL_MAX_BYTES = EXTERNAL_SOURCE_MAX_BYTES;

export const normalizeGitHubUrl = normalizeGitHubBlobUrl;

/** Resolve a model URL relative to the current page origin. */
function resolveModelUrl(modelUrl: string): URL | { error: string } {
  try {
    return resolveExternalSourceUrl(modelUrl, {
      allowCrossOriginHttps: true,
      baseUrl: window.location.href,
    });
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
export async function fetchExternalModel(modelUrl: string): Promise<string | { error: string }> {
  if (!isAllowedModelUrl(modelUrl)) {
    return { error: `model URL must be https:// or same-origin.` };
  }

  const resolved = resolveModelUrl(modelUrl);
  if ('error' in resolved) return resolved;

  // Cross-origin fetch: show trust notice once per origin per session.
  if (resolved.origin !== window.location.origin) {
    if (!checkTrustNotice(resolved.origin)) {
      return { error: 'Fetch cancelled by user.' };
    }
  }

  try {
    const buffer = await fetchResolvedExternalSourceBytes(resolved, { maxBytes: MODEL_MAX_BYTES });
    return new TextDecoder().decode(buffer);
  } catch (e) {
    return { error: formatExternalLoadError(e, 'model') };
  }
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
