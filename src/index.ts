// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { createEditorFS, preloadEditorLibraries } from './fs/filesystem.ts';
import {
  getBootstrapPrefetchSpecifiers,
  injectBootstrapPrefetchHints,
  shouldPreloadEditorLibraries,
} from './fs/library-delivery.ts';
import { ensureBrowserFSLoaded, getBrowserFS } from './runtime/browserfs-runtime.ts';
import { loadBootConfig, mergeConfigIntoSearch } from './runtime/boot-config.ts';
import { registerAppServiceWorker } from './runtime/service-worker.ts';
import { readStateFromFragment, writeStateInFragment } from './state/fragment-state.ts';
import { readPersistedState, writePersistedState } from './state/persisted-state.ts';
import { createInitialState } from './state/initial-state.ts';
import { parseUrlMode } from './state/url-mode.ts';
import { setModel } from './state/model-context.ts';
import { setFS } from './state/fs-context.ts';
import { Model } from './state/model.ts';
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

injectBootstrapPrefetchHints(
  getBootstrapPrefetchSpecifiers(undefined, openSCADWorkerUrl, openSCADWasmUrl),
);

window.addEventListener('load', async () => {
  const rootEl = document.getElementById('root')!;
  const bootConfig = await loadBootConfig();
  if (typeof bootConfig.title === 'string' && bootConfig.title.trim() !== '') {
    document.title = bootConfig.title;
  }

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
  const fs = await createEditorFS({ allowPersistence: isInStandaloneMode() });
  markPerf('osc:main-fs-init-end');
  measurePerf('osc:main-fs-init', 'osc:main-fs-init-start', 'osc:main-fs-init-end');
  setFS(fs);

  if (shouldPreloadEditorLibraries(urlModeResult.mode)) {
    markPerf('osc:libraries-preload-start');
    await preloadEditorLibraries();
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
    persistedState = readPersistedState(bfs);
    statePersister = {
      set: async (state) => writePersistedState(bfs, state),
    };
  } else {
    persistedState = await readStateFromFragment();
    statePersister = { set: writeStateInFragment };
  }

  const initialState = createInitialState(persistedState);

  // Create and register model — init() is called lazily by the shell elements
  const model = new Model(fs, initialState, undefined, statePersister);
  setModel(model);

  // The shell module download was started at the top of bootstrap; awaiting it
  // here guarantees the custom element is defined before it is created/upgraded.
  await shellModule;
  if (urlModeResult.mode === 'customizer') {
    const shell = document.createElement('osc-customizer-shell') as HTMLElement & {
      urlParams: typeof urlModeResult;
    };
    shell.style.cssText = 'display:flex;flex:1;width:100%;height:100%;';
    shell.urlParams = urlModeResult;
    rootEl.appendChild(shell);
  } else if (urlModeResult.mode === 'embed') {
    const shell = document.createElement('osc-embed-shell') as HTMLElement & {
      urlParams: typeof urlModeResult;
    };
    shell.style.cssText = 'display:flex;flex:1;width:100%;height:100%;';
    shell.urlParams = urlModeResult;
    rootEl.appendChild(shell);
  } else {
    const shell = document.createElement('osc-app-shell');
    shell.style.cssText = 'display:flex;flex:1;width:100%;height:100%;';
    rootEl.appendChild(shell);
    // Normal app mode: call init after mounting
    model.init();
  }

  markPerf('osc:app-shell-mounted');
  measurePerf('osc:app-bootstrap', 'osc:app-bootstrap-start', 'osc:app-shell-mounted');
});
