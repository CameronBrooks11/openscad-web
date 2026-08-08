vi.mock('@monaco-editor/loader', () => ({
  __esModule: true,
  default: { init: vi.fn(), config: vi.fn() },
}));

vi.mock('../openscad-completions.ts', () => ({
  buildOpenSCADCompletionItemProvider: vi.fn(),
}));

import loader from '@monaco-editor/loader';
import builtins from '../openscad-builtins.ts';
import options from '../openscad-editor-options.ts';
import openscadLanguage from '../openscad-language.ts';
import { buildOpenSCADCompletionItemProvider } from '../openscad-completions.ts';
import { registerOpenSCADLanguage } from '../openscad-register-language.ts';

describe('OpenSCAD language registration', () => {
  it('exposes editor options and builtins payload', () => {
    expect(options.language).toBe('openscad');
    expect(options.lineNumbers).toBe('on');
    expect(builtins).toContain('function abs(x)');
  });

  it('exposes Monaco language definition and configuration', () => {
    expect(openscadLanguage.conf.comments?.lineComment).toBe('//');
    expect(openscadLanguage.language.keywords).toContain('cube');
  });

  it('registers language, configuration, tokenizer, and completion provider', async () => {
    const provider = { provideCompletionItems: vi.fn() };
    const monacoMock = {
      languages: {
        register: vi.fn(),
        setLanguageConfiguration: vi.fn(),
        setMonarchTokensProvider: vi.fn(),
        registerCompletionItemProvider: vi.fn(),
      },
    };

    const mockedLoader = loader as unknown as {
      init: ReturnType<typeof vi.fn>;
      config: ReturnType<typeof vi.fn>;
    };
    mockedLoader.init.mockResolvedValue(monacoMock);

    const mockedBuilder = buildOpenSCADCompletionItemProvider as unknown as ReturnType<
      typeof vi.fn
    >;
    mockedBuilder.mockResolvedValue(provider);

    const first = await registerOpenSCADLanguage({} as FS, '/home', []);
    const second = await registerOpenSCADLanguage({} as FS, '/home', []);

    expect(first).toBe(monacoMock);
    expect(second).toBe(monacoMock);

    expect(monacoMock.languages.register).toHaveBeenCalledWith({
      id: 'openscad',
      extensions: ['.scad'],
      mimetypes: ['text/openscad'],
    });
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      'openscad',
      openscadLanguage.conf,
    );
    expect(monacoMock.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      'openscad',
      openscadLanguage.language,
    );
    expect(mockedLoader.init).toHaveBeenCalledTimes(1);
    // Monaco must come from our own origin, never @monaco-editor/loader's
    // default jsDelivr CDN (#267).
    expect(mockedLoader.config).toHaveBeenCalledTimes(1);
    const vsPath = mockedLoader.config.mock.calls[0][0].paths.vs as string;
    expect(vsPath).toMatch(/\/monaco\/vs$/);
    expect(vsPath).not.toMatch(/cdn|jsdelivr|unpkg/i);
    expect(mockedBuilder).toHaveBeenCalledTimes(1);
    expect(mockedBuilder).toHaveBeenCalledWith({}, '/home', []);
    expect(monacoMock.languages.registerCompletionItemProvider).toHaveBeenCalledWith(
      'openscad',
      provider,
    );
    expect(monacoMock.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1);
  });
});
