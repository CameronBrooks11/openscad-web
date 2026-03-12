// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { CSSProperties, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ModelContext } from './contexts.ts';
import { Toast } from 'primereact/toast';
import { blurHashToImage, imageToBlurhash, thumbHashToImage } from '../io/image_hashes.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "model-viewer": any;
    }
  }
}

export const PREDEFINED_ORBITS: [string, number, number][] = [
  ["Diagonal", Math.PI / 4, Math.PI / 4],
  ["Front", 0, Math.PI / 2],
  ["Right", Math.PI / 2, Math.PI / 2],
  ["Back", Math.PI, Math.PI / 2],
  ["Left", -Math.PI / 2, Math.PI / 2],
  ["Top", 0, 0],
  ["Bottom", 0, Math.PI],
];

function spherePoint(theta: number, phi: number): [number, number, number] {
  return [
    Math.cos(theta) * Math.sin(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(phi),
  ];
}

function euclideanDist(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
const radDist = (a: number, b: number) => Math.min(Math.abs(a - b), Math.abs(a - b + 2 * Math.PI), Math.abs(a - b - 2 * Math.PI));

function getClosestPredefinedOrbitIndex(theta: number, phi: number): [number, number, number] {
  const point = spherePoint(theta, phi);
  const points = PREDEFINED_ORBITS.map(([_, t, p]) => spherePoint(t, p));
  const distances = points.map(p => euclideanDist(point, p));
  const radDistances = PREDEFINED_ORBITS.map(([_, ptheta, pphi]) => Math.max(radDist(theta, ptheta), radDist(phi, pphi)));
  const [index, dist] = distances.reduce((acc, d, i) => d < acc[1] ? [i, d] : acc, [0, Infinity]) as [number, number];
  return [index, dist, radDistances[index]];
}

const originalOrbit = (([_name, theta, phi]) => `${theta}rad ${phi}rad auto`)(PREDEFINED_ORBITS[0]);

export default function ViewerPanel({className, style}: {className?: string, style?: CSSProperties}) {
  const model = useContext(ModelContext);
  if (!model) throw new Error('No model');

  const state = model.state;
  const [interactionPrompt, setInteractionPrompt] = useState('auto');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [modelViewerNode, setModelViewerNode] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [axesViewerNode, setAxesViewerNode] = useState<any>(null);
  const toastRef = useRef<Toast>(null);

  const [loadedUri, setLoadedUri] = useState<string | undefined>();

  const [cachedImageHash, setCachedImageHash] = useState<{hash: string, uri: string} | undefined>(undefined);

  const modelUri = state.output?.displayFileURL ?? state.output?.outFileURL ?? '';
  const loaded = loadedUri === modelUri;

  // Sync preview image hash with state
  useEffect(() => {
    setCachedImageHash(current => {
      if (state?.preview?.blurhash) {
        return current?.hash === state.preview.blurhash ? current
          : { hash: state.preview.blurhash, uri: blurHashToImage(state.preview.blurhash, 100, 100) };
      } else if (state?.preview?.thumbhash) {
        return current?.hash === state.preview.thumbhash ? current
          : { hash: state.preview.thumbhash, uri: thumbHashToImage(state.preview.thumbhash) };
      }
      return current ? undefined : current;
    });
  }, [state?.preview?.blurhash, state?.preview?.thumbhash]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onLoad = useCallback(async (_e: any) => {
    setLoadedUri(modelUri);

    if (!modelViewerNode) return;

    const uri = await modelViewerNode.toDataURL('image/png', 0.5);
    const preview = {blurhash: await imageToBlurhash(uri)};
    model?.mutate(s => s.preview = preview);
  }, [model, modelUri, modelViewerNode]);

  useEffect(() => {
    if (!modelViewerNode) return;

    modelViewerNode.addEventListener('load', onLoad);
    return () => modelViewerNode.removeEventListener('load', onLoad);
  }, [modelViewerNode, onLoad]);


  // Sync camera orbit between model viewer and axes viewer
  useEffect(() => {
    if (!modelViewerNode) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function handleCameraChange(e: any) {
      if (!axesViewerNode) return;
      if (e.detail.source === 'user-interaction') {
        const cameraOrbit = modelViewerNode.getCameraOrbit();
        cameraOrbit.radius = axesViewerNode.getCameraOrbit().radius;
        axesViewerNode.cameraOrbit = cameraOrbit.toString();
      }
    }
    modelViewerNode.addEventListener('camera-change', handleCameraChange);
    return () => modelViewerNode.removeEventListener('camera-change', handleCameraChange);
  }, [modelViewerNode, axesViewerNode]);

  useEffect(() => {
    if (!axesViewerNode) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function handleCameraChange(e: any) {
      if (!modelViewerNode) return;
      if (e.detail.source === 'user-interaction') {
        const cameraOrbit = axesViewerNode.getCameraOrbit();
        cameraOrbit.radius = modelViewerNode.getCameraOrbit().radius;
        modelViewerNode.cameraOrbit = cameraOrbit.toString();
      }
    }
    axesViewerNode.addEventListener('camera-change', handleCameraChange);
    return () => axesViewerNode.removeEventListener('camera-change', handleCameraChange);
  }, [axesViewerNode, modelViewerNode]);

  // Cycle through predefined views when user clicks on the axes viewer
  useEffect(() => {
    if (!axesViewerNode || !modelViewerNode) return;
    let mouseDownSpherePoint: [number, number, number] | undefined;
    function getSpherePoint() {
      const orbit = axesViewerNode.getCameraOrbit();
      return spherePoint(orbit.theta, orbit.phi);
    }
    function onMouseDown(e: MouseEvent) {
      if (e.target === axesViewerNode) {
        mouseDownSpherePoint = getSpherePoint();
      }
    }
    function onMouseUp(e: MouseEvent) {
      if (e.target === axesViewerNode) {
        const euclEps = 0.01;
        const radEps = 0.1;

        const spherePoint = getSpherePoint();
        const clickDist = mouseDownSpherePoint ? euclideanDist(spherePoint, mouseDownSpherePoint) : Infinity;
        if (clickDist > euclEps) {
          return;
        }
        // Note: unlike the axes viewer, the model viewer has a prompt that makes the model wiggle around, we only fetch it to get the radius.
        const axesOrbit = axesViewerNode.getCameraOrbit();
        const modelOrbit = modelViewerNode.getCameraOrbit();
        const [currentIndex, dist, radDist] = getClosestPredefinedOrbitIndex(axesOrbit.theta, axesOrbit.phi);
        const newIndex = dist < euclEps && radDist < radEps ? (currentIndex + 1) % PREDEFINED_ORBITS.length : currentIndex;
        const [name, theta, phi] = PREDEFINED_ORBITS[newIndex];
        Object.assign(modelOrbit, {theta, phi});
        modelViewerNode.cameraOrbit = axesViewerNode.cameraOrbit = modelOrbit.toString();
        toastRef.current?.show({severity: 'info', detail: `${name} view`, life: 1000,});
        setInteractionPrompt('none');
      }
    }
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [axesViewerNode, modelViewerNode]);

  return (
    <div className={className}
          style={{
              display: 'flex',
              flexDirection: 'column', 
              position: 'relative',
              flex: 1, 
              width: '100%',
              ...(style ?? {})
          }}>
      <Toast ref={toastRef} position='top-right'  />
      <style>
        {`
          @keyframes pulse {
            0% { opacity: 0.4; }
            50% { opacity: 0.7; }
            100% { opacity: 0.4; }
          }
        `}
      </style>

      {!loaded && cachedImageHash && 
        <img
        src={cachedImageHash.uri}
        style={{
          animation: 'pulse 1.5s ease-in-out infinite',
          position: 'absolute',
          pointerEvents: 'none',
          width: '100%',
          height: '100%'
        }} />
      }

      <model-viewer
        orientation="0deg -90deg 0deg"
        class="main-viewer"
        src={modelUri}
        style={{
          transition: 'opacity 0.5s',
          opacity: loaded ? 1 : 0,
          position: 'absolute',
          width: '100%',
          height: '100%',
        }}
        camera-orbit={originalOrbit}
        interaction-prompt={interactionPrompt}
        environment-image="./skybox-lights.jpg"
        max-camera-orbit="auto 180deg auto"
        min-camera-orbit="auto 0deg auto"
        camera-controls
        ar
        ref={setModelViewerNode}
      >
        <span slot="progress-bar"></span>
      </model-viewer>
      {state.view.showAxes && (
        <model-viewer
                orientation="0deg -90deg 0deg"
                src="./axes.glb"
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  zIndex: 10,
                  height: '100px',
                  width: '100px',
                }}
                loading="eager"
                camera-orbit={originalOrbit}
                // interpolation-decay="0"
                environment-image="./skybox-lights.jpg"
                max-camera-orbit="auto 180deg auto"
                min-camera-orbit="auto 0deg auto"
                orbit-sensitivity="5"
                interaction-prompt="none"
                camera-controls="false"
                disable-zoom
                disable-tap 
                disable-pan
                ref={setAxesViewerNode}
        >
          <span slot="progress-bar"></span>
        </model-viewer>
      )}
    </div>
  )
}
