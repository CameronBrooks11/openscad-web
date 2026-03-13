// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import loader from '@monaco-editor/loader';
import * as monacoTypes from 'monaco-editor/esm/vs/editor/editor.api';
import type { ZipArchive } from '../fs/zip-archives.generated.ts';
import { buildOpenSCADCompletionItemProvider } from './openscad-completions.ts';
import openscadLanguage from './openscad-language.ts';

let registrationPromise: Promise<typeof monacoTypes> | null = null;

// https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
export async function registerOpenSCADLanguage(
  fs: FS,
  workingDir: string,
  zipArchives: ZipArchive[],
): Promise<typeof monacoTypes> {
  if (registrationPromise) {
    return registrationPromise;
  }

  registrationPromise = (async () => {
    try {
      const monaco = (await loader.init()) as typeof monacoTypes;

      monaco.languages.register({
        id: 'openscad',
        extensions: ['.scad'],
        mimetypes: ['text/openscad'],
      });

      const { conf, language } = openscadLanguage;
      monaco.languages.setLanguageConfiguration('openscad', conf);
      monaco.languages.setMonarchTokensProvider('openscad', language);

      monaco.languages.registerCompletionItemProvider(
        'openscad',
        await buildOpenSCADCompletionItemProvider(fs, workingDir, zipArchives),
      );

      return monaco;
    } catch (error) {
      registrationPromise = null;
      throw error;
    }
  })();

  return registrationPromise;
}
