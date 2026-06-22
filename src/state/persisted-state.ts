// The persisted-state seam for standalone/PWA mode.
//
// In standalone mode the durable slice of app state is stored on the BrowserFS
// home partition at /home/state.json. This is per-user data with NO server-side
// migration — the app is a static GitHub Pages deploy — so the on-disk JSON
// shape must stay backward-compatible across releases. Routing the read/write
// through this single seam (instead of inline in index.ts) makes that contract
// explicit and unit-testable, and gives a later source-shape change exactly one
// place to add a normalization shim.
//
// The read path intentionally performs no normalization today: it returns the
// persisted {view, params, preview} verbatim, matching the historical behavior.

import { ProjectFileSystem } from '../fs/project-filesystem.ts';
import type { State } from './app-state.ts';
import { fromFragment, toFragment, type FragmentSource } from './project-source.ts';

const STATE_PATH = '/home/state.json';

/**
 * Read the persisted durable state, or null if absent/unreadable. The on-disk
 * sources are the flat `{ path, url?, content? }` shape; classify them into the
 * typed union so in-memory state is well-formed (this is the load-bearing
 * normalization for existing users' state.json).
 */
export function readPersistedState(fs: ProjectFileSystem): State | null {
  try {
    const data = JSON.parse(new TextDecoder('utf-8').decode(fs.readFileSync(STATE_PATH)));
    const { view, params, preview } = data;
    if (params && Array.isArray(params.sources)) {
      params.sources = (params.sources as FragmentSource[]).map(fromFragment);
    }
    return { view, params, preview };
  } catch (e) {
    console.log('Failed to read the persisted state from local storage.', e);
    return null;
  }
}

/** Persist the durable slice (view/params/preview), flattening sources to disk. */
export function writePersistedState(fs: ProjectFileSystem, { view, params, preview }: State): void {
  const flatParams = { ...params, sources: params.sources.map(toFragment) };
  fs.writeFile(STATE_PATH, JSON.stringify({ view, params: flatParams, preview }));
}
