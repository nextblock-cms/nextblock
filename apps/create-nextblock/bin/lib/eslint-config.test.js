import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STANDALONE_ERROR_REACT_HOOKS_RULES,
  STANDALONE_ESLINT_CONFIG,
  STANDALONE_ESLINT_CONFIG_IMPORTS,
} from './eslint-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../nextblock');
const appPackageJson = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8'));

function importSpecifiers(source) {
  return [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('standalone ESLint config', () => {
  it('imports only packages a scaffold installs, and nothing monorepo-only', () => {
    const specifiers = importSpecifiers(STANDALONE_ESLINT_CONFIG);

    expect(specifiers).toEqual(STANDALONE_ESLINT_CONFIG_IMPORTS);

    const declared = {
      ...appPackageJson.dependencies,
      ...appPackageJson.devDependencies,
    };

    for (const specifier of specifiers) {
      // The monorepo config's failure modes: a relative root config and Nx's plugin.
      expect(specifier.startsWith('.')).toBe(false);
      expect(specifier.startsWith('@nx/')).toBe(false);
      // apps/nextblock/package.json becomes the scaffold's package.json.
      expect(declared).toHaveProperty(packageNameOf(specifier));
    }
  });

  it('makes the app lint script run ESLint, not the `next lint` Next 16 removed', () => {
    expect(appPackageJson.scripts.lint).toBe('eslint .');
  });

  // The drift guard. Lints the real app code with exactly the config a scaffold receives, so
  // an upstream change that would fail `npm run lint` in a generated project fails here first.
  it(
    'lints the real app code with zero errors',
    async () => {
      const { ESLint } = await import('eslint');

      // The config lives in a temp dir, so point its bare imports at the monorepo's installs.
      const requireFromApp = createRequire(resolve(appDir, 'package.json'));
      let source = STANDALONE_ESLINT_CONFIG;
      for (const specifier of STANDALONE_ESLINT_CONFIG_IMPORTS) {
        const url = pathToFileURL(requireFromApp.resolve(specifier)).href;
        source = source.replace(`from '${specifier}';`, `from '${url}';`);
      }

      // A stable temp dir (not mkdtemp) so the ESLint cache survives between runs: a full
      // cold lint of the app takes a minute or two, a warm one only re-lints changed files.
      const guardDir = join(tmpdir(), 'nextblock-eslint-guard');
      mkdirSync(guardDir, { recursive: true });
      const configFile = join(guardDir, 'eslint.config.mjs');
      writeFileSync(configFile, source);

      // With an explicit config file, `files`/`ignores` patterns resolve against `cwd`.
      const eslint = new ESLint({
        cache: true,
        cacheLocation: join(guardDir, '.eslintcache'),
        cacheStrategy: 'content',
        cwd: appDir,
        overrideConfigFile: configFile,
      });

      const probe = await eslint.calculateConfigForFile(resolve(appDir, 'app/layout.tsx'));
      for (const rule of STANDALONE_ERROR_REACT_HOOKS_RULES) {
        const level = Array.isArray(probe.rules[rule]) ? probe.rules[rule][0] : probe.rules[rule];
        expect(level, `${rule} must stay an error`).toBe(2);
      }

      const results = await eslint.lintFiles(['.']);
      const lintedBuildOutput = results.filter((result) =>
        /[\\/]\.next[\\/]/.test(result.filePath)
      );
      expect(lintedBuildOutput).toEqual([]);

      const errors = results.flatMap((result) =>
        result.messages
          .filter((message) => message.severity === 2)
          .map(
            (message) =>
              `${result.filePath.slice(appDir.length + 1)}:${message.line} ${message.ruleId ?? '(fatal)'} ${message.message}`
          )
      );

      expect(results.length).toBeGreaterThan(100);
      expect(errors, errors.join('\n')).toEqual([]);
    },
    300_000
  );
});
