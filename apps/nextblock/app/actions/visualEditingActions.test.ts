import { beforeEach, describe, expect, it, vi } from "vitest";

const draftContentMocks = vi.hoisted(() => ({
  findDraftBlock: vi.fn(),
  getCurrentUserCanEdit: vi.fn(),
  getOrCreateContentDraft: vi.fn(),
  getPublicPath: vi.fn((parentType: string, slug: string) =>
    parentType === "page" ? `/${slug}` : `/article/${slug}`
  ),
  normalizeContentDraftRow: vi.fn((row) => row),
  readPublishedSnapshot: vi.fn(),
  updateDraftBlockContent: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("server-only", () => ({}));
const revisionMocks = vi.hoisted(() => ({
  createPageRevision: vi.fn(),
  createPostRevision: vi.fn(),
  getFullPageContent: vi.fn(),
  getFullPostContent: vi.fn(),
}));

vi.mock("../cms/revisions/utils", () => ({
  getFullPageContent: revisionMocks.getFullPageContent,
  getFullPostContent: revisionMocks.getFullPostContent,
}));
vi.mock("../cms/revisions/service", () => ({
  createPageRevision: revisionMocks.createPageRevision,
  createPostRevision: revisionMocks.createPostRevision,
}));
vi.mock("../../lib/visual-editing/draft-content", () => draftContentMocks);
vi.mock("../../lib/visual-editing/product-drafts", () => ({
  discardProductVisualEditingDraft: vi.fn(),
  loadProductVisualEditingField: vi.fn(),
  publishProductVisualEditingDraft: vi.fn(),
}));

import {
  discardVisualEditingDraft,
  publishVisualEditingDraft,
  saveVisualEditingBlockDraft,
} from "./visualEditingActions";

const baseDraft = {
  id: 1,
  parent_type: "page",
  parent_id: 2,
  author_id: "user-1",
  base_version: 1,
  meta: { slug: "about" },
  blocks: [
    {
      id: 10,
      page_id: 2,
      post_id: null,
      language_id: 1,
      block_type: "text",
      content: { html_content: "<p>Old</p>" },
      order: 0,
    },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const request = {
  parentType: "page" as const,
  parentId: 2,
  target: {
    kind: "top-level" as const,
    blockId: 10,
    blockIndex: 0,
    blockType: "text",
  },
};

describe("visual editing server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves block edits to content_drafts and revalidates the draft path", async () => {
    const savedDraft = {
      ...baseDraft,
      blocks: [
        {
          ...baseDraft.blocks[0],
          content: { html_content: "<p>New</p>" },
        },
      ],
    };
    const single = vi.fn().mockResolvedValue({ data: savedDraft, error: null });
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));

    draftContentMocks.getCurrentUserCanEdit.mockResolvedValue({
      user: { id: "user-1" },
      canEdit: true,
      supabase: { from },
    });
    draftContentMocks.getOrCreateContentDraft.mockResolvedValue(baseDraft);
    draftContentMocks.updateDraftBlockContent.mockReturnValue(savedDraft);

    const result = await saveVisualEditingBlockDraft(request, {
      html_content: "<p>New</p>",
    });

    expect(result).toMatchObject({ success: true });
    expect(from).toHaveBeenCalledWith("content_drafts");
    expect(update).toHaveBeenCalledWith({
      author_id: "user-1",
      blocks: savedDraft.blocks,
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/about");
  });

  it("returns setup guidance when draft storage is missing", async () => {
    draftContentMocks.getCurrentUserCanEdit.mockResolvedValue({
      user: { id: "user-1" },
      canEdit: true,
      supabase: {},
    });
    draftContentMocks.getOrCreateContentDraft.mockRejectedValue(
      new Error(
        "Failed to read content draft: Could not find the table 'public.content_drafts' in the schema cache"
      )
    );

    const result = await saveVisualEditingBlockDraft(request, {
      html_content: "<p>New</p>",
    });

    expect(result).toEqual({
      error:
        "Draft storage is not set up in this database. Apply the schema (npm run db:migrate or the /setup wizard); content_drafts is created by the baseline schema migration.",
    });
  });

  it("discards a draft snapshot", async () => {
    const deleteChain: any = {
      error: null,
      eq: vi.fn(() => deleteChain),
    };
    const from = vi.fn(() => ({
      delete: vi.fn(() => deleteChain),
    }));
    draftContentMocks.getCurrentUserCanEdit.mockResolvedValue({
      user: { id: "user-1" },
      canEdit: true,
      supabase: { from },
    });

    const result = await discardVisualEditingDraft("page", 2);

    expect(result).toEqual({ success: true });
    expect(from).toHaveBeenCalledWith("content_drafts");
    expect(deleteChain.eq).toHaveBeenCalledWith("parent_type", "page");
    expect(deleteChain.eq).toHaveBeenCalledWith("parent_id", 2);
  });

  it("returns an error when publishing without an existing draft", async () => {
    const readChain: any = {
      select: vi.fn(() => readChain),
      eq: vi.fn(() => readChain),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const from = vi.fn(() => readChain);
    draftContentMocks.getCurrentUserCanEdit.mockResolvedValue({
      user: { id: "user-1" },
      canEdit: true,
      supabase: { from },
    });

    const result = await publishVisualEditingDraft("page", 2);

    expect(result).toEqual({ error: "No draft exists for this content." });
    expect(from).toHaveBeenCalledWith("content_drafts");
  });

  describe("publishing a page draft", () => {
    const previousContent = { meta: { title: "Before" }, blocks: [] };
    const nextContent = { meta: { title: "After" }, blocks: [] };

    /**
     * Publishing is the only path that writes the live tables, so it is also the only
     * place a page/post revision gets recorded. The chain here mirrors the real one:
     * read the draft, update the row, swap the blocks, delete the draft.
     */
    function mockPublishChain() {
      const chain: any = {
        delete: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        error: null,
        insert: vi.fn(() => chain),
        maybeSingle: vi.fn().mockResolvedValue({ data: baseDraft, error: null }),
        select: vi.fn(() => chain),
        update: vi.fn(() => chain),
      };
      const from = vi.fn(() => chain);
      draftContentMocks.getCurrentUserCanEdit.mockResolvedValue({
        canEdit: true,
        supabase: { from },
        user: { id: "user-1" },
      });
      return { chain, from };
    }

    it("records a revision from the pre-publish state", async () => {
      mockPublishChain();
      revisionMocks.getFullPageContent
        .mockResolvedValueOnce(previousContent)
        .mockResolvedValueOnce(nextContent);
      revisionMocks.createPageRevision.mockResolvedValue({
        recorded: true,
        success: true,
        version: 2,
      });

      const result = await publishVisualEditingDraft("page", 2);

      expect(result).toEqual({ success: true });
      expect(revisionMocks.createPageRevision).toHaveBeenCalledWith(
        2,
        "user-1",
        previousContent,
        nextContent
      );
    });

    it("still completes the publish when the revision fails, and warns instead of erroring", async () => {
      const { chain } = mockPublishChain();
      revisionMocks.getFullPageContent
        .mockResolvedValueOnce(previousContent)
        .mockResolvedValueOnce(nextContent);
      revisionMocks.createPageRevision.mockResolvedValue({
        error: "Failed to insert page revision: permission denied",
      });

      const result = await publishVisualEditingDraft("page", 2);

      // The page row and its blocks are already live at this point. Aborting would strand
      // the draft row and leave the public route un-revalidated, which is worse than a
      // missing history entry — so this is a partial success, not a failure.
      expect(result).toMatchObject({
        success: true,
        warning: expect.stringContaining("history was not recorded"),
      });
      expect(chain.delete).toHaveBeenCalled();
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/about");
    });

    // Review 2026-11-15: a failed draft delete returned before the revalidation, so visitors kept the
    // old version for up to five minutes while the CMS said it was published.
    it("refreshes the live page before the draft delete, and reports a failed delete as published with its warning", async () => {
      const { chain } = mockPublishChain();
      const draftsChain: any = {
        select: vi.fn(() => draftsChain),
        eq: vi.fn(() => draftsChain),
        maybeSingle: vi.fn().mockResolvedValue({ data: baseDraft, error: null }),
        delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: { message: "connection reset" } }) })),
      };
      draftContentMocks.getCurrentUserCanEdit.mockResolvedValue({
        canEdit: true,
        supabase: { from: vi.fn((table: string) => (table === "content_drafts" ? draftsChain : chain)) },
        user: { id: "user-1" },
      });
      revisionMocks.getFullPageContent.mockResolvedValueOnce(previousContent).mockResolvedValueOnce(nextContent);
      revisionMocks.createPageRevision.mockResolvedValue({ error: "Failed to insert page revision: permission denied" });

      const result = await publishVisualEditingDraft("page", 2);

      expect(result).toEqual({
        error:
          "Published, but failed to remove draft: connection reset. Published, but history was not recorded: Failed to insert page revision: permission denied",
      });
      expect(draftsChain.delete).toHaveBeenCalled();
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/about");
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/cms/pages/2/edit");
    });
  });
});
