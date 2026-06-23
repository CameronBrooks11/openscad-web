// The single validator for DURABLE app state, shared by both persistence seams:
// the URL fragment (shared links — untrusted) and `/home/state.json` (standalone
// PWA storage). Both decode an untyped JSON blob into a `State`, and historically
// only the fragment path validated it while the persisted path trusted the disk
// verbatim. Routing both through one validator removes that divergence: a corrupt
// or hostile blob (object-valued vars, non-finite numbers, malformed camera, an
// unknown enum, a cross-origin source URL) self-heals to safe defaults on either
// path instead of injecting bad data that fails deeper in the app.

import { resolveExternalSourceUrl } from '../external-source.ts';
import { isOpenScadValue, type OpenScadValue } from '../openscad-value.ts';
import type { State } from './app-state.ts';
import { VALID_EXPORT_FORMATS_2D, VALID_EXPORT_FORMATS_3D } from './formats.ts';
import { validateArray, validateBoolean, validateString, validateStringEnum } from '../utils.ts';
import { fromFragment, type FragmentSource } from './project-source.ts';
import { defaultSourcePath, defaultModelColor } from './initial-state.ts';

/**
 * The durable-state schema version, stamped onto every write. Absent (legacy
 * pre-version data) is read as 0; 0 and 1 share the same field shape, so no
 * migration is needed yet. A future breaking change branches on this in
 * `validateDurableState` before validating; the field is stamped now so that
 * future reader can tell old data apart.
 */
export const DURABLE_SCHEMA_VERSION = 1;

function validateVars(v: unknown): State['params']['vars'] {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  // Keep only well-formed entries: a non-empty key and an OpenSCAD-valid value, so
  // a corrupt/hostile blob can't inject a value (object, Infinity, …) that the
  // args builder would later reject mid-render.
  const out: Record<string, OpenScadValue> = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (k.length > 0 && isOpenScadValue(value)) out[k] = value;
  }
  return out;
}

// Preserve tri-state: an absent boolean stays `undefined` (its "use the default"
// meaning) rather than collapsing to `false`. validateBoolean() coerces absent to
// false, which would, e.g., wrongly disable autoCompile (default-on) for any
// shared URL / saved state that never set it.
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
      ? [t[0], t[1], t[2]]
      : undefined;
  const position = triple(c.position);
  const target = triple(c.target);
  const zoom = typeof c.zoom === 'number' && Number.isFinite(c.zoom) ? c.zoom : undefined;
  if (!position || !target || zoom === undefined) return undefined;
  return { position, target, zoom };
}

function validateSourceUrl(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return resolveExternalSourceUrl(value, { baseUrl }).href;
  } catch {
    // An out-of-policy or unparseable URL (e.g. a cross-origin remote, or an
    // absolute same-origin URL after the app's origin changed — custom domain,
    // fork, PR preview) drops to undefined so the source degrades to a path-only
    // reference, instead of throwing and discarding the user's ENTIRE durable
    // state along with its valid sibling sources.
    return undefined;
  }
}

function validateSources(value: unknown, baseUrl: string): State['params']['sources'] {
  // Validate into the flat wire shape, then classify into the typed union. The
  // on-the-wire shape stays flat (no `kind`); see `toFragment`.
  const flat = validateArray(
    value as FragmentSource[],
    (src): FragmentSource => ({
      path: validateString(src?.path, () => defaultSourcePath),
      content: src?.content != null ? validateString(src.content) : undefined,
      url: validateSourceUrl(src?.url, baseUrl),
    }),
    () => [{ path: defaultSourcePath, content: '' }],
  );
  return flat.map(fromFragment);
}

/**
 * Validate an untyped, JSON-decoded durable-state blob into a `State`. The
 * `baseUrl` resolves/origin-checks any remote source URLs. Throws only on an
 * irrecoverably malformed required field (e.g. a missing layout mode); callers
 * treat a throw as "no usable persisted state" and fall back to defaults.
 */
export function validateDurableState(raw: unknown, opts: { baseUrl: string }): State {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // The blob is structurally untyped (JSON); each field validator below narrows
  // and defaults its own field, so a loose `any` accessor is the right input type.
  const obj = (raw ?? {}) as any;
  const { params, view, preview } = obj;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  if (schemaVersion > DURABLE_SCHEMA_VERSION) {
    // Forward-compat: read newer data best-effort rather than discarding it — the
    // field validators default anything they don't recognise.
    console.warn(
      `durable state schemaVersion ${schemaVersion} is newer than ${DURABLE_SCHEMA_VERSION}; reading best-effort`,
    );
  }
  const { baseUrl } = opts;
  return {
    params: {
      activePath: validateString(params?.activePath, () => defaultSourcePath),
      features: validateArray(params?.features, validateString),
      vars: validateVars(params?.vars),
      // Source deserialization also handles legacy links (source + sourcePath).
      sources: validateSources(
        params?.sources ??
          (params?.source ? [{ path: params?.sourcePath, content: params?.source }] : undefined),
        baseUrl,
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
        editor: validateBoolean(view?.layout?.['editor']),
        viewer: validateBoolean(view?.layout?.['viewer']),
        customizer: validateBoolean(view?.layout?.['customizer']),
      },
      collapsedCustomizerTabs: validateArray(view?.collapsedCustomizerTabs, validateString),
      customizerGroupsCollapsed: validateOptionalBoolean(view?.customizerGroupsCollapsed),
      camera: validateCamera(view?.camera),
      color: validateString(view?.color, () => defaultModelColor),
      showAxes: validateBoolean(view?.showAxes, () => true),
      lineNumbers: validateBoolean(view?.lineNumbers, () => false),
    },
  };
}
