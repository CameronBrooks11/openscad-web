import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Files and directories to skip entirely
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-publish/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.publish-e2e/**',
      'working/**',
      'src/wasm/**',
      'src/fs/zip-archives.generated.ts',
      'public/**',
      'libs/**',
    ],
  },

  // TypeScript rules applied to app, tests, and root TS config files
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', '*.ts'],
    extends: tseslint.configs.recommended,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },

  // The compile/state engine must not reach the DOM directly (#67). Browser
  // side effects go through the host adapter; URL/viewport reads live in the
  // explicit boundary modules excluded below (the adapters), keeping the engine
  // portable and unit-testable without a DOM.
  {
    files: ['src/state/**/*.ts', 'src/runner/**/*.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      'src/state/web-host-adapter.ts', // sanctioned DOM/window adapter (#90)
      'src/state/fragment-state.ts', // URL <-> state adapter
      'src/state/url-mode.ts', // URL-mode parsing/resolution adapter
      'src/state/initial-state.ts', // viewport-derived layout defaults
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message:
            'The compile/state engine must not touch window — route DOM/window access through the host adapter or a boundary module.',
        },
        {
          name: 'document',
          message:
            'The compile/state engine must not touch document — route DOM access through the host adapter or a boundary module.',
        },
        {
          name: 'navigator',
          message:
            'The compile/state engine must not touch navigator — route platform reads through the host adapter or a boundary module.',
        },
      ],
    },
  },

  // Architectural import boundaries (#67). The domain/engine layer must stay
  // free of UI, Monaco, and Three.js so it remains portable and testable; the
  // viewer must not pull in the editor/Monaco. src/language is intentionally
  // excluded — it is the Monaco language-integration layer.
  {
    files: ['src/state/**/*.ts', 'src/runner/**/*.ts', 'src/fs/**/*.ts', 'src/embed/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/components/**'],
              message: 'Domain/engine code must not import UI components.',
            },
            {
              group: ['monaco-editor', 'monaco-editor/**'],
              message: 'Domain/engine code must not import Monaco.',
            },
            {
              group: ['three', 'three/**'],
              message: 'Domain/engine code must not import Three.js.',
            },
          ],
        },
      ],
    },
  },

  // The viewer must not depend on the editor or Monaco (keeps it a clean,
  // independently-loadable surface — see the boot split in #68).
  {
    files: [
      'src/components/elements/osc-geometry-viewer.ts',
      'src/components/elements/osc-viewer-panel.ts',
      'src/components/viewer/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['monaco-editor', 'monaco-editor/**', '**/osc-editor-panel*'],
              message: 'The viewer must not import the editor or Monaco.',
            },
          ],
        },
      ],
    },
  },

  // The Layer-0 protocol is the DISTRIBUTABLE, DOM-free wire contract (#143/#176):
  // it must import nothing outside src/protocol/ so it stays portable to a
  // separate consumer (a VS Code extension) and publishable as-is.
  {
    files: ['src/protocol/**/*.ts'],
    ignores: ['src/protocol/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // No outward relative imports, and no Node builtins — the protocol
              // must run in a plain browser/webview consumer too.
              group: ['../*', '../**', 'node:*', 'node:**'],
              message:
                'src/protocol is the distributable wire contract: import nothing outside src/protocol (no app code, no Node builtins).',
            },
          ],
        },
      ],
    },
  },

  // The viewer-host (controller + transports) is the host-binding tier (#143/#173):
  // it may use the protocol and the reusable viewer, but NOT the app shell, state,
  // language, Monaco, or the editor — so the VS Code work stays isolated from the
  // main app.
  {
    files: ['src/viewer-host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/state/**',
                '**/language/**',
                'monaco-editor',
                'monaco-editor/**',
                '**/osc-editor-panel*',
                '**/osc-app-shell*',
                '**/model*',
              ],
              message: 'The viewer host must not import the app shell, state, or editor.',
            },
          ],
        },
      ],
    },
  },

  // The session-host tier (the compile counterpart of viewer-host, #192/#179) MAY
  // import the engine (state/runner) and the protocol + the reusable transports —
  // it drives an OpenScadSession — but NOT the editor, Monaco, the language tooling,
  // or the app shell, so the compile-capable session bundle stays lean.
  {
    files: ['src/session-host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/language/**',
                'monaco-editor',
                'monaco-editor/**',
                '**/osc-editor-panel*',
                '**/osc-app-shell*',
              ],
              message:
                'The session host must not import the editor, Monaco, language, or app shell.',
            },
          ],
        },
      ],
    },
  },

  // The app must not reach into the viewer-host transports (reverse direction):
  // host-binding code is consumed only by the viewer entry composition root.
  {
    files: ['src/components/**/*.ts', 'src/state/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/viewer-host/**'],
              message: 'App code must not import the viewer-host transports.',
            },
          ],
        },
      ],
    },
  },

  // JavaScript/ESM rules applied to Node scripts and root JS config files
  {
    files: ['scripts/**/*.mjs', '*.js'],
    extends: tseslint.configs.recommended,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
);
