// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public sandbox (NEXT_PUBLIC_IS_SANDBOX === 'true') publishes its admin login, so the GTM
 * container and the "custom consented scripts" in privacy_settings are visitor-controlled there.
 * Injected with the nonce, they would run for every later visitor who accepts analytics and could
 * read the OpenRouter key kept in localStorage. On the sandbox nothing is injected, consent or not;
 * everywhere else the consented tags load exactly as before.
 */

const mocks = vi.hoisted(() => ({
  gtm: [] as Array<{ gtmId?: string; nonce?: string }>,
  ga: [] as Array<{ gaId?: string; nonce?: string }>,
}));

// The deferred loaders fetch their tag after a first interaction; these stand-ins render the tag
// straight away, so a script element in the DOM means the tag manager would have loaded.
vi.mock('../DeferredGoogleTagManager', async () => {
  const { createElement } = await import('react');
  return {
    DeferredGoogleTagManager: (props: { gtmId?: string; nonce?: string }) => {
      mocks.gtm.push(props);
      return createElement('script', { 'data-test-tag': 'gtm', 'data-id': props.gtmId });
    },
  };
});
vi.mock('../DeferredGoogleAnalytics', async () => {
  const { createElement } = await import('react');
  return {
    DeferredGoogleAnalytics: (props: { gaId?: string; nonce?: string }) => {
      mocks.ga.push(props);
      return createElement('script', { 'data-test-tag': 'ga', 'data-id': props.gaId });
    },
  };
});

import { CONSENT_CHANGE_EVENT } from '../../lib/privacy/consent-client';
import { CONSENT_COOKIE_NAME } from '../../lib/privacy/types';
import { ConsentGatedAnalytics } from './ConsentGatedAnalytics';

const SANDBOX_KEY_STORAGE = 'cortex_ai_sandbox_openrouter_api_key';
const STOLEN_ATTRIBUTE = 'data-read-key';
// jsdom runs injected inline scripts (vitest sets runScripts: 'dangerously'), in jsdom's own window
// context, so this one really reads the key and leaves it on the shared document: proof it ran.
// External sources are never fetched.
const CUSTOM_SCRIPTS =
  '<script src="https://tags.example.test/pixel.js" async></script>' +
  `<script>document.documentElement.setAttribute('${STOLEN_ATTRIBUTE}', localStorage.getItem('${SANDBOX_KEY_STORAGE}'));</script>`;

/** What the injected inline script read from localStorage, or null when it never ran. */
function keyReadByScript() {
  return document.documentElement.getAttribute(STOLEN_ATTRIBUTE);
}

const mounted: Root[] = [];

function setConsent(analytics: boolean) {
  const value = JSON.stringify({ analytics, marketing: false, token: 'test-token', ts: 1 });
  document.cookie = `${CONSENT_COOKIE_NAME}=${encodeURIComponent(value)}; path=/`;
}

function clearConsent() {
  document.cookie = `${CONSENT_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      <ConsentGatedAnalytics
        gtmId="GTM-TEST123"
        gaMeasurementId="G-TEST123"
        customScripts={CUSTOM_SCRIPTS}
        nonce="n0nce"
      />
    );
  });
  return container;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.gtm = [];
  mocks.ga = [];
  setConsent(true);
  localStorage.setItem(SANDBOX_KEY_STORAGE, 'sk-or-v1-visitor-key');
  document.documentElement.removeAttribute(STOLEN_ATTRIBUTE);
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  clearConsent();
  localStorage.clear();
  document.documentElement.removeAttribute(STOLEN_ATTRIBUTE);
  vi.unstubAllEnvs();
});

describe('ConsentGatedAnalytics', () => {
  it('appends no script on the sandbox with analytics consent granted: no GTM, no GA, no custom script', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const container = await mount();

    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(container.innerHTML).toBe('');
    expect(mocks.gtm).toEqual([]);
    expect(mocks.ga).toEqual([]);
    expect(keyReadByScript()).toBeNull();

    // Consent given (again) after the first render injects nothing either.
    await act(async () => {
      setConsent(true);
      window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
    });
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(mocks.gtm).toEqual([]);
    expect(keyReadByScript()).toBeNull();
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'injects the custom scripts with the nonce and loads GTM and GA after consent when NEXT_PUBLIC_IS_SANDBOX=%j',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const container = await mount();

      const injected = [...document.head.querySelectorAll('script')];
      expect(injected.map((script) => script.getAttribute('src'))).toEqual(['https://tags.example.test/pixel.js', null]);
      expect(injected.map((script) => script.getAttribute('nonce'))).toEqual(['n0nce', 'n0nce']);
      // The admin's consented script ran: exactly what a planted one would do on the sandbox.
      expect(keyReadByScript()).toBe('sk-or-v1-visitor-key');

      expect(container.querySelector('script[data-test-tag="gtm"]')?.getAttribute('data-id')).toBe('GTM-TEST123');
      expect(container.querySelector('script[data-test-tag="ga"]')?.getAttribute('data-id')).toBe('G-TEST123');
      expect(mocks.gtm.at(-1)).toEqual({ gtmId: 'GTM-TEST123', nonce: 'n0nce' });
      expect(mocks.ga.at(-1)).toEqual({ gaId: 'G-TEST123', nonce: 'n0nce' });
    }
  );

  it('still waits for consent off the sandbox', async () => {
    setConsent(false);
    const container = await mount();

    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(container.innerHTML).toBe('');
    expect(mocks.gtm).toEqual([]);
  });
});
