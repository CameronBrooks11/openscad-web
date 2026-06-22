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
