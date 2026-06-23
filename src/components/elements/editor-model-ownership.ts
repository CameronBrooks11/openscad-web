// Editor model ownership helpers (#122). The editor panel creates one Monaco
// text model per file URI, but Monaco never disposes those models on its own —
// `editor.dispose()` frees the editor, not the externally-created models. Left
// alone they accumulate for every path ever opened and across panel remounts.
// The panel "owns" the models it creates for project files and disposes them
// when their file leaves the project or the panel tears down. These pure helpers
// hold that policy so it can be unit-tested without a real Monaco/DOM.

import { getParentDir } from '../../fs/filesystem.ts';

/**
 * A model is *project-scoped* (and therefore panel-owned) when it backs an
 * editable project file: a file under `/home/` or a top-level file. Directory
 * mounts and library files (e.g. `/libraries/...`) are excluded — those are not
 * part of the user's project and are managed elsewhere.
 */
export function isProjectScopedPath(path: string): boolean {
  if (path.endsWith('/')) return false;
  return path.startsWith('/home/') || getParentDir(path) === '/';
}

/**
 * Of the owned model paths, the ones to dispose given the project's current
 * source set: any owned path no longer present in the live sources. The active
 * path is always kept — its model is on screen, and disposing it would break the
 * editor.
 */
export function staleModelPaths(
  ownedPaths: Iterable<string>,
  livePaths: ReadonlySet<string>,
  activePath: string,
): string[] {
  const stale: string[] = [];
  for (const path of ownedPaths) {
    if (path === activePath) continue;
    if (!livePaths.has(path)) stale.push(path);
  }
  return stale;
}
