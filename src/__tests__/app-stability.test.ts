// app-stability.test.ts — Guards the Phase 6 Lit migration foundations.
// Verifies model singleton pattern and EventTarget state emission.
import { Model } from '../state/model.ts';
import { setModel, getModel } from '../state/model-context.ts';
import { State } from '../state/app-state.ts';

const minimalState: State = {
  params: {
    activePath: '/test.scad',
    sources: [{ path: '/test.scad', content: 'cube(10);' }],
    features: [],
    exportFormat2D: 'svg',
    exportFormat3D: 'stl',
  },
  view: {
    layout: { mode: 'multi' as const, editor: true, viewer: true, customizer: false },
    color: '#f9d72c',
  },
};

/**
 * Test Gate 1 — Model singleton (replaces the useRef test from the React era).
 *
 * Verifies that setModel/getModel provide a stable singleton reference,
 * mirroring the stability guarantee that useRef gave in App.tsx.
 */
describe('Model singleton via setModel/getModel', () => {
  it('getModel returns the exact instance registered via setModel', () => {
    const model = new Model({} as unknown as FS, minimalState);
    setModel(model);
    expect(getModel()).toBe(model);
  });

  it('getModel returns same instance on repeated calls', () => {
    const model = new Model({} as unknown as FS, minimalState);
    setModel(model);
    expect(getModel()).toBe(getModel());
  });
});

/**
 * Test Gate 2 — EventTarget state emission (Phase 6 core guarantee).
 *
 * Confirms that Model extends EventTarget and dispatches a CustomEvent<State>
 * named 'state' on every mutation. Lit components subscribe to this event
 * instead of relying on React setState.
 */
describe('Model EventTarget state emission', () => {
  it('Model is an instance of EventTarget', () => {
    const model = new Model({} as unknown as FS, minimalState);
    expect(model).toBeInstanceOf(EventTarget);
  });

  it('dispatches a "state" CustomEvent on mutate()', () => {
    const model = new Model({} as unknown as FS, minimalState);
    const receivedStates: State[] = [];
    model.addEventListener('state', (e) => {
      receivedStates.push((e as CustomEvent<State>).detail);
    });

    const changed = model.mutate((s) => {
      s.view.color = '#ff0000';
    });
    expect(changed).toBe(true);
    expect(receivedStates).toHaveLength(1);
    expect(receivedStates[0].view.color).toBe('#ff0000');
  });

  it('does not dispatch when mutation produces no change', () => {
    const model = new Model({} as unknown as FS, { ...minimalState });
    const receivedStates: State[] = [];
    model.addEventListener('state', (e) => {
      receivedStates.push((e as CustomEvent<State>).detail);
    });

    // Mutation that sets the same value — should not dispatch
    const changed = model.mutate((s) => {
      s.view.color = minimalState.view.color;
    });
    expect(changed).toBe(false);
    expect(receivedStates).toHaveLength(0);
  });

  it('event detail is the new state object', () => {
    const model = new Model({} as unknown as FS, minimalState);
    let capturedState: State | null = null;
    model.addEventListener('state', (e) => {
      capturedState = (e as CustomEvent<State>).detail;
    });

    model.mutate((s) => {
      s.view.showAxes = true;
    });
    expect(capturedState).not.toBeNull();
    expect(capturedState!.view.showAxes).toBe(true);
    // event detail IS the new model.state
    expect(capturedState).toBe(model.state);
  });
});
