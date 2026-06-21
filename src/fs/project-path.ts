// Canonical validation for project-relative paths coming from untrusted sources
// (imported archives, fetched manifests, host-supplied file lists). Centralized
// so every entry point applies the same rules and writes stay within the project
// root.

/** Maximum length of a single relative path. */
export const MAX_PROJECT_PATH_LENGTH = 1024;
/** Maximum number of files accepted from one imported archive. */
export const MAX_PROJECT_FILE_COUNT = 2000;
/** Maximum total uncompressed bytes accepted from one imported archive (64 MiB). */
export const MAX_PROJECT_TOTAL_BYTES = 64 * 1024 * 1024;

export class ProjectPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPathError';
  }
}

/**
 * Normalize an untrusted relative path to a safe, project-relative form.
 *
 * Converts backslashes to forward slashes, collapses `.` segments and redundant
 * slashes, and rejects anything that could escape the project root or smuggle in
 * control characters: absolute paths, drive letters, `..` traversal, NUL/control
 * characters, and over-long paths.
 *
 * @returns the normalized relative path (e.g. `sub/dir/file.scad`)
 * @throws {ProjectPathError} if the path is unsafe.
 */
export function normalizeProjectPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new ProjectPathError('Empty path.');
  }
  if (rawPath.length > MAX_PROJECT_PATH_LENGTH) {
    throw new ProjectPathError(`Path exceeds ${MAX_PROJECT_PATH_LENGTH} characters.`);
  }

  const path = rawPath.replace(/\\/g, '/');

  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20 || path.charCodeAt(i) === 0x7f) {
      throw new ProjectPathError('Path contains control characters.');
    }
  }

  if (path.startsWith('/')) {
    throw new ProjectPathError(`Absolute paths are not allowed: ${rawPath}`);
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new ProjectPathError(`Drive-letter paths are not allowed: ${rawPath}`);
  }

  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new ProjectPathError(`Path traversal is not allowed: ${rawPath}`);
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new ProjectPathError(`Path resolves to nothing: ${rawPath}`);
  }

  return segments.join('/');
}
