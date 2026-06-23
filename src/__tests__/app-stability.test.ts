// app-stability.test.ts — Guards the Lit migration foundations.
// Verifies the session provider and EventTarget state emission.
import { Model } from '../state/model.ts';
import { provideSession, resolveSession } from '../state/session-context.ts';
import type { OpenScadSession } from '../state/session.ts';
import { State } from '../state/app-state.ts';

const minimalState: State = {
  params: {
    activePath: '/test.scad',
    sources: [{ kind: 'text', path: '/test.scad', content: 'cube(10);' }],
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
 * Test Gate 1 — the session provider (replaces the former getModel singleton).
 *
 * A shell provides its session to its DOM subtree; a descendant resolves the
 * nearest one, and an element mounted outside any provider fails loudly.
 */
describe('session provider (provideSession / resolveSession)', () => {
  it('resolves the session from the nearest provider ancestor', () => {
    const session = { id: 'A' } as unknown as OpenScadSession;
    const host = document.createElement('div');
    const child = document.createElement('span');
    host.appendChild(child);
    document.body.appendChild(host);
    provideSession(host, session);

    expect(resolveSession(child)).toBe(session);
    host.remove();
  });

  it('resolves across a shadow boundary (the customizer/embed shadow shells)', () => {
    // The provider lives on the host; the consumer is in the host's shadow tree.
    // resolveSession uses composed:true so the request escapes the shadow root to
    // reach the host listener — the exact path the shadow-DOM shells rely on.
    const session = { id: 'S' } as unknown as OpenScadSession;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const child = document.createElement('span');
    shadow.appendChild(child);
    provideSession(host, session);

    expect(resolveSession(child)).toBe(session);
    host.remove();
  });

  it('throws when no provider is in the ancestry (no silent default)', () => {
    const orphan = document.createElement('span');
    document.body.appendChild(orphan);
    expect(() => resolveSession(orphan)).toThrow(/No OpenScadSession provider/);
    orphan.remove();
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
