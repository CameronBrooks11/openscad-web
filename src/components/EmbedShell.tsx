// EmbedShell — minimal viewer for ?mode=embed URLs.
// Supports optional customizer controls and download button, plus a postMessage API.

import React, { useEffect, useRef, useState } from 'react';
import { Model } from '../state/model.ts';
import { State, StatePersister } from '../state/app-state.ts';
import { UrlModeParams, fetchExternalModel } from '../state/url-mode.ts';
import { ModelContext, FSContext } from './contexts.ts';
import ViewerPanel from './ViewerPanel.tsx';
import CustomizerPanel from './CustomizerPanel.tsx';

// ---------------------------------------------------------------------------
// postMessage protocol (host → iframe)
// ---------------------------------------------------------------------------
type SetModelMsg  = { type: 'setModel';  source: string };
type SetVarMsg    = { type: 'setVar';    name: string; value: unknown };
type InboundMsg   = SetModelMsg | SetVarMsg;

// ---------------------------------------------------------------------------
// postMessage protocol (iframe → host)
// ---------------------------------------------------------------------------
function notifyHost(type: string, payload?: Record<string, unknown>) {
  // Only post to a parent — guard against same-origin abuse by using '*'
  // intentionally (no secrets are embedded; model content is already visible).
  if (window.parent !== window) {
    window.parent.postMessage({ type, ...payload }, '*');
  }
}

export function EmbedShell({
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
        notifyHost('stateChange', { error: result.error });
        return;
      }
      const preVars = urlParams.prePopulatedVars;
      if (Object.keys(preVars).length > 0) {
        model.mutate(s => {
          s.params.vars = { ...(s.params.vars ?? {}), ...preVars };
        });
      }
      model.source = result;
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify host when render completes.
  useEffect(() => {
    if (state.output && !state.rendering && !state.previewing) {
      notifyHost('renderComplete', { outFileURL: state.output.outFileURL });
    }
  }, [state.output, state.rendering, state.previewing]);

  // postMessage API (inbound from host).
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin: only accept messages from the parent frame's origin.
      // When host is same-origin, event.origin matches. For cross-origin embeds,
      // there is no shared secret so we accept all origins but only permit safe ops.
      if (event.source !== window.parent) return;

      const msg = event.data as InboundMsg;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'setModel') {
        const m = msg as SetModelMsg;
        if (typeof m.source === 'string') {
          model.source = m.source;
        }
      } else if (msg.type === 'setVar') {
        const m = msg as SetVarMsg;
        if (typeof m.name === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          model.setVar(m.name, m.value as any);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [model]);

  if (loadError) {
    return (
      <div className="embed-shell flex flex-column align-items-center justify-content-center" style={{ flex: 1, padding: '2rem' }}>
        <p style={{ color: 'red' }}>Failed to load model: {loadError}</p>
      </div>
    );
  }

  return (
    <ModelContext.Provider value={model}>
      <FSContext.Provider value={fs}>
        <div className="embed-shell flex flex-column" style={{ flex: 1 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <ViewerPanel className="absolute-fill" style={{ flex: 1 }} />
          </div>
          {urlParams.embedControls && (
            <CustomizerPanel style={{ maxHeight: '40vh' }} />
          )}
          {urlParams.embedDownload && (
            <div style={{ padding: '4px 8px' }}>
              <button
                onClick={() => model.export()}
                style={{ cursor: 'pointer' }}
              >
                Download STL
              </button>
            </div>
          )}
        </div>
      </FSContext.Provider>
    </ModelContext.Provider>
  );
}
