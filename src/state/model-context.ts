// Module-level Model singleton — eliminates React context dependency.
// Call setModel() in index.ts before any element is mounted.
// Lit elements call getModel() in connectedCallback.

import { Model } from './model.ts';

let _model: Model | null = null;

export function setModel(m: Model): void {
  _model = m;
}

export function getModel(): Model {
  if (!_model) throw new Error('Model not initialized. Call setModel() before mounting elements.');
  return _model;
}
