// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import React, { CSSProperties, useContext, useEffect, useRef } from 'react';
import { ModelContext } from './contexts.ts';
import { Toast } from 'primereact/toast';
import { blurHashToImage, imageToThumbhash, thumbHashToImage } from '../io/image_hashes.ts';
import { ThreeScene, NAMED_POSITIONS } from './viewer/ThreeScene.ts';
import { offToBufferGeometry } from './viewer/off-loader.ts';
import { parseOff } from '../io/import_off.ts';

export default function ViewerPanel({ className, style }: { className?: string; style?: CSSProperties }) {
  const model = useContext(ModelContext);
  if (!model) throw new Error('No model');
  const state = model.state;

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ThreeScene | null>(null);
  const toastRef = useRef<Toast>(null);

  // -------------------------------------------------------------------------
  // Mount / unmount Three.js renderer
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new ThreeScene(container);
    sceneRef.current = scene;

    // Restore persisted camera
    if (state.view.camera) {
      scene.applyCameraState(state.view.camera);
    }

    // Persist camera on change (debounced inside ThreeScene)
    scene.onCameraChange = (camState) => {
      model.mutate(s => { s.view.camera = camState; });
    };

    // Set initial axes visibility
    scene.setAxesVisible(!!state.view.showAxes);

    scene.start();

    // ResizeObserver keeps canvas size in sync with container
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        scene.resize(width, height);
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Load geometry from OFF output whenever state.output changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const outFile = state.output?.outFile;
    if (!outFile || !outFile.name.endsWith('.off')) return;

    (async () => {
      try {
        const text = await outFile.text();
        const data = parseOff(text);
        const geometry = offToBufferGeometry(data);
        scene.loadGeometry(geometry, state.view.color ?? '#f9d72c');

        // Generate thumbhash preview from the rendered canvas
        const dataUrl = scene.renderer.domElement.toDataURL('image/png', 0.5);
        const hash = await imageToThumbhash(dataUrl);
        model.mutate(s => { s.preview = { thumbhash: hash }; });
      } catch (e) {
        console.error('Error loading OFF geometry:', e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.output?.outFile]);

  // -------------------------------------------------------------------------
  // Sync reactive view state → Three.js scene
  // -------------------------------------------------------------------------
  useEffect(() => {
    sceneRef.current?.setAxesVisible(!!state.view.showAxes);
  }, [state.view.showAxes]);

  useEffect(() => {
    if (state.view.color) sceneRef.current?.setModelColor(state.view.color);
  }, [state.view.color]);

  // -------------------------------------------------------------------------
  // Placeholder
  // -------------------------------------------------------------------------
  const placeholderUri = (() => {
    if (state.preview?.blurhash) return blurHashToImage(state.preview.blurhash, 100, 100);
    if (state.preview?.thumbhash) return thumbHashToImage(state.preview.thumbhash);
    return null;
  })();
  const isCompiling = !!(state.rendering || state.previewing);

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        flex: 1,
        width: '100%',
        ...(style ?? {}),
      }}
    >
      <Toast ref={toastRef} position="top-right" />
      <style>{`
        @keyframes pulse {
          0%   { opacity: 0.4; }
          50%  { opacity: 0.7; }
          100% { opacity: 0.4; }
        }
      `}</style>

      {isCompiling && placeholderUri && (
        <img
          src={placeholderUri}
          alt=""
          style={{
            animation: 'pulse 1.5s ease-in-out infinite',
            position: 'absolute',
            pointerEvents: 'none',
            width: '100%',
            height: '100%',
            zIndex: 1,
          }}
        />
      )}

      {/* Three.js renderer canvas is appended here by ThreeScene constructor */}
      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', width: '100%', height: '100%' }}
      />

      {/* Named camera view buttons */}
      <div style={{
        position: 'absolute',
        bottom: 8,
        right: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        zIndex: 2,
      }}>
        {NAMED_POSITIONS.map(({ name }) => (
          <button
            key={name}
            title={`${name} view`}
            onClick={() => {
              sceneRef.current?.setCameraPosition(name);
              toastRef.current?.show({ severity: 'info', detail: `${name} view`, life: 1000 });
            }}
            style={{
              fontSize: '0.65rem',
              padding: '2px 6px',
              cursor: 'pointer',
              opacity: 0.75,
              background: 'rgba(0,0,0,0.5)',
              color: '#fff',
              border: 'none',
              borderRadius: 3,
            }}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}




