import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

const nextRules = {
  ...nextPlugin.configs.recommended.rules,
  ...nextPlugin.configs['core-web-vitals'].rules,
};

const config = [
  ...baseConfig,
  ...nx.configs['flat/react-typescript'],
  {
    ignores: ['.next/**/*', '**/next-env.d.ts', 'apps/nextblock/next-env.d.ts'],
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.mjs',
      '**/*.cjs',
    ],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    settings: {
      // no-html-link-for-pages discovers the App Router directory under `next.rootDir`.
      // Its rule OPTION is a *pages* directory: passing 'apps/nextblock/app' there made it
      // derive pages-router URLs (`/cms/settings/packages/page`) that never match a real
      // link, so internal <a> links were silently never checked. Paths are relative to the
      // workspace root, which is where the @nx/eslint:lint executor runs ESLint.
      next: { rootDir: 'apps/nextblock/' },
    },
    rules: {
      ...nextRules,
      '@next/next/no-html-link-for-pages': 'error',
      // Nx's shared React config loads no react-hooks rules at all, which let three CMS
      // forms call hooks after an early return (a render-time crash once auth settles).
      // Standalone scaffolds lint with eslint-config-next, which enforces this rule, so
      // enforcing it here keeps `npm run lint` in a scaffold green whenever this is.
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];

export default config;
