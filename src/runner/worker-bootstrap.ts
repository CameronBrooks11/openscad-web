import openSCADWorkerUrl from './openscad-worker.ts?worker&url';

export function createOpenSCADWorker(): Worker {
  return new Worker(new URL('./openscad-worker.ts', import.meta.url), { type: 'module' });
}

export { openSCADWorkerUrl };
