export function normalizeBasePath(rawBasePath: string): string {
  if (/^[a-z]+:\/\//i.test(rawBasePath)) {
    const url = new URL(rawBasePath);
    return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
  }

  const trimmed = rawBasePath.trim();
  if (trimmed === '' || trimmed === '.') {
    return '/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}
