import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Checkout must send the cart's partner-storefront token to /api/checkout (NextBlock
 * Affiliates attribution), normalized through the cart helper. The component is a 1,700-line
 * client form, so the request body is checked in its source, parsed with the TypeScript
 * compiler (formatting and comments do not matter).
 */

const SOURCE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'Checkout.tsx');

function findCheckoutRequestBody(): ts.ObjectLiteralExpression | null {
  const source = ts.createSourceFile(SOURCE_FILE, readFileSync(SOURCE_FILE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.ObjectLiteralExpression | null = null;

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === '/api/checkout' &&
      node.arguments[1] &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      for (const property of node.arguments[1].properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'body' &&
          ts.isCallExpression(property.initializer) &&
          property.initializer.arguments[0] &&
          ts.isObjectLiteralExpression(property.initializer.arguments[0])
        ) {
          body = property.initializer.arguments[0];
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return body;
}

describe('Checkout request body', () => {
  it('sends the cart affiliateRef through normalizeCartAffiliateRef', () => {
    const body = findCheckoutRequestBody();
    expect(body, 'fetch("/api/checkout", { body: JSON.stringify({ … }) })').not.toBeNull();

    const property = (body as ts.ObjectLiteralExpression | null)?.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === 'affiliateRef'
    );

    expect(property, 'affiliateRef in the /api/checkout body').toBeDefined();
    const initializer = property?.initializer;
    expect(initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
      ? initializer.expression.text
      : null).toBe('normalizeCartAffiliateRef');
    expect(initializer?.getText()).toBe('normalizeCartAffiliateRef(store.affiliateRef)');
  });
});
