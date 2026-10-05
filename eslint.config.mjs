// @ts-check
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out', 'dist', 'node_modules', '.evs', 'scripts/*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.mjs', '*.config.*'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/preload/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Effects that deliberately run on every render (key listeners reading fresh state) are fine here.
      'react-hooks/exhaustive-deps': 'off',
      // For the React Compiler (not used here); it flags event handlers that read refs when called later.
      'react-hooks/refs': 'off'
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }]
    }
  }
)
