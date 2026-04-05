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
  }: {
    documentBaseURI?: string | null;
    runtimeOrigin?: string | null;
  } = {},
): string {
  if (baseUrl === './') {
    if (!documentBaseURI) {
      throw new Error('Unable to determine document.baseURI for relocatable asset resolution.');
    }
    return documentBaseURI;
  }

  return new URL(
    normalizeBasePath(baseUrl),
    getRuntimeOriginBaseUrl(documentBaseURI, runtimeOrigin),
  ).toString();
}

function getDefaultRuntimeBaseUrl(): string {
  return resolveDefaultRuntimeBaseUrl(import.meta.env.BASE_URL);
}

export function resolveRuntimeAssetUrl(
  assetSpecifier: string,
  baseUrl = getDefaultRuntimeBaseUrl(),
): string {
  return new URL(normalizeAssetSpecifier(assetSpecifier), baseUrl).toString();
}
