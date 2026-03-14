function normalizeAssetSpecifier(assetSpecifier: string): string {
  return assetSpecifier.replace(/^\.\//, '');
}

function getDefaultRuntimeBaseUrl(): string {
  if (typeof document === 'object' && document.baseURI) {
    return document.baseURI;
  }
  if (typeof self === 'object' && 'location' in self && self.location?.href) {
    return self.location.href;
  }
  throw new Error('Unable to determine a runtime base URL for asset resolution.');
}

export function resolveRuntimeAssetUrl(
  assetSpecifier: string,
  baseUrl = getDefaultRuntimeBaseUrl(),
): string {
  return new URL(normalizeAssetSpecifier(assetSpecifier), baseUrl).toString();
}
