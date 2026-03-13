import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Files and directories to skip entirely
  {
    ignores: ['node_modules/**', 'dist/**', 'src/wasm/**', 'public/**', 'libs/**'],
  },

  // TypeScript rules applied to src/ only
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: tseslint.configs.recommended,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
);
