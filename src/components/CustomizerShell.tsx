// CustomizerShell — minimal viewer + customizer panel for ?mode=customizer URLs.
// No Monaco editor, no file toolbar, no export format selector.

import React, { useEffect, useRef, useState } from 'react';
import { Model } from '../state/model.ts';
import { State, StatePersister } from '../state/app-state.ts';
import { UrlModeParams, fetchExternalModel } from '../state/url-mode.ts';
import { ModelContext, FSContext } from './contexts.ts';
import ViewerPanel from './ViewerPanel.tsx';
import CustomizerPanel from './CustomizerPanel.tsx';

/** Best-effort coerce URL string values to number / boolean / string. */
function coerceUrlVars(vars: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === 'true') result[k] = true;
    else if (v === 'false') result[k] = false;
    else {
      const n = Number(v);
      result[k] = v.trim() !== '' && !isNaN(n) ? n : v;
    }
  }
  return result;
}

/** Build the equivalent editor-mode URL by removing the mode param cleanly. */
function buildEditorUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('mode');
  return url.toString();
}

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
    // Only run the default init (compiles initial source) when no external
    // model URL is provided.  When a URL is given, fetchExternalModel below
    // will set model.source which triggers processSource itself.
    if (!urlParams.modelUrl) {
      model.init();
    }
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Best-effort type coercion: numbers and booleans must arrive as their
      // native types so formatValue() emits -Dteeth=30 not -Dteeth="30".
      const preVars = urlParams.prePopulatedVars;
      if (Object.keys(preVars).length > 0) {
        model.mutate(s => {
          s.params.vars = { ...(s.params.vars ?? {}), ...coerceUrlVars(preVars) };
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
          <a href={buildEditorUrl()} target="_blank" rel="noreferrer">
            View in Editor
          </a>
        </div>
      </FSContext.Provider>
    </ModelContext.Provider>
  );
}
