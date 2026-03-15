import openSCADWorkerUrl from './openscad-worker.ts?worker&url';

export function createOpenSCADWorker(): Worker {
  return new Worker(openSCADWorkerUrl, { type: 'module' });
}

export { openSCADWorkerUrl };
