import { createAppCommands, matchKeybinding } from '../app-commands.ts';
import type { Model } from '../../state/model.ts';

function makeModelStub() {
  return {
    render: vi.fn(),
    export: vi.fn(),
    saveProject: vi.fn(),
  };
}

const ev = (key: string, ctrlKey = false, metaKey = false) => ({ key, ctrlKey, metaKey });

describe('app commands (#64)', () => {
  it('maps F5/F6/F7 to the right command without modifiers', () => {
    const cmds = createAppCommands(makeModelStub() as unknown as Model);
    expect(matchKeybinding(cmds, ev('F5'))?.id).toBe('render.preview');
    expect(matchKeybinding(cmds, ev('F6'))?.id).toBe('render.full');
    expect(matchKeybinding(cmds, ev('F7'))?.id).toBe('export');
  });

  it('requires Ctrl/Cmd for the save command', () => {
    const cmds = createAppCommands(makeModelStub() as unknown as Model);
    expect(matchKeybinding(cmds, ev('s'))).toBeUndefined();
    expect(matchKeybinding(cmds, ev('s', true))?.id).toBe('project.save');
    expect(matchKeybinding(cmds, ev('s', false, true))?.id).toBe('project.save');
  });

  it('returns undefined for an unbound key', () => {
    const cmds = createAppCommands(makeModelStub() as unknown as Model);
    expect(matchKeybinding(cmds, ev('F9'))).toBeUndefined();
    expect(matchKeybinding(cmds, ev('a', true))).toBeUndefined();
  });

  it('commands invoke the matching Model action', () => {
    const model = makeModelStub();
    const cmds = createAppCommands(model as unknown as Model);

    matchKeybinding(cmds, ev('F5'))?.run();
    expect(model.render).toHaveBeenCalledWith({ isPreview: true, now: true });

    matchKeybinding(cmds, ev('F6'))?.run();
    expect(model.render).toHaveBeenCalledWith({ isPreview: false, now: true });

    matchKeybinding(cmds, ev('F7'))?.run();
    expect(model.export).toHaveBeenCalled();

    matchKeybinding(cmds, ev('s', true))?.run();
    expect(model.saveProject).toHaveBeenCalled();
  });
});
