import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS description-block actions of a product write the product's draft (`product_drafts.blocks`),
 * read first, then written by id. Since migration 02043 a publish deletes the draft in the transaction
 * that makes it live, so a block edit whose UPDATE waited on the publish's row lock, or landed just
 * after it, finds the row gone. Without `.select()` supabase-js reported that UPDATE as a success and
 * the edit was lost without a word; now each action says it was not saved. (The block ids an edit
 * names were the published draft's, so it is not replayed into a new draft.)
 */

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

const mocks = vi.hoisted(() => ({
  /** Whether the draft row is still there when the action's UPDATE runs. */
  draftStillThere: true,
  draftUpdates: [] as unknown[],
  revalidatePath: vi.fn(),
  getOrCreateProductDraft: vi.fn(),
}));

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'writer-1' } }, error: null }) },
    from(table: string) {
      let op = 'select';
      let selectedAfterWrite = false;
      const chain: Record<string, any> = {};
      chain.select = () => {
        if (op !== 'select') selectedAfterWrite = true;
        return chain;
      };
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.update = (values: unknown) => {
        op = 'update';
        if (table === 'product_drafts') mocks.draftUpdates.push(values);
        return chain;
      };
      const answer = () => {
        if (table === 'profiles') return { data: { role: 'WRITER' }, error: null };
        if (table === 'products') return { data: { id: 'source-product' }, error: null };
        if (table === 'product_drafts' && op === 'update') {
          return { data: selectedAfterWrite ? (mocks.draftStillThere ? [{ id: 3 }] : []) : null, error: null };
        }
        if (table === 'product_drafts') return { data: null, error: null };
        if (table === 'blocks') return { data: [{ block_type: 'text', content: { html_content: '<p>Source</p>' }, order: 0 }], error: null };
        return { data: null, error: null };
      };
      chain.single = async () => answer();
      chain.maybeSingle = async () => answer();
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return chain;
    },
  };
}

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', () => ({ createClient: () => makeClient() }));
vi.mock('../../../lib/visual-editing/product-drafts', () => ({
  getOrCreateProductDraft: mocks.getOrCreateProductDraft,
}));
vi.mock('../../../lib/visual-editing/draft-content', () => ({ getOrCreateContentDraft: vi.fn() }));

import {
  copyBlocksFromLanguage,
  createBlockForProduct,
  deleteBlock,
  updateBlock,
  updateMultipleBlockOrders,
} from './actions';
import { PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR } from '../../../lib/visual-editing/product-draft-meta';

const ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ['adding a block', () => createBlockForProduct(PRODUCT_ID, 1, 'text' as any, 1)],
  ['editing a block', () => updateBlock(5, { html_content: '<p>Edited</p>' }, null, null, PRODUCT_ID)],
  ['reordering blocks', () => updateMultipleBlockOrders([{ id: 5, order: 1 }], null, null, PRODUCT_ID)],
  ['deleting a block', () => deleteBlock(5, null, null, PRODUCT_ID)],
  ['copying blocks from another language', () => copyBlocksFromLanguage(PRODUCT_ID, 'product', 1, 2, 'group-1')],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.draftStillThere = true;
  mocks.draftUpdates = [];
  mocks.getOrCreateProductDraft.mockResolvedValue({
    id: 3,
    product_id: PRODUCT_ID,
    author_id: 'writer-1',
    meta: {},
    blocks: [{ id: 5, product_id: PRODUCT_ID, language_id: 1, block_type: 'text', content: { html_content: '<p>Draft</p>' }, order: 0 }],
    created_at: '',
    updated_at: '',
  });
});

describe("a product's block actions never report a draft write that matched nothing as saved", () => {
  it.each(ACTIONS)('%s: says it was not saved when the draft was published or discarded meanwhile', async (_label, run) => {
    mocks.draftStillThere = false;

    await expect(run()).resolves.toEqual({ error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR });
    expect(mocks.draftUpdates).toHaveLength(1);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)('%s: still succeeds while the draft is there', async (_label, run) => {
    await expect(run()).resolves.toMatchObject({ success: true });
    expect(mocks.draftUpdates).toHaveLength(1);
  });
});
