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
