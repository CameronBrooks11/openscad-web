function normalizeAssetSpecifier(assetSpecifier: string): string {
  return assetSpecifier.replace(/^\.\//, '');
}

function normalizeBasePath(basePath: string): string {
  if (/^[a-z]+:\/\//i.test(basePath)) {
    const url = new URL(basePath);
    return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
  }

  const trimmed = basePath.trim();
  if (trimmed === '' || trimmed === '.') {
    return '/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
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
