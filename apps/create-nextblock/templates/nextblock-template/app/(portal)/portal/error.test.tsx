// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_COMMON_COPY } from '@nextblock-cms/affiliates';
import { TranslationsProvider } from '@nextblock-cms/utils';

import PartnerPortalError from './error';

/**
 * The partner portal's error boundary: localized copy (the portal's copy provider sits in the
 * layout that may have failed, so the site language decides), a working "Try again", and nothing
 * from the error itself. It must sit ABOVE `retailer/`: an error.tsx never wraps its own segment's
 * layout, and the partner lookup runs in `retailer/layout.tsx`.
 */

const ERROR_FILE = path.resolve(__dirname, 'error.tsx');
const RETAILER_DIR = path.resolve(__dirname, 'retailer');
const ERROR_TEXT = AFFILIATES_COMMON_COPY['affiliates.common.error_generic'];
const RETRY_TEXT = AFFILIATES_COMMON_COPY['affiliates.common.retry'];

const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
});

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(node);
  });
  return container;
}

function siteLanguage(lang: string, node: ReactNode): ReactNode {
  return (
    <TranslationsProvider translations={[]} lang={lang}>
      {node}
    </TranslationsProvider>
  );
}

const thrown = Object.assign(new Error('boom: relation "affiliate_profiles" does not exist'), { digest: 'digest-1234567' });

describe('partner portal error boundary', () => {
  it('speaks the site language: French', async () => {
    const container = await render(siteLanguage('fr', <PartnerPortalError error={thrown} retry={() => undefined} />));
    expect(ERROR_TEXT.fr).not.toBe(ERROR_TEXT.en);
    expect(container.querySelector('h1')?.textContent).toBe(ERROR_TEXT.fr);
    expect(container.querySelector('button')?.textContent).toBe(RETRY_TEXT.fr);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('speaks the site language: English, and English without any provider', async () => {
    const english = await render(siteLanguage('en', <PartnerPortalError error={thrown} retry={() => undefined} />));
    expect(english.querySelector('h1')?.textContent).toBe(ERROR_TEXT.en);
    expect(english.querySelector('button')?.textContent).toBe(RETRY_TEXT.en);

    const bare = await render(<PartnerPortalError error={thrown} retry={() => undefined} />);
    expect(bare.querySelector('h1')?.textContent).toBe(ERROR_TEXT.en);
  });

  it('never shows the error message or digest', async () => {
    const container = await render(siteLanguage('fr', <PartnerPortalError error={thrown} retry={() => undefined} />));
    expect(container.textContent).not.toContain('boom');
    expect(container.textContent).not.toContain('affiliate_profiles');
    expect(container.innerHTML).not.toContain('digest-1234567');
  });

  it('retries once per click', async () => {
    const retry = vi.fn();
    const container = await render(siteLanguage('en', <PartnerPortalError error={thrown} retry={retry} />));
    const button = container.querySelector('button');
    expect(button?.getAttribute('type')).toBe('button');
    await act(async () => {
      button?.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('portal boundary files', () => {
  it('puts the error boundary one segment above the retailer layout, as a client component', () => {
    expect(fs.existsSync(ERROR_FILE)).toBe(true);
    expect(fs.readFileSync(ERROR_FILE, 'utf8').startsWith("'use client';")).toBe(true);
    // It must not sit beside the layout it has to catch (retailer/error.tsx would miss it).
    expect(fs.existsSync(path.join(RETAILER_DIR, 'layout.tsx'))).toBe(true);
    expect(path.dirname(ERROR_FILE)).toBe(path.dirname(RETAILER_DIR));
  });

  it('gives the retailer segment a loading state inside its layout', () => {
    const loading = path.join(RETAILER_DIR, 'loading.tsx');
    expect(fs.existsSync(loading)).toBe(true);
    expect(fs.readFileSync(loading, 'utf8')).toContain('<PortalLoading />');
  });

  it('renders only dictionary copy (no raw JSX text, known keys)', () => {
    const text = fs.readFileSync(ERROR_FILE, 'utf8');
    const source = ts.createSourceFile(ERROR_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rawText: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node) && /\p{L}/u.test(node.getText(source))) rawText.push(node.getText(source).trim());
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(rawText).toEqual([]);

    const keys = [...text.matchAll(/'(affiliates\.[a-z]+\.[a-z0-9_]+)'/g)].map((match) => match[1] as string);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !Object.prototype.hasOwnProperty.call(AFFILIATES_COMMON_COPY, key))).toEqual([]);
  });
});
