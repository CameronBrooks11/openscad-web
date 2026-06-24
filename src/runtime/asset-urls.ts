import { normalizeBasePath } from './base-path.ts';

function normalizeAssetSpecifier(assetSpecifier: string): string {
  return assetSpecifier.replace(/^\.\//, '');
}

function getRuntimeOriginBaseUrl(
  documentBaseURI?: string | null,
  runtimeOrigin?: string | null,
): string {
  if (runtimeOrigin) {
    return `${runtimeOrigin}/`;
  }
  if (documentBaseURI) {
    return new URL('/', documentBaseURI).toString();
  }
  throw new Error('Unable to determine a runtime origin for asset resolution.');
}

export function resolveDefaultRuntimeBaseUrl(
  baseUrl: string,
  {
    documentBaseURI = typeof document === 'object' ? document.baseURI : null,
    runtimeOrigin = typeof self === 'object' && 'location' in self && self.location?.origin
      ? self.location.origin
      : null,
    workerHref = typeof document !== 'object' &&
    typeof self === 'object' &&
    'location' in self &&
    (self as { location?: { href?: string } }).location?.href
      ? (self as { location?: { href?: string } }).location!.href!
      : null,
  }: {
    documentBaseURI?: string | null;
    runtimeOrigin?: string | null;
    workerHref?: string | null;
  } = {},
): string {
  if (baseUrl === './') {
    if (documentBaseURI) {
      return documentBaseURI;
    }
    if (workerHref) {
      // Worker context: the worker script lives at <mount>/assets/worker-HASH.js.
      // Navigate up one level to recover the app mount root.
      return new URL('../', workerHref).toString();
    }
    throw new Error('Unable to determine document.baseURI for relocatable asset resolution.');
  }

  return new URL(
    normalizeBasePath(baseUrl),
    getRuntimeOriginBaseUrl(documentBaseURI, runtimeOrigin),
  ).toString();
}

let overrideBase: string | null = null;

/**
 * Pin the base used to resolve runtime assets (libraries/fonts/sources). A blob
 * worker — a VS Code webview's compile worker (#196) — can't derive its base from
 * `self.location` (it's `blob:`), so the worker sets this from its `configure`
 * handshake. `null` (the default, and the main thread) restores normal derivation.
 */
export function setRuntimeAssetBase(base: string | null): void {
  overrideBase = base;
}

function getDefaultRuntimeBaseUrl(): string {
  return overrideBase ?? resolveDefaultRuntimeBaseUrl(import.meta.env.BASE_URL);
}

export function resolveRuntimeAssetUrl(
  assetSpecifier: string,
  baseUrl = getDefaultRuntimeBaseUrl(),
): string {
  return new URL(normalizeAssetSpecifier(assetSpecifier), baseUrl).toString();
}
