import type { MultiLayoutComponentId, SingleLayoutComponentId } from '../app-state.ts';
import type { ServiceContext } from './service-context.ts';

/**
 * Owns view-layout state: single/multi mode, per-panel visibility, focus, and
 * the logs panel. Pure view-state transitions through the shared context — no
 * compile, persistence, or DOM coupling.
 */
export class LayoutController {
  constructor(private ctx: ServiceContext) {}

  setLogsVisible(value: boolean) {
    if (value) {
      if (this.ctx.getState().view.layout.mode === 'single') {
        this.changeSingleVisibility('editor');
      } else {
        this.changeMultiVisibility('editor', true);
      }
    }
    this.ctx.mutate((s) => (s.view.logs = value));
  }

  isComponentFullyVisible(id: SingleLayoutComponentId) {
    const layout = this.ctx.getState().view.layout;
    if (layout.mode === 'multi') {
      return layout[id];
    } else {
      return layout.focus === id;
    }
  }

  changeLayout(mode: 'multi' | 'single') {
    if (this.ctx.getState().view.layout.mode === mode) return;
    this.ctx.mutate((s) => {
      s.view.layout =
        s.view.layout.mode === 'multi'
          ? {
              mode: 'single',
              focus: s.view.layout.editor
                ? 'editor'
                : s.view.layout.viewer
                  ? 'viewer'
                  : 'customizer',
            }
          : {
              mode: 'multi',
              editor: s.view.layout.focus === 'editor',
              viewer: s.view.layout.focus === 'viewer',
              customizer: s.view.layout.focus === 'customizer',
            };
    });
  }

  changeSingleVisibility(focus: SingleLayoutComponentId) {
    this.ctx.mutate((s) => {
      if (s.view.layout.mode !== 'single') throw new Error('Wrong mode');
      s.view.layout.focus = focus;
      if (focus !== 'editor') {
        s.view.logs = false;
      }
    });
  }

  changeMultiVisibility(target: MultiLayoutComponentId, visible: boolean) {
    this.ctx.mutate((s) => {
      if (s.view.layout.mode !== 'multi') throw new Error('Wrong mode');
      s.view.layout[target] = visible;
      if (
        (s.view.layout.customizer ? 1 : 0) +
          (s.view.layout.editor ? 1 : 0) +
          (s.view.layout.viewer ? 1 : 0) ==
        0
      ) {
        // Select at least one panel
        s.view.layout[target] = !visible;
        if (target === 'editor' && !visible) {
          s.view.logs = false;
        }
      }
    });
  }
}
