// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { createEditorFS } from './fs/filesystem.ts';
import {
  getLibraryBootstrapPrefetchSpecifiers,
  getRuntimeBootstrapPrefetchSpecifiers,
  injectBootstrapPrefetchHints,
  shouldPreloadEditorLibraries,
} from './fs/library-delivery.ts';
import { ensureBrowserFSLoaded, getBrowserFS } from './runtime/browserfs-runtime.ts';
import { loadBootConfig, mergeConfigIntoSearch } from './runtime/boot-config.ts';
import { setRuntimeAssetBase } from './runtime/asset-urls.ts';
import { registerAppServiceWorker } from './runtime/service-worker.ts';
import { readStateFromFragment, writeStateInFragment } from './state/fragment-state.ts';
import { readPersistedState, writePersistedState } from './state/persisted-state.ts';
import { createInitialState } from './state/initial-state.ts';
import { parseUrlMode } from './state/url-mode.ts';
import { setFS } from './state/fs-context.ts';
import { OpenScadSession } from './state/session.ts';
import { openSCADWorkerUrl } from './runner/worker-bootstrap.ts';
import { isInStandaloneMode, registerCustomAppHeightCSSProperty } from './utils.ts';
import { State, StatePersister } from './state/app-state.ts';
import { markPerf, measurePerf } from './perf/runtime-performance.ts';
import { openSCADWasmUrl } from './runner/openscad-asset-urls.ts';
import './index.css';

import debug from 'debug';

// Shell elements are imported dynamically per boot mode (see the mode branch
// below) so a reduced surface — embed or customizer — never loads the editor
// shell and therefore never pulls in Monaco. The Monaco stylesheet moved into
// osc-editor-panel for the same reason.

const log = debug('app:log');

if (!import.meta.env.PROD) {
  debug.enable('*');
  log('Logging is enabled!');
} else {
  debug.disable();
}

// The runtime chunks (worker + WASM) are absolute URLs, correct immediately, so
// prefetch them now. The library archives (fonts) are relative and resolve
// against the runtime asset base — deferred to after the boot config sets it
// (below), so a shared-runtime thin mount doesn't 404 the hint against itself.
injectBootstrapPrefetchHints(
  getRuntimeBootstrapPrefetchSpecifiers(openSCADWorkerUrl, openSCADWasmUrl),
);

window.addEventListener('load', async () => {
  const rootEl = document.getElementById('root')!;
  const bootConfig = await loadBootConfig();
  if (typeof bootConfig.title === 'string' && bootConfig.title.trim() !== '') {
    document.title = bootConfig.title;
  }
  // A shared-runtime mount (multi-target publish) points runtime-asset fetches
  // (libraries/fonts) at the shared runtime, resolved relative to this document.
  // This runs before the session (and thus the compile worker) is created, so
  // the worker inherits the shared base via its configure message
  // (workerConfigPayload -> getDefaultRuntimeBaseUrl) — the thin mount itself
  // has no libraries/.
  if (typeof bootConfig.assetBase === 'string' && bootConfig.assetBase.trim() !== '') {
    const resolved = new URL(bootConfig.assetBase, document.baseURI).toString();
    setRuntimeAssetBase(resolved.endsWith('/') ? resolved : `${resolved}/`);
  }

  // Now the runtime base is set, prefetch the library archives (fonts) against
  // it — the shared runtime for a thin mount, or this document otherwise.
  injectBootstrapPrefetchHints(getLibraryBootstrapPrefetchSpecifiers());

  const urlModeResult = parseUrlMode(mergeConfigIntoSearch(window.location.search, bootConfig));

  if ('error' in urlModeResult) {
    markPerf('osc:app-bootstrap-error');
    rootEl.replaceChildren();
    const errorWrap = document.createElement('div');
    errorWrap.style.cssText = 'padding:2rem;font-family:monospace;color:red;';
    const heading = document.createElement('h2');
    heading.textContent = 'Invalid URL parameters';
    const detail = document.createElement('pre');
    detail.textContent = urlModeResult.error;
    errorWrap.append(heading, detail);
    rootEl.appendChild(errorWrap);
    return;
  }

  markPerf('osc:app-bootstrap-start', { standalone: isInStandaloneMode() });

  // Kick off the mode's shell module download now so it (and, for the editor,
  // the Monaco chunk) loads in parallel with the service-worker registration,
  // filesystem init, and model construction below — it is awaited just before
  // mounting. This keeps the eager initial chunk small without serializing the
  // shell load behind the boot work.
  const shellModule =
    urlModeResult.mode === 'customizer'
      ? import('./components/elements/osc-customizer-shell.ts')
      : urlModeResult.mode === 'embed'
        ? import('./components/elements/osc-embed-shell.ts')
        : import('./components/elements/osc-app-shell.ts');

  await registerAppServiceWorker();

  registerCustomAppHeightCSSProperty();

  await ensureBrowserFSLoaded();

  markPerf('osc:main-fs-init-start');
  const { fs, libraries } = await createEditorFS({ allowPersistence: isInStandaloneMode() });
  markPerf('osc:main-fs-init-end');
  measurePerf('osc:main-fs-init', 'osc:main-fs-init-start', 'osc:main-fs-init-end');
  setFS(fs);

  if (shouldPreloadEditorLibraries(urlModeResult.mode)) {
    markPerf('osc:libraries-preload-start');
    await libraries.preloadAll();
    markPerf('osc:libraries-preload-end');
    measurePerf(
      'osc:libraries-preload',
      'osc:libraries-preload-start',
      'osc:libraries-preload-end',
    );
  }

  let statePersister: StatePersister;
  let persistedState: State | null = null;

  if (isInStandaloneMode()) {
    const bfs: FS = getBrowserFS().BFSRequire('fs');
    persistedState = readPersistedState(bfs, window.location.href);
    statePersister = {
      set: async (state) => writePersistedState(bfs, state),
    };
  } else {
    persistedState = await readStateFromFragment();
    statePersister = { set: writeStateInFragment };
  }

  const initialState = createInitialState(persistedState);

  // The session owns its compile engine + model; the shell provides it to its
  // subtree (replacing the former getModel() singleton). init() runs after mount.
  const session = new OpenScadSession(fs, initialState, undefined, statePersister);

  // Persistence is debounced, so an edit made right before the tab is hidden or
  // closed could otherwise be lost. Force a flush on `pagehide` and when the
  // page becomes hidden (the latter is the reliable signal on mobile, where
  // `pagehide`/`beforeunload` often don't fire). Both are idempotent — a flush
  // with no durable change is a no-op.
  window.addEventListener('pagehide', () => void session.model.flushPersist());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void session.model.flushPersist();
  });

  // The shell module download was started at the top of bootstrap; awaiting it
  // here guarantees the custom element is defined before it is created/upgraded.
  await shellModule;
  if (urlModeResult.mode === 'customizer') {
    const shell = document.createElement('osc-customizer-shell') as HTMLElement & {
      urlParams: typeof urlModeResult;
      session: OpenScadSession;
    };
    shell.style.cssText = 'display:flex;flex:1;width:100%;height:100%;';
    shell.session = session;
    shell.urlParams = urlModeResult;
    rootEl.appendChild(shell);
  } else if (urlModeResult.mode === 'embed') {
    const shell = document.createElement('osc-embed-shell') as HTMLElement & {
      urlParams: typeof urlModeResult;
      session: OpenScadSession;
    };
    shell.style.cssText = 'display:flex;flex:1;width:100%;height:100%;';
    shell.session = session;
    shell.urlParams = urlModeResult;
    rootEl.appendChild(shell);
  } else {
    const shell = document.createElement('osc-app-shell') as HTMLElement & {
      session: OpenScadSession;
    };
    shell.style.cssText = 'display:flex;flex:1;width:100%;height:100%;';
    shell.session = session;
    rootEl.appendChild(shell);
    // Normal app mode: call init after mounting
    session.init();
  }

  markPerf('osc:app-shell-mounted');
  measurePerf('osc:app-bootstrap', 'osc:app-bootstrap-start', 'osc:app-shell-mounted');
});
