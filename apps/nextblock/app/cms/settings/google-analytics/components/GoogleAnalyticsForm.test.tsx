import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** On the sandbox the save is disabled and described by a note (updateGoogleAnalyticsSettings refuses there). */

vi.mock('../actions', () => ({ updateGoogleAnalyticsSettings: vi.fn() }));

import GoogleAnalyticsForm from './GoogleAnalyticsForm';

const NOTE = 'Site scripts and tag managers are turned off in the sandbox: they would run for every visitor.';
const SETTINGS = { gtm_id: 'GTM-ABC1234', ga_measurement_id: 'G-XYZ9876', custom_scripts: '<script>a()</script>' };

const SUBMIT = /<button[^>]*type="submit"[^>]*>/;
/** `disabled=""`, not `data-disabled=""`. */
const DISABLED = /\sdisabled=""/;

function render() {
  return renderToStaticMarkup(<GoogleAnalyticsForm initialSettings={SETTINGS} />);
}

function tag(html: string, pattern: RegExp) {
  const found = html.match(pattern)?.[0];
  if (!found) throw new Error(`no element matches ${pattern}`);
  return found;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GoogleAnalyticsForm', () => {
  it('disables the save button on the sandbox and describes it with the note', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = render();

    const submit = tag(html, SUBMIT);
    expect(submit).toMatch(DISABLED);
    expect(submit).toContain('aria-describedby="google-analytics-sandbox-note"');
    expect(html).toContain(`<p id="google-analytics-sandbox-note" class="text-sm text-muted-foreground">${NOTE}</p>`);
  });

  it('renders the same form, with no note and an enabled save button, everywhere else', () => {
    const rendered = ['', 'false', 'TRUE', '1'].map((value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const html = render();

      expect(tag(html, SUBMIT)).not.toMatch(/\sdisabled=|aria-describedby=/);
      expect(html).not.toContain(NOTE);
      expect(html).not.toContain('google-analytics-sandbox-note');
      return html;
    });
    expect(new Set(rendered).size).toBe(1);
  });
});
