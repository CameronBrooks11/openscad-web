import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // Files and directories to skip entirely
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'src/wasm/**',
      'public/**',
      'libs/**',
    ],
  },

  // TypeScript rules applied to src/ only
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: tseslint.configs.recommended,
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
