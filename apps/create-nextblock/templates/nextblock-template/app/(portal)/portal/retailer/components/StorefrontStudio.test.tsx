// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_PORTAL_COPY, AffiliatesCopyProvider } from '@nextblock-cms/affiliates';

/**
 * The studio hands the copilot panel its availability: the page's localized "assistant
 * unavailable" reason (Cortex AI inactive) disables the panel and wins over the editing lock;
 * without it the panel follows the editing lock exactly as before.
 */

const mocks = vi.hoisted(() => ({ panelProps: [] as Array<Record<string, unknown>> }));

vi.mock('../../../../../components/affiliates/StorefrontCopilotPanel', () => ({
  StorefrontCopilotPanel: (props: Record<string, unknown>) => {
    mocks.panelProps.push(props);
    return null;
  },
}));
vi.mock('@nextblock-cms/affiliates/editor', () => ({ StorefrontEditor: () => null }));
vi.mock('../actions', () => ({
  resolveStorefrontProducts: vi.fn(),
  saveStorefrontDraft: vi.fn(),
  searchStorefrontProducts: vi.fn(),
  submitStorefrontForReview: vi.fn(),
  withdrawStorefrontSubmission: vi.fn(),
}));
vi.mock('./upload-client', () => ({ uploadPortalImage: vi.fn() }));
vi.mock('./ProfileCard', () => ({ ProfileCard: () => null }));
vi.mock('./FeaturedProductsCard', () => ({ FeaturedProductsCard: () => null }));
vi.mock('./StorefrontPreview', () => ({ StorefrontPreview: () => null }));

import { saveStorefrontDraft } from '../actions';
import { StorefrontStudio, type StorefrontStudioProps } from './StorefrontStudio';

const UNAVAILABLE = AFFILIATES_PORTAL_COPY['affiliates.portal.copilot_unavailable'].en;
const LOCKED_SUSPENDED = AFFILIATES_PORTAL_COPY['affiliates.portal.studio_locked_suspended'].en;
const TOO_LARGE = AFFILIATES_PORTAL_COPY['affiliates.portal.error_storefront_too_large'].en;
const SAVE_FAILED = AFFILIATES_PORTAL_COPY['affiliates.portal.autosave_error'].en;

const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.panelProps = [];
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
});

function studioProps(overrides: Partial<StorefrontStudioProps> = {}): StorefrontStudioProps {
  return {
    siteOrigin: 'https://shop.example.com',
    allowedImageOrigins: ['https://media.example.com'],
    suspended: false,
    isLive: false,
    profile: { displayName: 'Jane', bio: '', socialLinks: {}, preferredLocale: 'en' },
    avatarUrl: null,
    page: {
      title: 'My picks',
      metaDescription: '',
      doc: { type: 'doc', content: [] },
      featuredProductIds: [],
      featuredProducts: [],
      draftVersion: 1,
      approvalStatus: 'DRAFT',
      adminFeedbackNote: null,
    },
    profileChangedSincePublish: false,
    ...overrides,
  };
}

async function renderStudio(props: StorefrontStudioProps): Promise<Record<string, unknown>> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      <AffiliatesCopyProvider locale="en">
        <StorefrontStudio {...props} />
      </AffiliatesCopyProvider>,
    );
  });
  const last = mocks.panelProps.at(-1);
  expect(last).toBeDefined();
  return last as Record<string, unknown>;
}

describe('StorefrontStudio copilot panel availability', () => {
  it('keeps the panel enabled on an editable page when the copilot is available', async () => {
    const panel = await renderStudio(studioProps());
    expect(panel['disabled']).toBe(false);
    expect(panel['disabledReason']).toBeNull();
  });

  it("disables the panel with the page's reason when the copilot is unavailable", async () => {
    const panel = await renderStudio(studioProps({ copilotUnavailableReason: UNAVAILABLE }));
    expect(panel['disabled']).toBe(true);
    expect(panel['disabledReason']).toBe(UNAVAILABLE);
  });

  it('shows the unavailable reason over the editing lock', async () => {
    const panel = await renderStudio(studioProps({ suspended: true, copilotUnavailableReason: UNAVAILABLE }));
    expect(panel['disabled']).toBe(true);
    expect(panel['disabledReason']).toBe(UNAVAILABLE);
  });

  it('still follows the editing lock when the copilot is available', async () => {
    const panel = await renderStudio(studioProps({ suspended: true, copilotUnavailableReason: null }));
    expect(panel['disabled']).toBe(true);
    expect(panel['disabledReason']).toBe(LOCKED_SUSPENDED);
  });
});

describe('StorefrontStudio autosave errors', () => {
  /** Types a new page title, then saves at once (the copilot panel's flush before an insert). */
  async function editAndSave(panel: Record<string, unknown>, title: string) {
    const input = document.querySelector<HTMLInputElement>('input[aria-describedby$="-title-count"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, title);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await (panel['onBeforeInsert'] as () => Promise<void>)();
    });
    return document.querySelector('[role="status"]')?.textContent;
  }

  it('says the page is too large when the database refuses the save, and keeps the generic message for other failures', async () => {
    const save = vi.mocked(saveStorefrontDraft);
    save.mockReset();
    save.mockResolvedValueOnce({ ok: false, error: 'too_large' }).mockResolvedValueOnce({ ok: false, error: 'unknown' });
    const panel = await renderStudio(studioProps());

    expect(await editAndSave(panel, 'My picks, updated')).toBe(TOO_LARGE);
    expect(await editAndSave(panel, 'My picks, shorter')).toBe(SAVE_FAILED);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
