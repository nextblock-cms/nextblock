import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AFFILIATES_COMMON_COPY, AFFILIATES_PORTAL_COPY, AFFILIATES_SANDBOX_COPY } from '@nextblock-cms/affiliates';

import { PORTAL_PROVIDER_COPY, PORTAL_UI_COPY } from './portal-copy';

/**
 * The partner portal is a public-audience surface: every string comes from the affiliates copy
 * dictionaries (EN + Québec FR). These checks fail on a raw English string in JSX, a hard-coded
 * accessible name, a key used but never defined, and a portal key nobody uses (02031 would seed
 * dead copy). The public sandbox's keys are checked the same way across the surfaces that render
 * them (this portal, the /partners route and its signup form).
 */

const PORTAL_DIR = path.resolve(__dirname, '..');
const EXTRA_FILES = [
  path.resolve(__dirname, '../../../../../lib/affiliates/portal-data.ts'),
  path.resolve(__dirname, '../../../../api/affiliates/upload/route.ts'),
];
/** Where `affiliates.sandbox.*` keys render outside the portal. */
const SANDBOX_SURFACE_DIRS = [
  path.resolve(__dirname, '../../../../(public)/partners'),
  path.resolve(__dirname, '../../../../../components/affiliates'),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = sourceFiles(PORTAL_DIR);
const KEY_PATTERN = /'(affiliates\.(?:portal|common|sandbox)\.[a-z0-9_]+)'/g;
const SANDBOX_KEY_PATTERN = /'(affiliates\.sandbox\.[a-z0-9_]+)'/g;

/** Attributes whose value a person reads or hears. */
const TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'placeholder', 'title', 'alt', 'label']);

function jsxTextProblems(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && /\p{L}/u.test(node.getText(sf))) {
      problems.push(`${path.basename(file)}: text "${node.getText(sf).trim()}"`);
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      if (TEXT_ATTRIBUTES.has(name) && /\p{L}/u.test(node.initializer.text)) {
        problems.push(`${path.basename(file)}: ${name}="${node.initializer.text}"`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

describe('partner portal copy', () => {
  it('scans the portal sources', () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((file) => file.endsWith('StorefrontStudio.tsx'))).toBe(true);
  });

  it('uses only keys that exist in the common, portal and sandbox dictionaries', () => {
    const missing: string[] = [];
    for (const file of [...files, ...EXTRA_FILES]) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(KEY_PATTERN)) {
        const key = match[1] as string;
        const known =
          Object.prototype.hasOwnProperty.call(AFFILIATES_PORTAL_COPY, key) ||
          Object.prototype.hasOwnProperty.call(AFFILIATES_COMMON_COPY, key) ||
          Object.prototype.hasOwnProperty.call(AFFILIATES_SANDBOX_COPY, key);
        if (!known) missing.push(`${path.basename(file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('translates the sandbox notices with the portal dictionaries (server copy and provider overrides)', () => {
    for (const key of Object.keys(AFFILIATES_SANDBOX_COPY)) {
      expect(PORTAL_UI_COPY, key).toHaveProperty([key]);
      expect(PORTAL_PROVIDER_COPY, key).toHaveProperty([key]);
    }
    expect(Object.keys(AFFILIATES_SANDBOX_COPY).length).toBeGreaterThan(0);
  });

  it('uses every sandbox key on a surface that renders it, and only keys that exist (no dead copy for the 02031 seed)', () => {
    const surfaces = [...files, ...SANDBOX_SURFACE_DIRS.flatMap(sourceFiles)];
    expect(surfaces.some((file) => file.endsWith('PartnerSignupForm.tsx'))).toBe(true);
    expect(surfaces.some((file) => file.endsWith('partners-route.tsx'))).toBe(true);

    const used = new Set<string>();
    for (const file of surfaces) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(SANDBOX_KEY_PATTERN)) used.add(match[1] as string);
    }
    expect([...used].filter((key) => !Object.prototype.hasOwnProperty.call(AFFILIATES_SANDBOX_COPY, key))).toEqual([]);
    expect(Object.keys(AFFILIATES_SANDBOX_COPY).filter((key) => !used.has(key))).toEqual([]);
  });

  it('uses every portal key (no dead copy for the 02031 seed)', () => {
    const used = new Set<string>();
    for (const file of files) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(KEY_PATTERN)) used.add(match[1] as string);
    }
    expect(Object.keys(AFFILIATES_PORTAL_COPY).filter((key) => !used.has(key))).toEqual([]);
  });

  it('renders no inline text or hard-coded accessible names in JSX', () => {
    const problems = files.filter((file) => file.endsWith('.tsx')).flatMap(jsxTextProblems);
    expect(problems).toEqual([]);
  });

  it('keeps every client island free of server modules', () => {
    const serverOnly = [
      /from ['"]server-only['"]/,
      /@nextblock-cms\/affiliates\/server/,
      /@nextblock-cms\/db\/server/,
      /lib\/affiliates\/(?:portal-data|retailer-actor|server-copy|uploads|notify|settings|connect-service|payout-runner)['"]/,
      /portal-server-copy['"]/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (!/^'use client';/.test(source)) continue;
      for (const pattern of serverOnly) {
        if (pattern.test(source)) offenders.push(`${path.basename(file)} ~ ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
