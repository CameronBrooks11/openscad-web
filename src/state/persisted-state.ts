// The persisted-state seam for standalone/PWA mode.
//
// In standalone mode the durable slice of app state is stored on the BrowserFS
// home partition at /home/state.json. This is per-user data with NO server-side
// migration — the app is a static GitHub Pages deploy — so the on-disk JSON
// shape must stay backward-compatible across releases. Routing the read/write
// through this single seam (instead of inline in index.ts) makes that contract
// explicit and unit-testable.
//
// The read path runs the SAME `validateDurableState` as the URL-fragment path, so
// a corrupt/tampered state.json self-heals to safe defaults instead of injecting
// bad data — and the two durable surfaces can never validate the same field
// differently. The flat on-disk source shape is classified into the typed union
// there (the load-bearing normalization for existing users' state.json).

import { ProjectFileSystem } from '../fs/project-filesystem.ts';
import type { State } from './app-state.ts';
import { toFragment } from './project-source.ts';
import { DURABLE_SCHEMA_VERSION, validateDurableState } from './durable-state.ts';

const STATE_PATH = '/home/state.json';

/**
 * Read and validate the persisted durable state, or null if absent/unreadable.
 * `baseUrl` resolves/origin-checks any remote source URLs (the app's own origin).
 */
export function readPersistedState(fs: ProjectFileSystem, baseUrl: string): State | null {
  try {
    const data = JSON.parse(new TextDecoder('utf-8').decode(fs.readFileSync(STATE_PATH)));
    return validateDurableState(data, { baseUrl });
  } catch (e) {
    console.log('Failed to read the persisted state from local storage.', e);
    return null;
  }
}

/** Persist the durable slice (view/params/preview), flattening sources to disk. */
export function writePersistedState(fs: ProjectFileSystem, { view, params, preview }: State): void {
  const flatParams = { ...params, sources: params.sources.map(toFragment) };
  fs.writeFile(
    STATE_PATH,
    JSON.stringify({ schemaVersion: DURABLE_SCHEMA_VERSION, view, params: flatParams, preview }),
  );
}
