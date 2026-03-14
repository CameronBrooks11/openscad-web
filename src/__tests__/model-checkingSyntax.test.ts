import type { State } from '../state/app-state.ts';
import { Model } from '../state/model.ts';
import { defaultModelColor, defaultSourcePath } from '../state/initial-state.ts';

vi.mock('../runner/actions.ts', () => ({
  checkSyntax: vi
    .fn()
    .mockReturnValue(vi.fn().mockRejectedValue(new Error('mock runner failure'))),
  render: vi.fn(),
  getDefaultCompileArgs: vi.fn().mockReturnValue(['--backend=manifold']),
}));

describe('Model.checkSyntax', () => {
  const makeMockFs = () => ({
    readFileSync: vi.fn((_path: string) => new Uint8Array(0)),
    writeFile: vi.fn(),
    isFile: vi.fn(() => false),
  });

  function createState(): State {
    return {
      params: {
        activePath: defaultSourcePath,
        sources: [{ path: defaultSourcePath, content: 'cube(10);' }],
        features: [],
        exportFormat2D: 'svg',
        exportFormat3D: 'stl',
      },
      view: {
        layout: {
          mode: 'multi',
          editor: true,
          viewer: true,
          customizer: false,
        },
        color: defaultModelColor,
        showAxes: true,
        lineNumbers: false,
      },
    };
  }

  it('clears checkingSyntax when the syntax runner rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = new Model(makeMockFs() as unknown as FS, createState());

    await model.checkSyntax();

    expect(model.state.checkingSyntax).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
