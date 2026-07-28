/**
 * A published multi-file project (#253). `deploy-configure` emits this for
 * compile-surface targets assembled from a `projectRoot`: every published file,
 * as paths relative to the mount's `project/` directory (POSIX separators).
 * The runtime fetches each file from `./project/<path>` and boots the compiler
 * with the whole tree, so `use <…>` / `include <…>` between project files
 * resolve. Absent for single-file (`source`) targets.
 */
export interface BootProject {
  /** The entry `.scad` file, relative to `project/`. Always listed in `files`. */
  entry: string;
  /** Every published project file, relative to `project/` (entry included). */
  files: string[];
}

export interface BootConfig {
  model?: string;
  mode?: string;
  controls?: boolean;
  download?: boolean;
  parentOrigin?: string;
  title?: string;
  /** The published project tree for a multi-file compile target (#253). */
  project?: BootProject;
  /**
   * Base for runtime-fetched assets (libraries/fonts), relative to this
   * surface's document. Set when a shared runtime is assembled once and
   * multiple thin mounts point at it (multi-target publish). Absent for a
   * self-contained mount, where assets resolve relative to the document.
   */
  assetBase?: string;
  /**
   * URL (relative to this document) of a pre-rendered OFF geometry file, for the
   * `static` surface — the standalone geometry viewer fetches and displays it
   * with no in-browser compile.
   */
  geometry?: string;
  /**
   * URL (relative to this document) of a pre-rendered PNG poster for the
   * `static` surface, shown before the geometry loads / as a social preview.
   */
  poster?: string;
}

export const BOOT_CONFIG_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A project-relative path that is safe to resolve under the mount's `project/`
 * directory: non-empty, relative, forward-slash separated, and unable to
 * escape (`..`), re-anchor (leading `/`, drive letter, URL scheme), or smuggle
 * odd segments (empty, `.`). The boot config is same-origin data, but it is
 * still fetched input — validate before building fetch URLs from it.
 */
function isSafeProjectRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('\\') || value.includes(':') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Validate a raw `project` value. Malformed input yields `undefined` (the
 * surface falls back to single-file boot) rather than a partial project — a
 * half-hydrated tree would compile against missing files, which is exactly the
 * silent failure this field exists to fix.
 */
function normalizeBootProject(value: unknown): BootProject | undefined {
  const dropped = (reason: string) => {
    // A dropped project falls back to single-file boot, whose sibling
    // references fail with no other diagnostic — say why, loudly.
    console.warn(`[openscad-web] boot config "project" ignored (${reason}).`);
    return undefined;
  };
  if (!isRecord(value)) return dropped('not an object');
  const { entry, files } = value;
  if (!isSafeProjectRelativePath(entry)) return dropped('invalid entry path');
  if (!Array.isArray(files) || files.length === 0) return dropped('files missing or empty');
  if (!files.every(isSafeProjectRelativePath)) return dropped('invalid file path in files');
  const unique = new Set(files);
  if (unique.size !== files.length) return dropped('duplicate file paths');
  if (!unique.has(entry)) return dropped('entry not listed in files');
  return { entry, files: [...files] };
}

function normalizeBootConfig(value: unknown): BootConfig {
  if (!isRecord(value)) {
    return {};
  }

  const config: BootConfig = {};

  if (typeof value.model === 'string') config.model = value.model;
  if (typeof value.mode === 'string') config.mode = value.mode;
  if (typeof value.controls === 'boolean') config.controls = value.controls;
  if (typeof value.download === 'boolean') config.download = value.download;
  if (typeof value.parentOrigin === 'string') config.parentOrigin = value.parentOrigin;
  if (typeof value.title === 'string') config.title = value.title;
  if (typeof value.assetBase === 'string') config.assetBase = value.assetBase;
  if (typeof value.geometry === 'string') config.geometry = value.geometry;
  if (typeof value.poster === 'string') config.poster = value.poster;

  if (value.project != null) {
    const project = normalizeBootProject(value.project);
    if (project) config.project = project;
  }

  return config;
}

function getBootConfigUrl(): string {
  if (typeof document === 'object' && document.baseURI) {
    return new URL('./openscad-web.config.json', document.baseURI).toString();
  }
  if (typeof globalThis.location?.href === 'string') {
    return new URL('./openscad-web.config.json', globalThis.location.href).toString();
  }
  return './openscad-web.config.json';
}

export async function loadBootConfig({
  fetchImpl = fetch,
  timeoutMs = BOOT_CONFIG_TIMEOUT_MS,
  configUrl = getBootConfigUrl(),
}: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  configUrl?: string;
} = {}): Promise<BootConfig> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(configUrl, {
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return {};
    }

    return normalizeBootConfig(await response.json());
  } catch {
    return {};
  } finally {
    clearTimeout(timeoutId);
  }
}

export function mergeConfigIntoSearch(search: string, config: BootConfig): string {
  const mergedParams = new URLSearchParams();

  if (typeof config.mode === 'string') mergedParams.set('mode', config.mode);
  if (typeof config.model === 'string') mergedParams.set('model', config.model);
  if (typeof config.controls === 'boolean') mergedParams.set('controls', String(config.controls));
  if (typeof config.download === 'boolean') mergedParams.set('download', String(config.download));
  if (typeof config.parentOrigin === 'string') {
    mergedParams.set('parentOrigin', config.parentOrigin);
  }

  for (const [key, value] of new URLSearchParams(search).entries()) {
    mergedParams.set(key, value);
  }

  const mergedSearch = mergedParams.toString();
  return mergedSearch === '' ? '' : `?${mergedSearch}`;
}
