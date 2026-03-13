// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { createEditorFS, preloadAllLibraries } from './fs/filesystem.ts';
import { registerOpenSCADLanguage } from './language/openscad-register-language.ts';
import { zipArchives } from './fs/zip-archives.generated.ts';
import { readStateFromFragment, writeStateInFragment } from './state/fragment-state.ts';
import { createInitialState } from './state/initial-state.ts';
import { parseUrlMode } from './state/url-mode.ts';
import { setModel } from './state/model-context.ts';
import { setFS } from './state/fs-context.ts';
import { Model } from './state/model.ts';
import { isInStandaloneMode, registerCustomAppHeightCSSProperty } from './utils.ts';
import { State, StatePersister } from './state/app-state.ts';
import { markPerf, measurePerf } from './perf/runtime-performance.ts';
import './index.css';
import 'monaco-editor/min/vs/editor/editor.main.css';

import debug from 'debug';

// Import all Lit shell elements so they register themselves
import './components/elements/osc-app-shell.ts';
import './components/elements/osc-embed-shell.ts';
import './components/elements/osc-customizer-shell.ts';

const log = debug('app:log');

if (process.env.NODE_ENV !== 'production') {
  debug.enable('*');
  log('Logging is enabled!');
} else {
  debug.disable();
}

declare let BrowserFS: BrowserFSInterface;

window.addEventListener('load', async () => {
  markPerf('osc:app-bootstrap-start', { standalone: isInStandaloneMode() });

  if (process.env.NODE_ENV === 'production') {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        console.log('ServiceWorker registration successful with scope: ', registration.scope);
        registration.onupdatefound = () => {
          const installingWorker = registration.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                window.location.reload();
              }
            };
          }
        };
      } catch (err) {
        console.log('ServiceWorker registration failed: ', err);
      }
    }
  }

  registerCustomAppHeightCSSProperty();

  markPerf('osc:main-fs-init-start');
  const fs = await createEditorFS({ allowPersistence: isInStandaloneMode() });
  markPerf('osc:main-fs-init-end');
  measurePerf('osc:main-fs-init', 'osc:main-fs-init-start', 'osc:main-fs-init-end');
  setFS(fs);

  markPerf('osc:libraries-preload-start');
  await preloadAllLibraries();
  markPerf('osc:libraries-preload-end');
  measurePerf('osc:libraries-preload', 'osc:libraries-preload-start', 'osc:libraries-preload-end');

  markPerf('osc:language-register-start');
  await registerOpenSCADLanguage(fs, '/libraries', zipArchives);
  markPerf('osc:language-register-end');
  measurePerf('osc:language-register', 'osc:language-register-start', 'osc:language-register-end');

  let statePersister: StatePersister;
  let persistedState: State | null = null;

  if (isInStandaloneMode()) {
    const bfs: FS = BrowserFS.BFSRequire('fs');
    try {
      const data = JSON.parse(
        new TextDecoder('utf-8').decode(bfs.readFileSync('/home/state.json')),
      );
      const { view, params } = data;
      persistedState = { view, params };
    } catch (e) {
      console.log('Failed to read the persisted state from local storage.', e);
    }
    statePersister = {
      set: async ({ view, params }) => {
        bfs.writeFile('/home/state.json', JSON.stringify({ view, params }));
      },
    };
  } else {
    persistedState = await readStateFromFragment();
    statePersister = { set: writeStateInFragment };
  }

  const initialState = createInitialState(persistedState);
  const urlModeResult = parseUrlMode(window.location.search);

  const rootEl = document.getElementById('root')!;

  if ('error' in urlModeResult) {
    markPerf('osc:app-bootstrap-error');
    rootEl.innerHTML = `
      <div style="padding:2rem;font-family:monospace;color:red;">
        <h2>Invalid URL parameters</h2>
        <pre>${urlModeResult.error}</pre>
      </div>`;
    return;
  }

  // Create and register model — init() is called lazily by the shell elements
  const model = new Model(fs, initialState, undefined, statePersister);
  setModel(model);

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
