// The scaffolded project's ESLint config.
//
// The template ships apps/nextblock/eslint.config.mjs verbatim, and that file only works
// inside the monorepo: it imports @nx/eslint-plugin and a `../../eslint.config.mjs` root
// config, neither of which exists in a scaffold. So in every generated project ESLint could
// not even load its config, and `npm run lint` was dead (it also still ran `next lint`, which
// Next 16 removed). The CLI now replaces that file with the self-contained config below,
// built on eslint-config-next, which the template already installs.
//
// Contract: a scaffold's `npm run lint` is green whenever the upstream `nx lint nextblock`
// is. eslint-config-next enforces more than the monorepo does (chiefly the React Compiler
// checks in eslint-plugin-react-hooks 7), so each rule upstream does not enforce is reported
// as a warning here instead of failing a fresh project. `react-hooks/rules-of-hooks` stays an
// error on both sides. eslint-config.test.js is the drift guard: it lints the real app code
// with this exact config and fails if anything is an error.

/** Rules eslint-config-next enforces as errors that the upstream monorepo does not. */
export const STANDALONE_WARN_ONLY_RULES = [
  'react/no-unescaped-entities',
  '@typescript-eslint/no-require-imports',
];

/** Every react-hooks rule is a warning except this one, which catches render-time crashes. */
export const STANDALONE_ERROR_REACT_HOOKS_RULES = ['react-hooks/rules-of-hooks'];

export const STANDALONE_ESLINT_CONFIG = `// ESLint config for this NextBlock project (written by create-nextblock).
//
// Built on eslint-config-next. Checks the upstream NextBlock repository does not enforce are
// reported as warnings rather than errors, so \`npm run lint\` passes on a fresh project: the
// React Compiler rules from eslint-plugin-react-hooks (rules-of-hooks stays an error),
// unescaped JSX entities, and require() in TypeScript. Tighten any of them below.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const WARN_ONLY_RULES = new Set(${JSON.stringify(STANDALONE_WARN_ONLY_RULES)});
const ERROR_REACT_HOOKS_RULES = new Set(${JSON.stringify(STANDALONE_ERROR_REACT_HOOKS_RULES)});

function shouldWarn(rule) {
  if (rule.startsWith('react-hooks/')) {
    return !ERROR_REACT_HOOKS_RULES.has(rule);
  }
  return WARN_ONLY_RULES.has(rule);
}

function isError(value) {
  const level = Array.isArray(value) ? value[0] : value;
  return level === 2 || level === 'error';
}

// Rewrite severities inside each config object, so every rule keeps its options and its
// \`files\` scope. Demoting with a separate override object would switch rules ON for files
// they never applied to. This also catches rules a future eslint-config-next adds.
function demoteToWarnings(config) {
  if (!config.rules) {
    return config;
  }

  const rules = Object.fromEntries(
    Object.entries(config.rules).map(([rule, value]) => {
      if (!shouldWarn(rule) || !isError(value)) {
        return [rule, value];
      }
      return [rule, Array.isArray(value) ? ['warn', ...value.slice(1)] : 'warn'];
    })
  );

  return { ...config, rules };
}

export default defineConfig([
  ...[...nextCoreWebVitals, ...nextTypescript].map(demoteToWarnings),
  {
    rules: {
      // Matches upstream: CMS content and Supabase JSON are loosely typed on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain .js/.cjs files here (next.config.js, tools/, scripts/) are CommonJS.
    files: ['**/*.js', '**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // The source keeps a few \`eslint-disable @nx/enforce-module-boundaries\` comments from the
    // upstream monorepo. There are no Nx module boundaries in this project; this no-op rule
    // stops ESLint reporting "Definition for rule ... was not found" on those comments.
    plugins: {
      '@nx': {
        rules: {
          'enforce-module-boundaries': { meta: { schema: false }, create: () => ({}) },
        },
      },
    },
  },
  // .nextblock-backup/ holds the files that npm run update replaced, i.e. old code and configs.
  globalIgnores(['.next/**', 'out/**', 'build/**', 'dist/**', '.nextblock-backup/**', 'next-env.d.ts']),
]);
`;

/** The bare packages the standalone config imports; the scaffold must install each one. */
export const STANDALONE_ESLINT_CONFIG_IMPORTS = [
  'eslint/config',
  'eslint-config-next/core-web-vitals',
  'eslint-config-next/typescript',
];
