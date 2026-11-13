import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** On the sandbox the auto-approve switch is read-only (updateRegistrationSettings refuses there). */

vi.mock('../actions', () => ({ updateRegistrationSettings: vi.fn() }));

import RegistrationForm from './RegistrationForm';

const NOTE = 'Sign-up settings are disabled in the sandbox.';

function render() {
  return renderToStaticMarkup(<RegistrationForm initialSettings={{ autoAcceptSignups: true }} />);
}

function tag(html: string, pattern: RegExp) {
  const found = html.match(pattern)?.[0];
  if (!found) throw new Error(`no element matches ${pattern}`);
  return found;
}

const CHECKBOX = /<button[^>]*role="checkbox"[^>]*>/;
const SUBMIT = /<button[^>]*type="submit"[^>]*>/;
/** `disabled=""`, not `data-disabled=""`. */
const DISABLED = /\sdisabled=""/;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RegistrationForm', () => {
  it('renders the switch and the save button disabled on the sandbox, with a note', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = render();

    const checkbox = tag(html, CHECKBOX);
    expect(checkbox).toMatch(DISABLED);
    expect(checkbox).toContain('aria-describedby="registration-sandbox-note"');
    expect(tag(html, SUBMIT)).toMatch(DISABLED);
    expect(html).toContain(`<p id="registration-sandbox-note" class="text-sm text-muted-foreground">${NOTE}</p>`);
  });

  it('keeps both enabled, with no note, everywhere else', () => {
    for (const value of ['', 'false']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const html = render();

      expect(tag(html, CHECKBOX)).not.toMatch(/\sdisabled=|aria-describedby=/);
      expect(tag(html, SUBMIT)).not.toMatch(DISABLED);
      expect(html).not.toContain(NOTE);
    }
  });
});
