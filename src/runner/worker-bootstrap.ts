import { resolveRuntimeAssetUrl } from '../runtime/asset-urls.ts';

export function createOpenSCADWorker(): Worker {
  return new Worker(resolveRuntimeAssetUrl('openscad-worker.js'));
}
