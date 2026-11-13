import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  // The storefront renderer, the copy provider and the Tiptap editor are React: rules of hooks,
  // JSX and jsx-a11y apply to them (Nx's shared React config, as libs/ui and libs/editor use it).
  ...nx.configs['flat/react'],
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // Same exemptions as libs/editor: Tiptap node views and editor refs trip the React
      // Compiler-oriented rules without being bugs. rules-of-hooks stays on.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vite.config.{js,ts,mjs,mts}',
            '{projectRoot}/src/**/*.test.{ts,tsx}',
            '{projectRoot}/src/**/*.spec.{ts,tsx}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
