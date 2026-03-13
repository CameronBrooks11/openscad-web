jest.mock('@monaco-editor/loader', () => ({
  __esModule: true,
  default: { init: jest.fn() },
}));

jest.mock('../openscad-completions.ts', () => ({
  buildOpenSCADCompletionItemProvider: jest.fn(),
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
    const provider = { provideCompletionItems: jest.fn() };
    const monacoMock = {
      languages: {
        register: jest.fn(),
        setLanguageConfiguration: jest.fn(),
        setMonarchTokensProvider: jest.fn(),
        registerCompletionItemProvider: jest.fn(),
      },
    };

    const mockedLoader = loader as unknown as { init: jest.Mock };
    mockedLoader.init.mockResolvedValue(monacoMock);

    const mockedBuilder = buildOpenSCADCompletionItemProvider as unknown as jest.Mock;
    mockedBuilder.mockResolvedValue(provider);

    await registerOpenSCADLanguage({} as FS, '/home', []);

    expect(monacoMock.languages.register).toHaveBeenCalledWith({
      id: 'openscad',
      extensions: ['.scad'],
      mimetypes: ['text/openscad'],
    });
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith('openscad', openscadLanguage.conf);
    expect(monacoMock.languages.setMonarchTokensProvider).toHaveBeenCalledWith('openscad', openscadLanguage.language);
    expect(mockedBuilder).toHaveBeenCalledWith({}, '/home', []);
    expect(monacoMock.languages.registerCompletionItemProvider).toHaveBeenCalledWith('openscad', provider);
  });
});
