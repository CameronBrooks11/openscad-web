import { describe, expect, it } from 'vitest';

import type { State } from '../../app-state.ts';
import { bubbleUpDeepMutations } from '../../deep-mutate.ts';
import { LayoutController } from '../layout-controller.ts';
import type { ServiceContext } from '../service-context.ts';

function makeCtx(layout: State['view']['layout'], logs = false) {
  let state: State = {
    params: {
      activePath: '/a.scad',
      sources: [{ kind: 'text', path: '/a.scad', content: '' }],
      features: [],
      exportFormat2D: 'svg',
      exportFormat3D: 'off',
    },
    view: { layout, color: '#000', logs },
  };
  const ctx: ServiceContext = {
    getState: () => state,
    mutate: (f) => {
      const next = bubbleUpDeepMutations(state, f);
      const changed = next !== state;
      state = next;
      return changed;
    },
    getSourceRevision: () => 0,
    getActiveSource: () => '',
    host: {
      createObjectURL: () => '',
      revokeObjectURL: () => {},
      download: () => {},
      downloadBlob: () => {},
      playCompletionChime: () => {},
      baseUrl: () => '',
    },
    fs: { readFileSync: () => new Uint8Array(), writeFile: () => {} },
    backend: { spawn: () => ({}) as never, cancel: () => {}, dispose: () => {} },
  };
  return { ctx, getState: () => state };
}

const multi = (over: Partial<{ editor: boolean; viewer: boolean; customizer: boolean }> = {}) =>
  ({
    mode: 'multi',
    editor: true,
    viewer: true,
    customizer: false,
    ...over,
  }) as State['view']['layout'];

describe('LayoutController', () => {
  it('isComponentFullyVisible reflects per-panel flags in multi and focus in single', () => {
    expect(
      new LayoutController(makeCtx(multi({ viewer: false })).ctx).isComponentFullyVisible('viewer'),
    ).toBe(false);
    const single = { mode: 'single', focus: 'editor' } as State['view']['layout'];
    expect(new LayoutController(makeCtx(single).ctx).isComponentFullyVisible('editor')).toBe(true);
    expect(new LayoutController(makeCtx(single).ctx).isComponentFullyVisible('viewer')).toBe(false);
  });

  it('changeLayout maps multi→single focus to the first visible panel', () => {
    const { ctx, getState } = makeCtx(multi({ editor: false, viewer: true }));
    new LayoutController(ctx).changeLayout('single');
    expect(getState().view.layout).toEqual({ mode: 'single', focus: 'viewer' });
  });

  it('changeLayout maps single→multi visibility from focus', () => {
    const { ctx, getState } = makeCtx({
      mode: 'single',
      focus: 'customizer',
    } as State['view']['layout']);
    new LayoutController(ctx).changeLayout('multi');
    expect(getState().view.layout).toEqual({
      mode: 'multi',
      editor: false,
      viewer: false,
      customizer: true,
    });
  });

  it('changeMultiVisibility keeps at least one panel visible', () => {
    const { ctx, getState } = makeCtx(multi({ editor: true, viewer: false, customizer: false }));
    new LayoutController(ctx).changeMultiVisibility('editor', false);
    // Hiding the last visible panel is reverted.
    const l = getState().view.layout as { editor: boolean };
    expect(l.editor).toBe(true);
  });

  it('changeSingleVisibility clears logs when focusing a non-editor panel', () => {
    const { ctx, getState } = makeCtx(
      { mode: 'single', focus: 'editor' } as State['view']['layout'],
      true,
    );
    new LayoutController(ctx).changeSingleVisibility('viewer');
    expect(getState().view.logs).toBe(false);
  });

  it('setLogsVisible reveals the editor first in single mode', () => {
    const { ctx, getState } = makeCtx({
      mode: 'single',
      focus: 'viewer',
    } as State['view']['layout']);
    new LayoutController(ctx).setLogsVisible(true);
    expect((getState().view.layout as { focus: string }).focus).toBe('editor');
    expect(getState().view.logs).toBe(true);
  });
});
