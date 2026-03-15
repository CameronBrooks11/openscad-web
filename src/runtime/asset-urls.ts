import { normalizeBasePath } from './base-path.ts';

function normalizeAssetSpecifier(assetSpecifier: string): string {
  return assetSpecifier.replace(/^\.\//, '');
}

function getRuntimeOriginBaseUrl(): string {
  if (typeof self === 'object' && 'location' in self && self.location?.origin) {
    return `${self.location.origin}/`;
  }
  if (typeof document === 'object' && document.baseURI) {
    return new URL('/', document.baseURI).toString();
  }
  throw new Error('Unable to determine a runtime origin for asset resolution.');
}

function getDefaultRuntimeBaseUrl(): string {
  return new URL(normalizeBasePath(import.meta.env.BASE_URL), getRuntimeOriginBaseUrl()).toString();
}

export function resolveRuntimeAssetUrl(
  assetSpecifier: string,
  baseUrl = getDefaultRuntimeBaseUrl(),
): string {
  return new URL(normalizeAssetSpecifier(assetSpecifier), baseUrl).toString();
}
