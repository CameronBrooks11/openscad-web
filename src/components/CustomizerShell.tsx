// CustomizerShell — minimal viewer + customizer panel for ?mode=customizer URLs.
// No Monaco editor, no file toolbar, no export format selector.

import React, { useEffect, useRef, useState } from 'react';
import { Model } from '../state/model.ts';
import { State, StatePersister } from '../state/app-state.ts';
import { UrlModeParams, fetchExternalModel } from '../state/url-mode.ts';
import { ModelContext, FSContext } from './contexts.ts';
import ViewerPanel from './ViewerPanel.tsx';
import CustomizerPanel from './CustomizerPanel.tsx';

export function CustomizerShell({
  initialState,
  statePersister,
  fs,
  urlParams,
}: {
  initialState: State;
  statePersister: StatePersister;
  fs: FS;
  urlParams: UrlModeParams;
}) {
  const [state, setState] = useState(initialState);
  const [loadError, setLoadError] = useState<string | null>(null);

  const modelRef = useRef<Model | null>(null);
  if (!modelRef.current) {
    modelRef.current = new Model(fs, state, setState, statePersister);
  }
  const model = modelRef.current;

  useEffect(() => {
    model.init();
  }, [model]);

  // Apply view overrides from URL params.
  useEffect(() => {
    const overrides = urlParams.viewOverrides;
    if (Object.keys(overrides).length === 0) return;
    model.mutate(s => {
      if (overrides.showAxes !== undefined) s.view.showAxes = overrides.showAxes;
      if (overrides.color !== undefined) s.view.color = overrides.color!;
      if (overrides.lineNumbers !== undefined) s.view.lineNumbers = overrides.lineNumbers;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load external/relative model from URL if provided.
  useEffect(() => {
    if (!urlParams.modelUrl) return;
    (async () => {
      const result = await fetchExternalModel(urlParams.modelUrl!);
      if (typeof result === 'object' && 'error' in result) {
        setLoadError(result.error);
        return;
      }
      // Apply pre-populated vars from URL before first compile.
      const preVars = urlParams.prePopulatedVars;
      if (Object.keys(preVars).length > 0) {
        model.mutate(s => {
          s.params.vars = { ...(s.params.vars ?? {}), ...preVars };
        });
      }
      model.source = result;
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div className="customizer-shell flex flex-column align-items-center justify-content-center" style={{ flex: 1, padding: '2rem' }}>
        <p style={{ color: 'red' }}>Failed to load model: {loadError}</p>
      </div>
    );
  }

  return (
    <ModelContext.Provider value={model}>
      <FSContext.Provider value={fs}>
        <div className="customizer-shell flex flex-row" style={{ flex: 1 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <ViewerPanel className="absolute-fill" style={{ flex: 1 }} />
          </div>
          <CustomizerPanel style={{ width: '280px', minWidth: '220px' }} />
        </div>
        <div style={{ padding: '4px 8px', fontSize: '0.8em', background: 'rgba(0,0,0,0.05)' }}>
          <a href={window.location.href.replace(/[?&]mode=customizer/, '')} target="_blank" rel="noreferrer">
            View in Editor
          </a>
        </div>
      </FSContext.Provider>
    </ModelContext.Provider>
  );
}
