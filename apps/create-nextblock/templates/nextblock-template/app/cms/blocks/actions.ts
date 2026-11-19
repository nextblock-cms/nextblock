// app/cms/blocks/actions.ts
"use server";

import { createClient } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import type { Database } from "@nextblock-cms/db";
import { getInitialContent, isValidBlockType } from "../../../lib/blocks/blockRegistry";
import { getOrCreateContentDraft } from "../../../lib/visual-editing/draft-content";
import { getOrCreateProductDraft } from "../../../lib/visual-editing/product-drafts";
import { PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR } from "../../../lib/visual-editing/product-draft-meta";

type BlockType = Database['public']['Tables']['blocks']['Row']['block_type'];

/**
 * Whether a product draft UPDATE ... select("id") matched no row: the draft was published or
 * discarded after this action read it (publish_product_draft deletes it in the transaction that makes
 * it live, so a save that waited on its lock finds it gone). Without the select, supabase-js reports
 * such an UPDATE as a success, and the edit was lost without a word.
 */
function isProductDraftGone(rows: unknown) {
  return !Array.isArray(rows) || rows.length === 0;
}

// Helper to verify user can edit the parent (page/post)
async function canEditParent(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  pageId?: number | null,
  postId?: number | null,
  productId?: string | null
): Promise<boolean> {
  void pageId;
  void postId;
  void productId;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
    return false;
  }
  return true;
}

export async function createBlockForPage(pageId: number, languageId: number, blockType: BlockType, order: number) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { error: "User not authenticated." };
  if (!(await canEditParent(supabase, user.id, pageId, null))) {
    return { error: "Unauthorized to add blocks to this page." };
  }

  // Validate block type using registry
  if (!isValidBlockType(blockType)) {
    return { error: "Unknown block type." };
  }

  // Get initial content from registry
  const initialContent = getInitialContent(blockType);
  if (!initialContent) {
    return { error: "Failed to get initial content for block type." };
  }

  try {
    const draft = await getOrCreateContentDraft(supabase, "page", pageId, user.id);
    let newBlockId = -1 - Math.floor(Math.random() * 9999999);
    while (draft.blocks.some(b => b.id === newBlockId)) {
      newBlockId = -1 - Math.floor(Math.random() * 9999999);
    }

    const newBlock = {
      id: newBlockId,
      page_id: pageId,
      post_id: null,
      language_id: languageId,
      block_type: blockType,
      content: initialContent,
      order: order,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedBlocks = [...draft.blocks, newBlock];
    updatedBlocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const { error: updateError } = await supabase
      .from("content_drafts")
      .update({ blocks: updatedBlocks as any })
      .eq("id", draft.id);

    if (updateError) {
      console.error("Error creating draft block for page:", updateError);
      return { error: `Failed to save draft block: ${updateError.message}` };
    }

    revalidatePath(`/cms/pages/${pageId}/edit`);
    return { success: true, newBlock: newBlock as any };
  } catch (err: any) {
    console.error("Error getting draft for page blocks update:", err);
    return { error: `Failed to load page draft: ${err.message || err}` };
  }
}

export async function createBlockForPost(postId: number, languageId: number, blockType: BlockType, order: number) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { error: "User not authenticated." };
  if (!(await canEditParent(supabase, user.id, null, postId))) {
    return { error: "Unauthorized to add blocks to this post." };
  }

  // Validate block type using registry
  if (!isValidBlockType(blockType)) {
    return { error: "Unknown block type." };
  }

  // Get initial content from registry
  const initialContent = getInitialContent(blockType);
  if (!initialContent) {
    return { error: "Failed to get initial content for block type." };
  }

  try {
    const draft = await getOrCreateContentDraft(supabase, "post", postId, user.id);
    let newBlockId = -1 - Math.floor(Math.random() * 9999999);
    while (draft.blocks.some(b => b.id === newBlockId)) {
      newBlockId = -1 - Math.floor(Math.random() * 9999999);
    }

    const newBlock = {
      id: newBlockId,
      page_id: null,
      post_id: postId,
      language_id: languageId,
      block_type: blockType,
      content: initialContent,
      order: order,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedBlocks = [...draft.blocks, newBlock];
    updatedBlocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const { error: updateError } = await supabase
      .from("content_drafts")
      .update({ blocks: updatedBlocks as any })
      .eq("id", draft.id);

    if (updateError) {
      console.error("Error creating draft block for post:", updateError);
      return { error: `Failed to save draft block: ${updateError.message}` };
    }

    revalidatePath(`/cms/posts/${postId}/edit`);
    return { success: true, newBlock: newBlock as any };
  } catch (err: any) {
    console.error("Error getting draft for post blocks update:", err);
    return { error: `Failed to load post draft: ${err.message || err}` };
  }
}

export async function createBlockForProduct(productId: string, languageId: number, blockType: BlockType, order: number) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { error: "User not authenticated." };
  if (!(await canEditParent(supabase, user.id, null, null, productId))) {
    return { error: "Unauthorized to add blocks to this product." };
  }

  // Validate block type using registry
  if (!isValidBlockType(blockType)) {
    return { error: "Unknown block type." };
  }

  // Get initial content from registry
  const initialContent = getInitialContent(blockType);
  if (!initialContent) {
    return { error: "Failed to get initial content for block type." };
  }

  try {
    const draft = await getOrCreateProductDraft(supabase, productId, user.id);
    let newBlockId = -1 - Math.floor(Math.random() * 9999999);
    while (draft.blocks && draft.blocks.some(b => b.id === newBlockId)) {
      newBlockId = -1 - Math.floor(Math.random() * 9999999);
    }

    const newBlock = {
      id: newBlockId,
      page_id: null,
      post_id: null,
      product_id: productId,
      language_id: languageId,
      block_type: blockType,
      content: initialContent,
      order: order,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedBlocks = [...(draft.blocks || []), newBlock];
    updatedBlocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const { data: savedDrafts, error: updateError } = await supabase
      .from("product_drafts")
      .update({ blocks: updatedBlocks as any })
      .eq("id", draft.id)
      .select("id");

    if (updateError) {
      console.error("Error creating draft block for product:", updateError);
      return { error: `Failed to save draft block: ${updateError.message}` };
    }
    if (isProductDraftGone(savedDrafts)) {
      return { error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR };
    }

    revalidatePath(`/cms/products/${productId}/edit`);
    return { success: true, newBlock: newBlock as any };
  } catch (err: any) {
    console.error("Error getting draft for product blocks update:", err);
    return { error: `Failed to load product draft: ${err.message || err}` };
  }
}

export async function updateBlock(
  blockId: number,
  newContent: unknown,
  pageId?: number | null,
  postId?: number | null,
  productId?: string | null
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { error: "User not authenticated." };
  if (!(await canEditParent(supabase, user.id, pageId, postId, productId))) {
    return { error: "Unauthorized to update this block." };
  }

  if (productId) {
    try {
      const draft = await getOrCreateProductDraft(supabase, productId, user.id);
      const existingBlock = (draft.blocks || []).find(b => b.id === blockId);
      if (!existingBlock) {
        return { error: "Block not found in draft." };
      }

      const updatedBlocks = (draft.blocks || []).map(b => 
        b.id === blockId 
          ? { ...b, content: newContent as any, updated_at: new Date().toISOString() } 
          : b
      );

      const { data: savedDrafts, error: updateError } = await supabase
        .from("product_drafts")
        .update({ blocks: updatedBlocks as any })
        .eq("id", draft.id)
        .select("id");

      if (updateError) {
        console.error("Error updating draft block content for product:", updateError);
        return { error: `Failed to update draft block: ${updateError.message}` };
      }
      if (isProductDraftGone(savedDrafts)) {
        return { error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR };
      }

      return { success: true, updatedBlock: { ...existingBlock, content: newContent } as any };
    } catch (err: any) {
      console.error("Error getting draft for product block content update:", err);
      return { error: `Failed to load product draft: ${err.message || err}` };
    }
  } else {
    const parentType = pageId ? "page" : "post";
    const parentId = pageId || postId;
    if (!parentId) return { error: "Missing pageId or postId." };

    try {
      const draft = await getOrCreateContentDraft(supabase, parentType, parentId, user.id);
      const existingBlock = draft.blocks.find(b => b.id === blockId);
      if (!existingBlock) {
        return { error: "Block not found in draft." };
      }

      const updatedBlocks = draft.blocks.map(b => 
        b.id === blockId 
          ? { ...b, content: newContent as any, updated_at: new Date().toISOString() } 
          : b
      );

      const { error: updateError } = await supabase
        .from("content_drafts")
        .update({ blocks: updatedBlocks as any })
        .eq("id", draft.id);

      if (updateError) {
        console.error("Error updating draft block content:", updateError);
        return { error: `Failed to update draft block: ${updateError.message}` };
      }

      return { success: true, updatedBlock: { ...existingBlock, content: newContent } as any };
    } catch (err: any) {
      console.error("Error getting draft for block content update:", err);
      return { error: `Failed to load draft: ${err.message || err}` };
    }
  }
}

export async function updateMultipleBlockOrders(
    updates: Array<{ id: number; order: number }>,
    pageId?: number | null,
    postId?: number | null,
    productId?: string | null
) {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return { error: "User not authenticated." };
    if (!(await canEditParent(supabase, user.id, pageId, postId, productId))) {
        return { error: "Unauthorized to reorder blocks." };
    }

    if (productId) {
      try {
        const draft = await getOrCreateProductDraft(supabase, productId, user.id);
        const updatedBlocks = (draft.blocks || []).map(b => {
          const update = updates.find(u => u.id === b.id);
          if (update) {
            return { ...b, order: update.order, updated_at: new Date().toISOString() };
          }
          return b;
        });

        updatedBlocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        const { data: savedDrafts, error: updateError } = await supabase
          .from("product_drafts")
          .update({ blocks: updatedBlocks as any })
          .eq("id", draft.id)
          .select("id");

        if (updateError) {
          console.error("Error updating draft blocks order for product:", updateError);
          return { error: `Failed to save blocks order draft: ${updateError.message}` };
        }
        if (isProductDraftGone(savedDrafts)) {
          return { error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR };
        }

        revalidatePath(`/cms/products/${productId}/edit`);
        return { success: true };
      } catch (err: any) {
        console.error("Error getting draft for product blocks order update:", err);
        return { error: `Failed to load product draft: ${err.message || err}` };
      }
    } else {
      const parentType = pageId ? "page" : "post";
      const parentId = pageId || postId;
      if (!parentId) return { error: "Missing pageId or postId." };

      try {
        const draft = await getOrCreateContentDraft(supabase, parentType, parentId, user.id);
        const updatedBlocks = draft.blocks.map(b => {
          const update = updates.find(u => u.id === b.id);
          if (update) {
            return { ...b, order: update.order, updated_at: new Date().toISOString() };
          }
          return b;
        });

        updatedBlocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        const { error: updateError } = await supabase
          .from("content_drafts")
          .update({ blocks: updatedBlocks as any })
          .eq("id", draft.id);

        if (updateError) {
          console.error("Error updating draft blocks order:", updateError);
          return { error: `Failed to save blocks order draft: ${updateError.message}` };
        }

        if (pageId) revalidatePath(`/cms/pages/${pageId}/edit`);
        if (postId) revalidatePath(`/cms/posts/${postId}/edit`);

        return { success: true };
      } catch (err: any) {
        console.error("Error getting draft for blocks order update:", err);
        return { error: `Failed to load draft: ${err.message || err}` };
      }
    }
}

export async function deleteBlock(
  blockId: number,
  pageId?: number | null,
  postId?: number | null,
  productId?: string | null
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { error: "User not authenticated." };
  if (!(await canEditParent(supabase, user.id, pageId, postId, productId))) {
    return { error: "Unauthorized to delete this block." };
  }

  if (productId) {
    try {
      const draft = await getOrCreateProductDraft(supabase, productId, user.id);
      const updatedBlocks = (draft.blocks || []).filter(b => b.id !== blockId);

      const { data: savedDrafts, error: updateError } = await supabase
        .from("product_drafts")
        .update({ blocks: updatedBlocks as any })
        .eq("id", draft.id)
        .select("id");

      if (updateError) {
        console.error("Error deleting draft block for product:", updateError);
        return { error: `Failed to delete block from product draft: ${updateError.message}` };
      }
      if (isProductDraftGone(savedDrafts)) {
        return { error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR };
      }

      revalidatePath(`/cms/products/${productId}/edit`);
      return { success: true };
    } catch (err: any) {
      console.error("Error getting draft for product block deletion:", err);
      return { error: `Failed to load product draft: ${err.message || err}` };
    }
  } else {
    const parentType = pageId ? "page" : "post";
    const parentId = pageId || postId;
    if (!parentId) return { error: "Missing pageId or postId." };

    try {
      const draft = await getOrCreateContentDraft(supabase, parentType, parentId, user.id);
      const updatedBlocks = draft.blocks.filter(b => b.id !== blockId);

      const { error: updateError } = await supabase
        .from("content_drafts")
        .update({ blocks: updatedBlocks as any })
        .eq("id", draft.id);

      if (updateError) {
        console.error("Error deleting draft block:", updateError);
        return { error: `Failed to delete block from draft: ${updateError.message}` };
      }

      if (pageId) revalidatePath(`/cms/pages/${pageId}/edit`);
      if (postId) revalidatePath(`/cms/posts/${postId}/edit`);

      return { success: true };
    } catch (err: any) {
      console.error("Error getting draft for block deletion:", err);
      return { error: `Failed to load draft: ${err.message || err}` };
    }
  }
}

export async function copyBlocksFromLanguage(
  parentId: number | string, // ID of the page, post, or product being edited
  parentType: "page" | "post" | "product",
  sourceLanguageId: number,
  targetLanguageId: number, // Language of the target being edited
  targetTranslationGroupId: string
) {
  "use server";
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: "User not authenticated." };
  }

  if (!(await canEditParent(supabase, user.id, parentType === "page" ? parentId as number : null, parentType === "post" ? parentId as number : null, parentType === "product" ? parentId as string : null))) {
    return { error: "Unauthorized to modify blocks for this target." };
  }

  let sourceParentId: number | string | null = null;

  try {
    if (parentType === "page") {
      const { data: sourcePage, error: sourcePageError } = await supabase
        .from("pages")
        .select("id")
        .eq("translation_group_id", targetTranslationGroupId)
        .eq("language_id", sourceLanguageId)
        .single();

      if (sourcePageError || !sourcePage) {
        console.error("Error fetching source page:", sourcePageError);
        return { error: "Source page not found or error fetching it." };
      }
      sourceParentId = sourcePage.id;
    } else if (parentType === "post") {
      const { data: sourcePost, error: sourcePostError } = await supabase
        .from("posts")
        .select("id")
        .eq("translation_group_id", targetTranslationGroupId)
        .eq("language_id", sourceLanguageId)
        .single();

      if (sourcePostError || !sourcePost) {
        console.error("Error fetching source post:", sourcePostError);
        return { error: "Source post not found or error fetching it." };
      }
      sourceParentId = sourcePost.id;
    } else if (parentType === "product") {
      const { data: sourceProduct, error: sourceProductError } = await supabase
        .from("products")
        .select("id")
        .eq("translation_group_id", targetTranslationGroupId)
        .eq("language_id", sourceLanguageId)
        .single();

      if (sourceProductError || !sourceProduct) {
        console.error("Error fetching source product:", sourceProductError);
        return { error: "Source product not found or error fetching it." };
      }
      sourceParentId = sourceProduct.id;
    } else {
      return { error: "Invalid parent type specified." };
    }

    if (!sourceParentId) {
        return { error: "Could not determine source parent ID." };
    }

    let blocksToCopy: any[] = [];
    if (parentType === "product") {
      // 1. Check if source draft exists
      const { data: sourceDraft } = await supabase
        .from("product_drafts")
        .select("blocks")
        .eq("product_id", sourceParentId)
        .maybeSingle();

      if (sourceDraft && sourceDraft.blocks && Array.isArray(sourceDraft.blocks)) {
        blocksToCopy = sourceDraft.blocks;
      } else {
        // 2. Fetch live blocks from source
        const { data: liveBlocks, error: sourceBlocksError } = await supabase
          .from("blocks")
          .select("block_type, content, order")
          .eq("product_id", sourceParentId)
          .order("order", { ascending: true });

        if (sourceBlocksError) {
          console.error("Error fetching source blocks:", sourceBlocksError);
          return { error: `Failed to fetch blocks from source: ${sourceBlocksError.message}` };
        }
        blocksToCopy = liveBlocks || [];
      }
    } else {
      // 1. Check if source draft exists
      const { data: sourceDraft } = await supabase
        .from("content_drafts")
        .select("blocks")
        .eq("parent_type", parentType)
        .eq("parent_id", sourceParentId)
        .maybeSingle();

      if (sourceDraft && sourceDraft.blocks && Array.isArray(sourceDraft.blocks)) {
        blocksToCopy = sourceDraft.blocks;
      } else {
        // 2. Fetch live blocks from source
        const { data: liveBlocks, error: sourceBlocksError } = await supabase
          .from("blocks")
          .select("block_type, content, order")
          .eq(parentType === "page" ? "page_id" : "post_id", sourceParentId)
          .order("order", { ascending: true });

        if (sourceBlocksError) {
          console.error("Error fetching source blocks:", sourceBlocksError);
          return { error: `Failed to fetch blocks from source: ${sourceBlocksError.message}` };
        }
        blocksToCopy = liveBlocks || [];
      }
    }

    // 3. Generate new blocks with negative IDs for draft array
    const copiedBlocks = blocksToCopy.map((block: any, index: number) => {
      const newId = -1 - Math.floor(Math.random() * 9999999);
      return {
        id: newId,
        page_id: null,
        post_id: null,
        product_id: parentType === "product" ? (parentId as string) : null,
        language_id: targetLanguageId,
        block_type: block.block_type,
        content: block.content,
        order: block.order ?? index,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    if (parentType === "product") {
      // 4. Load or create target draft and update blocks
      const targetDraft = await getOrCreateProductDraft(supabase, parentId as string, user.id);
      const { data: savedDrafts, error: updateError } = await supabase
        .from("product_drafts")
        .update({ blocks: copiedBlocks as any })
        .eq("id", targetDraft.id)
        .select("id");

      if (updateError) {
        console.error("Error writing copied blocks to target product draft:", updateError);
        return { error: `Failed to copy blocks to draft: ${updateError.message}` };
      }
      if (isProductDraftGone(savedDrafts)) {
        return { error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR };
      }

      revalidatePath(`/cms/products/${parentId}/edit`);
    } else {
      // 4. Load or create target draft and update blocks
      const targetDraft = await getOrCreateContentDraft(supabase, parentType, parentId as number, user.id);
      const { error: updateError } = await supabase
        .from("content_drafts")
        .update({ blocks: copiedBlocks as any })
        .eq("id", targetDraft.id);

      if (updateError) {
        console.error("Error writing copied blocks to target draft:", updateError);
        return { error: `Failed to copy blocks to draft: ${updateError.message}` };
      }

      // 5. Revalidation
      if (parentType === "page") {
          revalidatePath(`/cms/pages/${parentId}/edit`);
      } else if (parentType === "post") {
          revalidatePath(`/cms/posts/${parentId}/edit`);
      }
    }

    return { success: true, message: "Blocks copied successfully." };

  } catch (e: unknown) {
    console.error("Unexpected error in copyBlocksFromLanguage:", e);
    const errorMessage = e instanceof Error ? e.message : "An unknown error occurred";
    return { error: `An unexpected error occurred: ${errorMessage}` };
  }
}
