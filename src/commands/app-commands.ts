// Named application commands, decoupled from their keyboard bindings. The UI
// invokes commands by intent; hosts (the app shell today) map shortcuts onto
// them. This keeps key handling out of the components that perform the actions.
import type { Model } from '../state/model.ts';

export interface CommandKeybinding {
  /** KeyboardEvent.key value, e.g. 'F5' or 's'. */
  key: string;
  /** Require Ctrl (or Cmd on macOS). */
  ctrlOrMeta?: boolean;
}

export interface AppCommand {
  id: string;
  title: string;
  keybinding?: CommandKeybinding;
  run: () => void;
}

export function createAppCommands(model: Model): AppCommand[] {
  return [
    {
      id: 'render.preview',
      title: 'Preview',
      keybinding: { key: 'F5' },
      run: () => model.render({ isPreview: true, now: true }),
    },
    {
      id: 'render.full',
      title: 'Render',
      keybinding: { key: 'F6' },
      run: () => model.render({ isPreview: false, now: true }),
    },
    {
      id: 'export',
      title: 'Export',
      keybinding: { key: 'F7' },
      run: () => model.export(),
    },
    {
      id: 'project.save',
      title: 'Save project',
      keybinding: { key: 's', ctrlOrMeta: true },
      run: () => model.saveProject(),
    },
  ];
}

/** Find the command whose keybinding matches the event, if any. */
export function matchKeybinding(
  commands: AppCommand[],
  e: { key: string; ctrlKey: boolean; metaKey: boolean },
): AppCommand | undefined {
  return commands.find((c) => {
    if (!c.keybinding || c.keybinding.key !== e.key) return false;
    return c.keybinding.ctrlOrMeta ? e.ctrlKey || e.metaKey : true;
  });
}
