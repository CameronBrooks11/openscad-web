// Regression guard for BUG-4b — labeled enum dropdown reverts to spinbox on re-parse.
//
// The bug: after a source edit, checkSyntax re-runs and rebuilds the ParameterSet.
// If the pipeline strips `options: [{name, value}, ...]` from a NumberParameter,
// CustomizerPanel renders a plain spinbox instead of a labeled dropdown.
//
// This test suite guards the data path:
//   actions.ts: JSON.parse(openscadOutput) → ParameterSet
//   model.ts:   mutate(s => s.parameterSet = checkerRun.parameterSet)
// confirming that options survive the full JS-side pipeline, including a simulated
// re-parse (two successive stores).

import { Model } from '../state/model.ts';
import { State } from '../state/app-state.ts';
import { ParameterSet, NumberParameter } from '../state/customizer-types.ts';

// Minimal valid State — no window.matchMedia dependency
const minimalState: State = {
  params: {
    activePath: '/test.scad',
    sources: [{ path: '/test.scad', content: 'myChoice = 2; // [0:No, 2:Yes]' }],
    features: [],
    exportFormat2D: 'svg',
    exportFormat3D: 'stl',
  },
  view: {
    layout: { mode: 'multi' as const, editor: true, viewer: true, customizer: false },
    color: '#f9d72c',
  },
};

// A ParameterSet that includes enum options — the data OpenSCAD WASM outputs
// for a parameter annotated with `// [0:No, 2:Yes]`.
const enumParamSet: ParameterSet = {
  title: 'Parameters',
  parameters: [
    {
      type: 'number',
      name: 'myChoice',
      caption: 'My Choice',
      group: 'Parameters',
      initial: 2,
      options: [
        { name: 'No', value: 0 },
        { name: 'Yes', value: 2 },
      ],
    } as NumberParameter,
  ],
};

describe('BUG-4b — enum parameter options survive the model update path', () => {
  it('options are intact after first store via model.mutate', () => {
    const model = new Model({} as unknown as FS, minimalState, jest.fn());
    model.mutate(s => { s.parameterSet = enumParamSet; });
    expect((model.state.parameterSet?.parameters[0] as NumberParameter).options).toEqual(
      (enumParamSet.parameters[0] as NumberParameter).options,
    );
  });

  it('options survive two successive stores (simulates source-edit re-parse)', () => {
    const model = new Model({} as unknown as FS, minimalState, jest.fn());
    model.mutate(s => { s.parameterSet = enumParamSet; });
    // Second parse — would happen after user edits source and checkSyntax re-runs
    model.mutate(s => { s.parameterSet = enumParamSet; });
    expect((model.state.parameterSet?.parameters[0] as NumberParameter).options).toEqual(
      (enumParamSet.parameters[0] as NumberParameter).options,
    );
  });

  it('options survive JSON serialisation round-trip (mirrors actions.ts JSON.parse path)', () => {
    // Simulate: parameterSet = JSON.parse(openscadOutputContent)
    const fromJson: ParameterSet = JSON.parse(JSON.stringify(enumParamSet));
    const model = new Model({} as unknown as FS, minimalState, jest.fn());
    model.mutate(s => { s.parameterSet = fromJson; });
    expect((model.state.parameterSet?.parameters[0] as NumberParameter).options).toEqual(
      (enumParamSet.parameters[0] as NumberParameter).options,
    );
  });
});
