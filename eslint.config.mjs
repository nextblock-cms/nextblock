import nx from '@nx/eslint-plugin';
// jsonc-eslint-parser 3 is ESM-only with no default export; the namespace is the parser.
import * as jsoncParser from 'jsonc-eslint-parser';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    files: ['**/*.json', '**/*.jsonc', '**/*.json5'],
    languageOptions: {
      parser: jsoncParser,
    },
    rules: {},
  },
  {
      "ignores": [
        "**/.next",
        "**/dist",
        "**/vite.config.*.timestamp*",
        "**/vitest.config.*.timestamp*"
      ]
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    settings: {
      'import/resolver': {
        typescript: {
          project: 'tsconfig.base.json',
        },
      },
    },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          // @nextblock-cms/utils is intentionally lazy-imported in
          // apps/nextblock/lib/ai-global-agent-custom-block-tools.ts (to keep that
          // module light and to allow partial-export test mocks). Exempt it from the
          // "static imports of lazy-loaded libraries" check; the scope depConstraints
          // and buildable-lib checks below still apply.
          // Subpaths (e.g. @nextblock-cms/utils/editor-blocks) are covered too:
          // the tsconfig "@nextblock-cms/utils/*" mapping makes them the same lib.
          checkDynamicDependenciesExceptions: ['^@nextblock-cms/utils(/.*)?$'],
          depConstraints: [
            {
              sourceTag: 'scope:public',
              onlyDependOnLibsWithTags: ['scope:public', 'scope:premium'],
            },
            {
              sourceTag: 'scope:premium',
              onlyDependOnLibsWithTags: ['scope:premium', 'scope:public'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
