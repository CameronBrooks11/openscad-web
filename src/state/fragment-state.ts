// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { resolveExternalSourceUrl } from '../external-source.ts';
import { State } from './app-state.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from './formats.ts';
import { validateArray, validateBoolean, validateString, validateStringEnum } from '../utils.ts';
import { fromFragment, toFragment, type FragmentSource } from './project-source.ts';
import { createInitialState, defaultModelColor, defaultSourcePath } from './initial-state.ts';

function validateVars(v: unknown): State['params']['vars'] {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      ([k]) => typeof k === 'string' && k.length > 0,
    ),
  );
}

// Preserve tri-state: an absent boolean stays `undefined` (its "use the default"
// meaning) rather than collapsing to `false`. validateBoolean() coerces absent to
// false, which would, e.g., wrongly disable autoCompile (default-on) for any
// shared URL that never set it.
function validateOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function validateCamera(value: unknown): State['view']['camera'] {
  if (value == null || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  const triple = (t: unknown): [number, number, number] | undefined =>
    Array.isArray(t) &&
    t.length === 3 &&
    t.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? [t[0] as number, t[1] as number, t[2] as number]
      : undefined;
  const position = triple(c.position);
  const target = triple(c.target);
  const zoom = typeof c.zoom === 'number' && Number.isFinite(c.zoom) ? c.zoom : undefined;
  if (!position || !target || zoom === undefined) return undefined;
  return { position, target, zoom };
}

function validateSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return resolveExternalSourceUrl(value, {
    baseUrl: window.location.href,
  }).href;
}

function validateSources(value: unknown): State['params']['sources'] {
  // Validate into the flat wire shape, then classify into the typed union. The
  // on-the-wire fragment stays flat (no `kind`); see encodeStateParamsAsFragment.
  const flat = validateArray(
    value as FragmentSource[],
    (src): FragmentSource => ({
      path: validateString(src?.path, () => defaultSourcePath),
      content: src?.content != null ? validateString(src.content) : undefined,
      url: validateSourceUrl(src?.url),
    }),
    () => [{ path: defaultSourcePath, content: '' }],
  );
  return flat.map(fromFragment);
}

export async function buildUrlForStateParams(state: State) {
  return `${location.protocol}//${location.host}${location.pathname}#${await encodeStateParamsAsFragment(state)}`;
}
export async function writeStateInFragment(state: State) {
  // Pass null, not `state`: nothing reads history.state, and `state` carries
  // non-serializable runtime fields (output File/blob handles) that would bloat
  // or break the structured clone on every fragment write.
  history.replaceState(null, '', '#' + (await encodeStateParamsAsFragment(state)));
}
async function compressString(input: string): Promise<string> {
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(input));
              controller.close();
            },
          }).pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      ),
    ),
  );
}

async function decompressString(compressedInput: string): Promise<string> {
  return new TextDecoder().decode(
    await new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.from(atob(compressedInput), (c) => c.charCodeAt(0)));
          controller.close();
        },
      }).pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );
}

export function encodeStateParamsAsFragment(state: State) {
  const json = JSON.stringify({
    // Flatten the typed source union back to the flat on-the-wire shape so the
    // encoded fragment stays byte-compatible with previously-shared URLs.
    params: { ...state.params, sources: state.params.sources.map(toFragment) },
    view: state.view,
    preview: state.preview,
  });
  return compressString(json);
}
export async function readStateFromFragment(): Promise<State | null> {
  if (window.location.hash.startsWith('#') && window.location.hash.length > 1) {
    try {
      const serialized = window.location.hash.substring(1);
      if (serialized === 'blank') {
        return createInitialState(null, { content: '' });
      } else if (serialized.startsWith('src=')) {
        // For testing
        const src = decodeURIComponent(serialized.substring('src='.length));
        return createInitialState(null, { content: src });
      } else if (serialized.startsWith('path=')) {
        const path = decodeURIComponent(serialized.substring('path='.length));
        return createInitialState(null, { path });
      } else if (serialized.startsWith('url=')) {
        // For testing
        const url = decodeURIComponent(serialized.substring('url='.length));
        const resolvedUrl = resolveExternalSourceUrl(url, {
          baseUrl: window.location.href,
        });
        const path = '/' + resolvedUrl.pathname.split('/').pop();
        return createInitialState(null, { path, url: resolvedUrl.href });
      }
      let obj;
      try {
        obj = JSON.parse(await decompressString(serialized));
      } catch {
        // Backwards compatibility
        obj = JSON.parse(decodeURIComponent(serialized));
      }
      const { params, view, preview } = obj;
      return {
        params: {
          activePath: validateString(params?.activePath, () => defaultSourcePath),
          features: validateArray(params?.features, validateString),
          vars: validateVars(params?.vars),
          // Source deserialization also handles legacy links (source + sourcePath)
          sources: validateSources(
            params?.sources ??
              (params?.source
                ? [{ path: params?.sourcePath, content: params?.source }]
                : undefined),
          ),
          exportFormat2D: validateStringEnum(
            params?.exportFormat2D,
            Object.keys(VALID_EXPORT_FORMATS_2D),
            (_s) => 'svg',
          ),
          exportFormat3D: validateStringEnum(
            params?.exportFormat3D,
            Object.keys(VALID_EXPORT_FORMATS_3D),
            (_s) => 'stl',
          ),
          extruderColors: Array.isArray(params?.extruderColors)
            ? validateArray(params.extruderColors, validateString)
            : undefined,
          backend: validateStringEnum(params?.backend, ['manifold', 'cgal'], (_s) => undefined),
          autoCompile: validateOptionalBoolean(params?.autoCompile),
          skipMultimaterialPrompt: validateOptionalBoolean(params?.skipMultimaterialPrompt),
        },
        preview: preview
          ? {
              thumbhash: preview.thumbhash ? validateString(preview.thumbhash) : undefined,
              blurhash: preview.blurhash ? validateString(preview.blurhash) : undefined,
            }
          : undefined,
        view: {
          logs: validateBoolean(view?.logs),
          extruderPickerVisibility: validateStringEnum(
            view?.extruderPickerVisibility,
            ['editing', 'exporting'],
            (_s) => undefined,
          ),
          layout: {
            mode: validateStringEnum(view?.layout?.mode, ['multi', 'single']),
            focus: validateStringEnum(
              view?.layout?.focus,
              ['editor', 'viewer', 'customizer'],
              (_s) => false,
            ),
            editor: validateBoolean(view?.layout['editor']),
            viewer: validateBoolean(view?.layout['viewer']),
            customizer: validateBoolean(view?.layout['customizer']),
          },
          collapsedCustomizerTabs: validateArray(view?.collapsedCustomizerTabs, validateString),
          customizerGroupsCollapsed: validateOptionalBoolean(view?.customizerGroupsCollapsed),
          camera: validateCamera(view?.camera),
          color: validateString(view?.color, () => defaultModelColor),
          showAxes: validateBoolean(view?.showAxes, () => true),
          lineNumbers: validateBoolean(view?.lineNumbers, () => false),
        },
      };
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}
