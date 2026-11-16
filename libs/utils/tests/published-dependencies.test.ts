import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The published @nextblock-cms/utils manifest is written by vite.config.mts afterBuild, with its
// dependency ranges as literals; the monorepo (and so every test) installs from the root
// package.json. For a security floor the two must move together: a scaffold whose lockfile still
// satisfies an older published range keeps the old library through `npm run update`, a version
// no test here ran against.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VITE_CONFIG = path.join(REPO_ROOT, 'libs/utils/vite.config.mts');
const ROOT_MANIFEST = path.join(REPO_ROOT, 'package.json');

/** Published dependencies whose range must equal the root package.json's, with why. */
const LOCKSTEP_DEPENDENCIES = new Map([
  [
    'sanitize-html',
    'the authored-HTML allowlist (lib/authored-html); ^2.18.2 is the floor for GHSA-6wrv-5cp6-h3c5, and the tests pin its exact output',
  ],
]);

const propertyName = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;

/** The `dependencies` literal of the manifest the afterBuild hook writes, as written. */
function publishedDependencies() {
  const file = ts.createSourceFile(VITE_CONFIG, readFileSync(VITE_CONFIG, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<Map<string, ts.Expression>> = [];
  const visitAfterBuild = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'dependencies' && ts.isObjectLiteralExpression(node.initializer)) {
      const entries = new Map<string, ts.Expression>();
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) throw new Error(`published-dependencies: unexpected ${ts.SyntaxKind[property.kind]} in dependencies`);
        const name = propertyName(property.name);
        if (name !== null) entries.set(name, property.initializer);
      }
      found.push(entries);
    }
    ts.forEachChild(node, visitAfterBuild);
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'afterBuild') visitAfterBuild(node.initializer);
    else ts.forEachChild(node, visit);
  };
  visit(file);
  if (found.length !== 1) throw new Error(`published-dependencies: expected one dependencies object in afterBuild, found ${found.length}`);
  return found[0];
}

describe('the published @nextblock-cms/utils dependency ranges', () => {
  it('match the root package.json for every lockstep dependency', () => {
    const root = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8')) as { dependencies?: Record<string, string> };
    const published = publishedDependencies();
    const problems: string[] = [];
    for (const [name, why] of LOCKSTEP_DEPENDENCIES) {
      const rootRange = root.dependencies?.[name];
      const literal = published.get(name);
      if (!rootRange) problems.push(`${name}: missing from the root package.json dependencies (${why})`);
      if (!literal) {
        problems.push(`${name}: missing from the afterBuild manifest's dependencies in libs/utils/vite.config.mts (${why})`);
        continue;
      }
      if (!ts.isStringLiteralLike(literal)) {
        problems.push(`${name}: the afterBuild manifest's range is not a string literal (${literal.getText()}); keep it literal so this test can read it`);
        continue;
      }
      if (rootRange && literal.text !== rootRange) {
        problems.push(`${name}: libs/utils/vite.config.mts publishes '${literal.text}' but the root package.json installs '${rootRange}'; raise both together (${why})`);
      }
    }
    expect(problems).toEqual([]);
  });
});
