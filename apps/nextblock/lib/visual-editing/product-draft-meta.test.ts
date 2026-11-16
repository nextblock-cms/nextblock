import { describe, expect, it } from 'vitest';

import {
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
  PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY,
  PRODUCT_DRAFT_LEGACY_FIELDS_KEY,
  PRODUCT_PUBLISH_ADMIN_ONLY_NOTE,
  buildProductOverlayUpdate,
  classifyProductDraftMeta,
  describeProductDraftOverlayFields,
  describeSkippedProductDraftOverlay,
  describeSkippedProductDraftOverlayNotice,
  hasProductDraftFormMarker,
  isLegacyProductRowSnapshot,
  isLegacySnapshotDescriptionAnInPageEdit,
  isLiveProductUnchangedSinceDraft,
  joinProductFieldLabels,
  jsonValuesEqual,
  legacyProductDraftMetaAsOverlay,
  pickProductDraftOverlayValues,
  planProductDraftOverlayPublish,
  readRecordedLegacySnapshotFields,
  resolveProductDraftOverlayDisplay,
  withoutProductDraftFormMarker,
  withoutRecordedLegacySnapshotField,
  withProductDraftFormMarker,
} from './product-draft-meta';

/**
 * Until 0.23.4 a block edit or an in-page edit created the product draft with the raw products row
 * as `meta` (minor units, `id` included, no variants), and publish read any meta with a `sku` or a
 * `price` as product form values: every price x100, every variant deleted, the description and the
 * sale schedule cleared. These shapes are what the classifier has to tell apart.
 */

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

/** What getOrCreateProductDraft() stored before 0.23.4 (readProductSnapshot's field list). */
const LEGACY_ROW_SNAPSHOT = {
  id: PRODUCT_ID,
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: null,
  price: 4900,
  prices: { USD: 4900, EUR: 4500 },
  sale_price: null,
  sale_prices: null,
  is_taxable: false,
  product_type: 'digital',
  payment_provider: 'freemius',
  short_description: 'Short copy',
  stock: 0,
  status: 'active',
  language_id: 1,
  translation_group_id: '223e4567-e89b-12d3-a456-426614174000',
  meta_title: null,
  meta_description: null,
  custom_canonical: null,
  freemius_product_id: '123',
  freemius_plan_id: '456',
  trial_period_days: 0,
  trial_requires_payment_method: false,
};

/** What the product form's autosave stores (major units, always a variants array, never an id). */
const FORM_VALUES = {
  product_type: 'physical',
  payment_provider: 'stripe',
  title: 'Mug',
  slug: 'mug',
  sku: 'MUG',
  price: 49,
  prices: { USD: 49 },
  sale_price: null,
  sale_prices: {},
  stock: 3,
  is_taxable: true,
  status: 'active',
  language_id: 1,
  description_json: { type: 'doc', content: [] },
  product_media: [{ media_id: 'm1' }],
  category_ids: [],
  variation_attributes: [],
  variants: [],
};

/** What a CMS import in draft mode stores (major units; no id; variants always set in draft mode). */
const CMS_DRAFT_IMPORT = {
  language_id: 1,
  title: 'Imported',
  slug: 'imported',
  sku: 'IMP',
  price: 29.5,
  prices: { USD: 29.5 },
  variants: [],
  product_media: [],
  category_ids: [],
};

describe('classifyProductDraftMeta', () => {
  it('reads a pre-0.23.4 row snapshot (an id and no variants) as a legacy snapshot, not product values', () => {
    expect(isLegacyProductRowSnapshot(LEGACY_ROW_SNAPSHOT)).toBe(true);
    expect(classifyProductDraftMeta(LEGACY_ROW_SNAPSHOT)).toBe('legacy-row-snapshot');
  });

  it('keeps a legacy snapshot legacy after in-page edits', () => {
    expect(
      classifyProductDraftMeta({
        ...LEGACY_ROW_SNAPSHOT,
        title: 'Edited in page',
        description_json: { type: 'doc', content: [] },
      })
    ).toBe('legacy-row-snapshot');
  });

  it('reads the form autosave and a CMS draft import as product values', () => {
    expect(classifyProductDraftMeta(FORM_VALUES)).toBe('product-values');
    expect(classifyProductDraftMeta(CMS_DRAFT_IMPORT)).toBe('product-values');
    // A partial product-values meta still counts: publish fills the rest from the live row.
    expect(classifyProductDraftMeta({ sku: 'PRO' })).toBe('product-values');
    expect(classifyProductDraftMeta({ price: 59 })).toBe('product-values');
  });

  it('reads a block-seeded draft and in-page edits as an overlay', () => {
    expect(classifyProductDraftMeta({})).toBe('overlay');
    expect(classifyProductDraftMeta({ title: 'New title' })).toBe('overlay');
    expect(
      classifyProductDraftMeta({
        title: 'New title',
        short_description: null,
        description_json: { type: 'doc', content: [] },
      })
    ).toBe('overlay');
  });

  it('reads anything that is not an object as an overlay', () => {
    expect(classifyProductDraftMeta(null)).toBe('overlay');
    expect(classifyProductDraftMeta(undefined)).toBe('overlay');
    expect(classifyProductDraftMeta([])).toBe('overlay');
    expect(classifyProductDraftMeta('meta')).toBe('overlay');
  });
});

describe('pickProductDraftOverlayValues', () => {
  it('takes only the overlay fields, normalized the way publish writes them', () => {
    expect(pickProductDraftOverlayValues(LEGACY_ROW_SNAPSHOT)).toEqual({
      title: 'Pro plugin',
      short_description: 'Short copy',
    });
    expect(
      pickProductDraftOverlayValues({ title: '  ', short_description: 42, description_json: 'not json' })
    ).toEqual({ short_description: null, description_json: null });
    expect(pickProductDraftOverlayValues({})).toEqual({});
  });
});

describe('buildProductOverlayUpdate', () => {
  const live = {
    title: 'Pro plugin',
    short_description: 'Short copy',
    description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
  };

  it('writes nothing for a legacy snapshot whose overlay fields still match the live row', () => {
    expect(buildProductOverlayUpdate(LEGACY_ROW_SNAPSHOT, live)).toEqual({});
    expect(buildProductOverlayUpdate({}, live)).toEqual({});
  });

  it('writes only the fields that differ, and never a price, a variant or the schedule', () => {
    const update = buildProductOverlayUpdate(
      {
        ...LEGACY_ROW_SNAPSHOT,
        title: 'Renamed',
        description_json: { content: [{ type: 'paragraph' }], type: 'doc' },
      },
      live
    );
    expect(update).toEqual({ title: 'Renamed' });
  });

  it('clears a description the overlay set to null', () => {
    expect(buildProductOverlayUpdate({ description_json: null }, live)).toEqual({ description_json: null });
  });
});

describe('jsonValuesEqual', () => {
  it('ignores object key order and compares arrays in order', () => {
    expect(jsonValuesEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonValuesEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(jsonValuesEqual(null, null)).toBe(true);
    expect(jsonValuesEqual(null, {})).toBe(false);
    expect(jsonValuesEqual('a', 'a')).toBe(true);
  });
});

describe('the 0.23.4 product-values marker', () => {
  it('is one key the form autosave and a CMS draft import stamp, and a later version may raise', () => {
    expect([PRODUCT_DRAFT_FORM_MARKER_KEY, PRODUCT_DRAFT_FORM_MARKER_VALUE]).toEqual(['form_version', 2]);

    const marked = withProductDraftFormMarker(FORM_VALUES);
    expect(marked).toEqual({ ...FORM_VALUES, form_version: 2 });
    expect(hasProductDraftFormMarker(marked)).toBe(true);
    expect(hasProductDraftFormMarker({ ...FORM_VALUES, form_version: 3 })).toBe(true);
    expect(classifyProductDraftMeta(marked)).toBe('product-values');
  });

  it('is absent from every draft an earlier version wrote', () => {
    expect(hasProductDraftFormMarker(FORM_VALUES)).toBe(false);
    expect(hasProductDraftFormMarker(LEGACY_ROW_SNAPSHOT)).toBe(false);
    expect(hasProductDraftFormMarker({ ...FORM_VALUES, form_version: '2' })).toBe(false);
    expect(hasProductDraftFormMarker({ ...FORM_VALUES, form_version: 1 })).toBe(false);
    expect(hasProductDraftFormMarker(null)).toBe(false);
  });

  it('comes off before the values reach updateProduct() or the form', () => {
    expect(withoutProductDraftFormMarker(withProductDraftFormMarker(FORM_VALUES))).toEqual(FORM_VALUES);
    expect(withoutProductDraftFormMarker(FORM_VALUES)).toBe(FORM_VALUES);
  });
});

describe('isLiveProductUnchangedSinceDraft: products.updated_at at or before product_drafts.created_at', () => {
  it('compares the two timestamps, microseconds and offsets included', () => {
    expect(isLiveProductUnchangedSinceDraft('2026-06-01T10:00:00+00:00', '2026-06-02T09:00:00.123456+00:00')).toBe(true);
    expect(isLiveProductUnchangedSinceDraft('2026-06-02T09:00:00.123+00:00', '2026-06-02T09:00:00.123456+00:00')).toBe(true);
    expect(isLiveProductUnchangedSinceDraft('2026-06-02T05:00:00-04:00', '2026-06-02T08:59:59+00:00')).toBe(false);
    expect(isLiveProductUnchangedSinceDraft('2026-10-15T08:00:00+00:00', '2026-06-02T09:00:00+00:00')).toBe(false);
  });

  it('counts a missing or unreadable timestamp as changed', () => {
    expect(isLiveProductUnchangedSinceDraft(null, '2026-06-02T09:00:00+00:00')).toBe(false);
    expect(isLiveProductUnchangedSinceDraft('2026-06-01T10:00:00+00:00', '')).toBe(false);
    expect(isLiveProductUnchangedSinceDraft('not a date', '2026-06-02T09:00:00+00:00')).toBe(false);
  });
});

describe('planProductDraftOverlayPublish: what an overlay or legacy publish writes to the products row', () => {
  const live = {
    title: 'Pro plugin, rewritten',
    short_description: 'Short copy',
    description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
    updated_at: '2026-10-15T08:00:00+00:00',
  };

  it("writes an overlay's differing fields whenever: they are in-page edits made since 0.23.4", () => {
    expect(planProductDraftOverlayPublish({ title: 'New title' }, live, '2026-06-02T09:00:00+00:00')).toEqual({
      update: { title: 'New title' },
      skipped: [],
    });
  });

  it("writes a legacy snapshot's differing fields while the live row is unchanged since the draft was created", () => {
    expect(
      planProductDraftOverlayPublish(LEGACY_ROW_SNAPSHOT, { ...live, updated_at: '2026-06-01T10:00:00+00:00' }, '2026-06-02T09:00:00+00:00')
    ).toEqual({ update: { title: 'Pro plugin' }, skipped: [] });
  });

  it('skips them, and names them, once the live row changed after that', () => {
    const plan = planProductDraftOverlayPublish(LEGACY_ROW_SNAPSHOT, live, '2026-06-02T09:00:00+00:00');

    expect(plan).toEqual({ update: {}, skipped: ['title'] });
    expect(describeSkippedProductDraftOverlay(plan.skipped)).toContain("the draft's title was not published");
  });

  it('skips nothing when the snapshot matches the live row', () => {
    expect(
      planProductDraftOverlayPublish({ ...LEGACY_ROW_SNAPSHOT, title: live.title }, live, '2026-06-02T09:00:00+00:00')
    ).toEqual({ update: {}, skipped: [] });
  });

  it('joins field labels for the messages', () => {
    expect(joinProductFieldLabels(['title'])).toBe('title');
    expect(joinProductFieldLabels(['title', 'description'])).toBe('title and description');
    expect(joinProductFieldLabels(['prices', 'variants', 'gallery'])).toBe('prices, variants and gallery');
    expect(describeProductDraftOverlayFields(['title', 'short_description', 'description_json'])).toBe(
      'title, short description and description'
    );
  });
});

/**
 * Verify round 5, probe A: the in-page editor saved into a legacy snapshot with
 * `{ ...draft.meta, [field]: content }`, so the draft stayed a legacy snapshot, and once the product
 * changed after the draft was created publish skipped that edit, and the next one, every time.
 */
describe('legacyProductDraftMetaAsOverlay: an in-page save into a pre-0.23.4 row snapshot', () => {
  const DRAFT_CREATED_AT = '2026-06-02T09:00:00+00:00';
  const live = {
    title: 'Pro plugin',
    short_description: 'Short copy',
    description_json: null,
    // A visibility change after the block edit that created the draft is enough.
    updated_at: '2026-11-10T10:00:00+00:00',
  };

  it('probe A: the edit, then every later one, publishes once the draft is rewritten as an overlay', () => {
    const legacy = { id: PRODUCT_ID, title: 'Pro plugin', slug: 'pro-plugin', sku: 'PRO', price: 4900, short_description: 'Short copy' };

    // What the save wrote before the fix: still a legacy snapshot, so the edit is skipped.
    const keptLegacy = { ...legacy, title: 'Pro plugin 2' };
    expect(classifyProductDraftMeta(keptLegacy)).toBe('legacy-row-snapshot');
    expect(planProductDraftOverlayPublish(keptLegacy, live, DRAFT_CREATED_AT)).toEqual({ update: {}, skipped: ['title'] });

    // What it writes now: the overlay publish would write today (nothing: the product changed), plus the edit.
    const afterFirstEdit = { ...legacyProductDraftMetaAsOverlay(legacy, live, DRAFT_CREATED_AT), title: 'Pro plugin 2' };
    expect(afterFirstEdit).toEqual({ title: 'Pro plugin 2' });
    expect(classifyProductDraftMeta(afterFirstEdit)).toBe('overlay');
    expect(planProductDraftOverlayPublish(afterFirstEdit, live, DRAFT_CREATED_AT)).toEqual({
      update: { title: 'Pro plugin 2' },
      skipped: [],
    });

    // A later save spreads an overlay, so it stays one and publishes too.
    const afterSecondEdit = { ...afterFirstEdit, short_description: 'New short copy' };
    expect(classifyProductDraftMeta(afterSecondEdit)).toBe('overlay');
    expect(planProductDraftOverlayPublish(afterSecondEdit, live, DRAFT_CREATED_AT)).toEqual({
      update: { title: 'Pro plugin 2', short_description: 'New short copy' },
      skipped: [],
    });
  });

  it('keeps what publish would write while the product is unchanged, and records it as a snapshot field', () => {
    const unchanged = { ...live, updated_at: '2026-06-01T10:00:00+00:00' };
    const legacyWithEdit = {
      id: PRODUCT_ID,
      title: 'Renamed in page before the upgrade',
      sku: 'PRO',
      price: 4900,
      short_description: 'Short copy',
    };

    const overlay = legacyProductDraftMetaAsOverlay(legacyWithEdit, unchanged, DRAFT_CREATED_AT, 'short_description');

    // The short description still equals live, so only the title is kept; no id, no price, no sku. The
    // title may be an in-page edit or an old copy a write that left updated_at alone has overwritten
    // since, so it keeps the rule, against the snapshot's created_at.
    expect(overlay).toEqual({
      title: 'Renamed in page before the upgrade',
      [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['title'],
      [PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY]: DRAFT_CREATED_AT,
    });
    expect(classifyProductDraftMeta({ ...overlay, description_json: { type: 'doc', content: [] } })).toBe('overlay');
  });

  it('keeps nothing when the timestamps cannot be read (treated as changed)', () => {
    expect(
      legacyProductDraftMetaAsOverlay({ id: PRODUCT_ID, title: 'Old title', sku: 'PRO' }, { ...live, updated_at: null }, DRAFT_CREATED_AT)
    ).toEqual({});
  });

  it('records neither the field being saved nor a description that is an in-page edit', () => {
    const unchanged = { ...live, updated_at: '2026-06-01T10:00:00+00:00' };
    const inPage = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'In page' }] }] };
    const legacy = { id: PRODUCT_ID, title: 'Old title', short_description: 'Old short', sku: 'PRO', description_json: inPage };

    // Saving the title: the short description is recorded; the June draft's description is not.
    expect(legacyProductDraftMetaAsOverlay(legacy, unchanged, DRAFT_CREATED_AT, 'title')).toEqual({
      title: 'Old title',
      short_description: 'Old short',
      description_json: inPage,
      [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['short_description'],
      [PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY]: DRAFT_CREATED_AT,
    });
    // In a draft from before 2026-05-28 the description may be the seed's copy: recorded too.
    const may = '2026-05-25T09:00:00+00:00';
    expect(legacyProductDraftMetaAsOverlay(legacy, { ...unchanged, updated_at: '2026-05-24T00:00:00+00:00' }, may, 'title')).toEqual({
      title: 'Old title',
      short_description: 'Old short',
      description_json: inPage,
      [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['short_description', 'description_json'],
      [PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY]: may,
    });
  });

  it("keeps a June draft's in-page description after a live change, unrecorded (probe D)", () => {
    const inPage = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited in page in June' }] }] };
    const legacy = { id: PRODUCT_ID, title: 'Pro plugin', sku: 'PRO', price: 4900, short_description: 'Short copy', description_json: inPage };

    expect(legacyProductDraftMetaAsOverlay(legacy, live, '2026-06-10T09:00:00+00:00', 'title')).toEqual({ description_json: inPage });
  });
});

describe('a legacy snapshot created from 2026-05-28 on holds its description as an in-page edit (decision 3)', () => {
  const inPage = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited in page' }] }] };
  const changedLive = {
    title: 'Pro plugin, rewritten',
    short_description: 'Short copy',
    description_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live' }] }] },
    updated_at: '2026-11-10T10:00:00+00:00',
  };
  const snapshot = { ...LEGACY_ROW_SNAPSHOT, description_json: inPage };

  it('starts at 2026-05-28T00:00Z: 3d6942f2 took description_json out of the seed on 2026-05-27, and 0.8.11 shipped without it', () => {
    expect(isLegacySnapshotDescriptionAnInPageEdit('2026-05-28T00:00:00+00:00')).toBe(true);
    expect(isLegacySnapshotDescriptionAnInPageEdit('2026-06-10T09:00:00.123456+00:00')).toBe(true);
    expect(isLegacySnapshotDescriptionAnInPageEdit('2026-05-27T19:59:59-04:00')).toBe(false);
    expect(isLegacySnapshotDescriptionAnInPageEdit('2026-05-25T09:00:00+00:00')).toBe(false);
    expect(isLegacySnapshotDescriptionAnInPageEdit('')).toBe(false);
    expect(isLegacySnapshotDescriptionAnInPageEdit(null)).toBe(false);
  });

  it('writes that description after a live change and skips only the title', () => {
    expect(planProductDraftOverlayPublish(snapshot, changedLive, '2026-06-10T09:00:00+00:00')).toEqual({
      update: { description_json: inPage },
      skipped: ['title'],
    });
    expect(resolveProductDraftOverlayDisplay(snapshot, changedLive, '2026-06-10T09:00:00+00:00')).toEqual({
      description_json: inPage,
    });
  });

  it('keeps the rule for the description of an earlier draft, or one whose created_at cannot be read', () => {
    for (const createdAt of ['2026-05-25T09:00:00+00:00', null]) {
      expect(planProductDraftOverlayPublish(snapshot, changedLive, createdAt)).toEqual({
        update: {},
        skipped: ['title', 'description_json'],
      });
    }
  });
});

describe('the snapshot fields an overlay recorded keep the rule (decision 4)', () => {
  const SNAPSHOT_CREATED_AT = '2026-06-02T09:00:00+00:00';
  const converted = {
    title: 'Pro plugin - Basic',
    short_description: 'New short copy',
    [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['title'],
    [PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY]: SNAPSHOT_CREATED_AT,
  };
  const live = { title: 'Pro plugin - Growth', short_description: 'Short copy', description_json: null };

  it('stays an overlay, and the keys are no overlay field: no products update ever carries them', () => {
    expect(classifyProductDraftMeta(converted)).toBe('overlay');
    expect(readRecordedLegacySnapshotFields(converted)).toEqual(['title']);
    expect(buildProductOverlayUpdate(converted, live)).toEqual({ title: 'Pro plugin - Basic', short_description: 'New short copy' });
  });

  it('L1: skips the recorded title once the product changed after the snapshot, whatever the draft row says', () => {
    const changed = { ...live, updated_at: '2026-11-14T12:00:00+00:00' };
    // The draft row's own created_at is not what the rule reads for a recorded field.
    const plan = planProductDraftOverlayPublish(converted, changed, '2026-11-20T00:00:00+00:00');

    expect(plan).toEqual({ update: { short_description: 'New short copy' }, skipped: ['title'] });
    expect(describeSkippedProductDraftOverlay(plan.skipped)).toContain("the draft's title was not published");
    // The preview and the in-page editor show the live title then.
    expect(resolveProductDraftOverlayDisplay(converted, changed, '2026-11-20T00:00:00+00:00')).toEqual({
      short_description: 'New short copy',
    });
  });

  it('L2: writes it while the product is unchanged since the snapshot', () => {
    const unchanged = { ...live, title: 'Pro plugin - Starter', updated_at: '2026-06-01T10:00:00+00:00' };

    expect(planProductDraftOverlayPublish(converted, unchanged, SNAPSHOT_CREATED_AT)).toEqual({
      update: { title: 'Pro plugin - Basic', short_description: 'New short copy' },
      skipped: [],
    });
  });

  it('counts a missing or unreadable recorded created_at as changed', () => {
    const unchanged = { ...live, updated_at: '2026-06-01T10:00:00+00:00' };
    const withoutTime = { ...converted, [PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY]: undefined };

    expect(planProductDraftOverlayPublish(withoutTime, unchanged, SNAPSHOT_CREATED_AT).skipped).toEqual(['title']);
  });

  it('takes a field out of the list once it is saved in the page again, and both keys with the last one', () => {
    const two = { ...converted, [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['title', 'short_description'] };

    expect(withoutRecordedLegacySnapshotField(two, 'title')).toEqual({
      ...converted,
      [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['short_description'],
    });
    expect(withoutRecordedLegacySnapshotField({ ...converted, title: 'Edited again' }, 'title')).toEqual({
      title: 'Edited again',
      short_description: 'New short copy',
    });
    // A field that is not recorded leaves the meta as it is.
    expect(withoutRecordedLegacySnapshotField(converted, 'description_json')).toBe(converted);
  });
});

describe('resolveProductDraftOverlayDisplay: what the storefront preview and the in-page editor show', () => {
  const DRAFT_CREATED_AT = '2026-06-02T09:00:00+00:00';
  const changedLive = {
    title: 'Pro plugin, rewritten',
    short_description: 'Short copy',
    description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
    updated_at: '2026-10-15T08:00:00+00:00',
  };

  it("shows nothing of a legacy snapshot that publish would skip, so the live title shows (the probe's preview)", () => {
    expect(resolveProductDraftOverlayDisplay(LEGACY_ROW_SNAPSHOT, changedLive, DRAFT_CREATED_AT)).toEqual({});
  });

  it("shows a legacy snapshot's differing fields while the product is unchanged since the draft was created", () => {
    expect(
      resolveProductDraftOverlayDisplay(
        LEGACY_ROW_SNAPSHOT,
        { ...changedLive, updated_at: '2026-06-01T10:00:00+00:00' },
        DRAFT_CREATED_AT
      )
    ).toEqual({ title: 'Pro plugin' });
  });

  it('shows the overlay fields any other meta stages, as staged (null included)', () => {
    expect(
      resolveProductDraftOverlayDisplay({ title: 'New title', description_json: null }, changedLive, DRAFT_CREATED_AT)
    ).toEqual({ title: 'New title', description_json: null });
    expect(resolveProductDraftOverlayDisplay(FORM_VALUES, changedLive, DRAFT_CREATED_AT)).toEqual({
      title: 'Mug',
      description_json: { type: 'doc', content: [] },
    });
    expect(resolveProductDraftOverlayDisplay({}, changedLive, DRAFT_CREATED_AT)).toEqual({});
    expect(resolveProductDraftOverlayDisplay(null, changedLive, DRAFT_CREATED_AT)).toEqual({});
  });
});

describe('the messages about a skipped legacy snapshot and who publishes', () => {
  it("the edit page's note says the form's autosave makes publish write the form, whether or not it saved on open", () => {
    const notice = describeSkippedProductDraftOverlayNotice(['title']);

    // Not "its description blocks only": a June snapshot's in-page description, or an in-page edit
    // beside a recorded snapshot field, publishes with the blocks.
    expect(notice).toContain('so publishing it leaves the live title in place');
    expect(notice).toContain('The form shows the live title; edit it again if you still want the draft\'s version.');
    expect(notice).toContain(
      "Once the form saves into the draft (a change to any field autosaves it), publishing writes the form's values as well."
    );
    expect(describeSkippedProductDraftOverlayNotice(['title', 'description_json'])).toContain(
      'The form shows the live title and description; edit them again'
    );
  });

  it('keeps the publish warning naming what it skipped, and what it wrote beside the blocks', () => {
    expect(describeSkippedProductDraftOverlay(['title', 'short_description'])).toContain(
      "the draft's title and short description were not published"
    );
    expect(describeSkippedProductDraftOverlay(['title'])).toMatch(/^Published the description blocks only\. /);
    expect(describeSkippedProductDraftOverlay(['title'], ['short_description', 'description_json'])).toMatch(
      /^Published the description blocks and the draft's short description and description\. This draft was created before NextBlock 0\.23\.4 and the product changed after that, so the draft's title was not published/
    );
  });

  it('says beside a disabled Publish who publishes product changes', () => {
    expect(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE).toBe('An administrator publishes product changes.');
  });
});
