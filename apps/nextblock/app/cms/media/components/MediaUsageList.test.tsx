// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a media item is used, as the delete dialogs and the media edit page list it. A WRITER's answer
 * withholds the records their RLS hides (withoutAdminOnlyLabels: no label, no record id), so two
 * withheld places of one kind share kind and id and must still be two lines; and a row whose storage
 * keys were not searched says so instead of "Used in 1 place".
 */

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import MediaUsageList from './MediaUsageList';
import { withoutAdminOnlyLabels, type MediaUsage } from '../../../../lib/media/media-usage-format';

const ID = 'a1111111-1111-4111-8111-11111111111a';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(usage: MediaUsage) {
  act(() => root.render(<MediaUsageList usage={usage} />));
}

describe('MediaUsageList', () => {
  it("lists every place a WRITER's answer withholds, each on its own line and without a link", () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const usage = withoutAdminOnlyLabels({
      total: 3,
      byKind: { partner_page: 2, redirect: 1 },
      sites: [
        { kind: 'partner_page', recordId: 'e5555555-5555-4555-8555-55555555555e', parentType: null, parentId: null, label: 'jane', language: null },
        { kind: 'partner_page', recordId: 'e6666666-6666-4666-8666-66666666666e', parentType: null, parentId: null, label: 'joe', language: null },
        { kind: 'redirect', recordId: 'f7777777-7777-4777-8777-77777777777f', parentType: null, parentId: null, label: '/old-launch', language: null },
      ],
    });

    render(usage);

    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'A partner storefront',
      'A partner storefront',
      'A redirect',
    ]);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/jane|joe|old-launch/);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });

  it('says a row whose storage keys were not searched could not be fully checked, and why', () => {
    render({
      total: 1,
      byKind: { unchecked_key: 1 },
      sites: [{ kind: 'unchecked_key', recordId: ID, parentType: null, parentId: null, label: null, language: null }],
    });

    expect(container.querySelector('p')?.textContent).toBe('Could not be fully checked');
    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Its storage key could not be searched; check where it is used before deleting',
    ]);
    expect(container.textContent).not.toMatch(/Used in/);
  });
});
