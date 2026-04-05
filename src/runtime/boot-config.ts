export interface BootConfig {
  model?: string;
  mode?: string;
  controls?: boolean;
  download?: boolean;
  parentOrigin?: string;
  title?: string;
}

export const BOOT_CONFIG_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
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
