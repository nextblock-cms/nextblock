// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AFFILIATES_COMMON_COPY, AffiliatesCopyProvider } from '@nextblock-cms/affiliates';

import RetailerPortalLoading from './loading';

/**
 * The portal's loading state renders inside the retailer layout (under its copy provider): one
 * localized status line for assistive technology, and a skeleton that is hidden from it.
 */

const LOADING_TEXT = AFFILIATES_COMMON_COPY['affiliates.common.loading'];
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

describe('partner portal loading state', () => {
  it('announces loading in the portal language', async () => {
    const french = await render(
      <AffiliatesCopyProvider locale="fr">
        <RetailerPortalLoading />
      </AffiliatesCopyProvider>,
    );
    const status = french.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe(LOADING_TEXT.fr);

    const english = await render(
      <AffiliatesCopyProvider locale="en">
        <RetailerPortalLoading />
      </AffiliatesCopyProvider>,
    );
    expect(english.querySelector('[role="status"]')?.textContent).toBe(LOADING_TEXT.en);
  });

  it('hides the skeleton from assistive technology and only pulses when motion is allowed', async () => {
    const container = await render(
      <AffiliatesCopyProvider locale="en">
        <RetailerPortalLoading />
      </AffiliatesCopyProvider>,
    );
    const skeleton = container.querySelector('[aria-hidden="true"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.className).toContain('motion-safe:animate-pulse');
    expect(skeleton?.textContent).toBe('');
  });
});
