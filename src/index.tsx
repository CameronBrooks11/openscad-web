// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import React from 'react';
import ReactDOM from 'react-dom/client';
import {App} from './components/App.tsx';
import { CustomizerShell } from './components/CustomizerShell.tsx';
import { EmbedShell } from './components/EmbedShell.tsx';
import { createEditorFS, preloadAllLibraries } from './fs/filesystem.ts';
import { registerOpenSCADLanguage } from './language/openscad-register-language.ts';
import { zipArchives } from './fs/zip-archives.generated.ts';
import {readStateFromFragment} from './state/fragment-state.ts'
import { createInitialState } from './state/initial-state.ts';
import { parseUrlMode } from './state/url-mode.ts';
import './index.css';

import debug from 'debug';
import { isInStandaloneMode, registerCustomAppHeightCSSProperty } from './utils.ts';
import { State, StatePersister } from './state/app-state.ts';
import { writeStateInFragment } from "./state/fragment-state.ts";

import "primereact/resources/themes/lara-light-indigo/theme.css";
import "primereact/resources/primereact.min.css";
import "primeicons/primeicons.css";
import "primeflex/primeflex.min.css";

class AppErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'monospace', color: 'red' }}>
          <h2>Something went wrong.</h2>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const log = debug('app:log');

if (process.env.NODE_ENV !== 'production') {
  debug.enable('*');
  log('Logging is enabled!');
} else {
  debug.disable();
}

declare let BrowserFS: BrowserFSInterface


window.addEventListener('load', async () => {
  //*
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
                          // Reload to activate the service worker and apply caching
                          window.location.reload();
                          return;
                      }
                  };
                }
            };
        } catch (err) {
            console.log('ServiceWorker registration failed: ', err);
        }
    }
  }
  //*/
  
  registerCustomAppHeightCSSProperty();

  const fs = await createEditorFS({ allowPersistence: isInStandaloneMode() });

  // Pre-load all library ZIPs so FilePicker and code completion work immediately
  await preloadAllLibraries();

  await registerOpenSCADLanguage(fs, '/libraries', zipArchives);

  let statePersister: StatePersister;
  let persistedState: State | null = null;

  if (isInStandaloneMode()) {
    const fs: FS = BrowserFS.BFSRequire('fs')
    try {
      const data = JSON.parse(new TextDecoder("utf-8").decode(fs.readFileSync('/home/state.json')));
      const {view, params} = data
      persistedState = {view, params};
    } catch (e) {
      console.log('Failed to read the persisted state from local storage.', e)
    }
    statePersister = {
      set: async ({view, params}) => {
      fs.writeFile('/home/state.json', JSON.stringify({view, params}));
      }
    };
  } else {
    persistedState = await readStateFromFragment();
    statePersister = {
      set: writeStateInFragment,
    };
  }

  const initialState = createInitialState(persistedState);

  // Parse URL mode params and route to the correct shell component.
  const urlModeResult = parseUrlMode(window.location.search);

  let rootElement: React.ReactElement;
  if ('error' in urlModeResult) {
    rootElement = (
      <div style={{ padding: '2rem', fontFamily: 'monospace', color: 'red' }}>
        <h2>Invalid URL parameters</h2>
        <pre>{urlModeResult.error}</pre>
      </div>
    );
  } else if (urlModeResult.mode === 'customizer') {
    rootElement = (
      <CustomizerShell
        initialState={initialState}
        statePersister={statePersister}
        fs={fs}
        urlParams={urlModeResult}
      />
    );
  } else if (urlModeResult.mode === 'embed') {
    rootElement = (
      <EmbedShell
        initialState={initialState}
        statePersister={statePersister}
        fs={fs}
        urlParams={urlModeResult}
      />
    );
  } else {
    rootElement = (
      <App initialState={initialState} statePersister={statePersister} fs={fs} />
    );
  }

  const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
  );
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        {rootElement}
      </AppErrorBoundary>
    </React.StrictMode>
  );
});

