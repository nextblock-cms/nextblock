// components/BlockRenderer.tsx
import React from "react";
import type { Database } from "@nextblock-cms/db";
import type { SectionBlockContent } from "../lib/blocks/blockRegistry";
import { buildVisualEditAttributes } from "../lib/visual-editing/edit-info";
import type {
  VisualEditAttributes,
  VisualEditingDocumentContext,
} from "../lib/visual-editing/types";
import { getPublicBlockRendererLoader } from "./blocks/publicRendererLoaders";
import { getSsgSupabaseClient } from "@nextblock-cms/db/server";
import { unstable_cache } from "next/cache";
import { headers } from "next/headers";
import { SITE_SETTINGS_CACHE_TAG } from "../app/lib/site-settings";
import { PUBLIC_CONTENT_REVALIDATE_SECONDS } from "../lib/public-content-cache";

type Block = Database['public']['Tables']['blocks']['Row'];
import SectionBlockRenderer from "./blocks/renderers/SectionBlockRenderer"; // Static import for LCP
import ClientTextBlockRenderer from "./blocks/renderers/ClientTextBlockRenderer"; // Static import for client component
import { addNonceToInlineScripts } from "../lib/blocks/inlineScriptNonce";
import { getCachedCustomBlockDefinitionBySlug } from "../lib/custom-block-definitions";
import { CachedDynamicLayoutEngine } from "./renderers/CachedDynamicLayoutEngine";
import { resolveBlockRelations } from "../lib/resolve-block-relations";
import { substitutePrivacyMergeTags } from "../lib/privacy/contact-emails";

const ECOMMERCE_BLOCK_TYPES = new Set([
  "product_grid",
  "featured_product",
  "cart",
  "checkout",
  "product_details",
]);

type BotProtectionPublicSettings = {
  provider: 'none' | 'turnstile' | 'recaptcha';
  siteKey: string;
};

/**
 * The public half of the bot-protection settings (provider + site key), read through
 * the anon client — `bot_protection_public` is outside the sensitive-key list of
 * `site_settings_read_policy`, and it is the same value every visitor receives. Cached
 * like the other public reads; the settings action revalidates the root layout, whose
 * implicit tag covers this entry.
 */
const getCachedBotProtectionPublic = unstable_cache(
  async (): Promise<BotProtectionPublicSettings | undefined> => {
    const { data } = await getSsgSupabaseClient()
      .from('site_settings')
      .select('value')
      .eq('key', 'bot_protection_public')
      .maybeSingle();
    if (!data?.value) return undefined;
    const publicVal = data.value as Record<string, any>;
    return {
      provider: publicVal.provider || 'none',
      siteKey: publicVal.siteKey || '',
    };
  },
  ['public-bot-protection'],
  { revalidate: PUBLIC_CONTENT_REVALIDATE_SECONDS, tags: [SITE_SETTINGS_CACHE_TAG] },
);

function loadEcommerceBlockRenderer(blockType: string) {
  return import("./blocks/ecommerceRendererLoaders").then((module) =>
    module.loadEcommerceBlockRenderer(blockType)
  );
}

interface BlockRendererProps {
  blocks: Block[];
  languageId: number;
  excludeProductId?: string;
  excludeTranslationGroupId?: string | null;
  visualEditing?: VisualEditingDocumentContext;
  productVisualEditingEnabled?: boolean;
}

interface BlockRenderContext {
  block: Block;
  blockIndex: number;
  languageId: number;
  excludeProductId?: string;
  excludeTranslationGroupId?: string | null;
  visualEditing?: VisualEditingDocumentContext;
  productVisualEditingEnabled?: boolean;
  visualEditAttributes?: VisualEditAttributes;
  botProtectionPublic?: {
    provider: 'none' | 'turnstile' | 'recaptcha';
    siteKey: string;
  };
  scriptNonce?: string;
}

async function renderLoadedBlock({
  block,
  blockIndex,
  languageId,
  excludeProductId,
  excludeTranslationGroupId,
  visualEditing,
  productVisualEditingEnabled,
  visualEditAttributes,
  botProtectionPublic,
  scriptNonce,
}: BlockRenderContext) {
  const rendererLoader = getPublicBlockRendererLoader(block.block_type);

  if (!rendererLoader) {
    if (ECOMMERCE_BLOCK_TYPES.has(block.block_type)) {
      const { default: EcommerceRendererComponent } = await loadEcommerceBlockRenderer(
        block.block_type
      );

      return (
        <EcommerceRendererComponent
          content={block.content}
          languageId={languageId}
          excludeProductId={excludeProductId}
          excludeTranslationGroupId={excludeTranslationGroupId}
          visualEditAttributes={visualEditAttributes}
          productVisualEditingEnabled={productVisualEditingEnabled}
          visualEditing={visualEditing}
        />
      );
    }

    const definition = await getCachedCustomBlockDefinitionBySlug(block.block_type);
    if (definition) {
      const resolvedBlock = (await resolveBlockRelations({
        data: block.content as Record<string, any>,
        fields: definition.fields,
      })) as any;

      return (
        <div key={block.id} {...visualEditAttributes}>
          <CachedDynamicLayoutEngine
            definition={definition}
            layoutSchema={definition.layout_schema}
            fields={definition.fields}
            data={{
              ...(resolvedBlock.data || {}),
              resolved_relations: resolvedBlock.resolved_relations || {},
            }}
          />
        </div>
      );
    }

    // No renderer and no matching custom block definition. Public visitors
    // should never see a raw error/JSON dump, so only surface the diagnostic
    // when visual editing is actually enabled (the page always passes a
    // visualEditing object, so check the enabled flag); otherwise render nothing.
    if (!visualEditing?.enabled) {
      return null;
    }

    return (
      <div
        key={block.id}
        className="my-4 p-4 border rounded bg-destructive/10 text-destructive"
        {...visualEditAttributes}
      >
        <p>
          <strong>Unsupported block type:</strong> {block.block_type}
        </p>
        <p className="text-xs mt-1">
          No custom block definition was found for the slug{' '}
          <code>{block.block_type}</code>. Save a custom block with this exact slug,
          or re-add the block from the picker.
        </p>
        <pre className="text-xs whitespace-pre-wrap mt-2">
          {JSON.stringify(block.content, null, 2)}
        </pre>
      </div>
    );
  }

  // Keep common LCP-adjacent text blocks out of the dynamic renderer manifest.
  if (block.block_type === 'text') {
    // Top-level text blocks bypass the server TextBlockRenderer, so everything it
    // would have done to the HTML has to happen here too: merge tags (e.g.
    // {{privacy_email}} on the Privacy/Terms pages) and — because the CSP carries a
    // nonce, which makes browsers ignore 'unsafe-inline' — the inline-script nonce.
    // Without the latter, an inline <script> an editor wrote into a rich-text block
    // is dropped by the browser with nothing failing server-side.
    const textContent = block.content as { html_content?: string } | null;
    const rawHtml = typeof textContent?.html_content === 'string' ? textContent.html_content : '';
    const merged = rawHtml.includes('{{')
      ? await substitutePrivacyMergeTags(rawHtml)
      : rawHtml;
    const html = addNonceToInlineScripts(merged, scriptNonce ?? '');
    return (
      <ClientTextBlockRenderer
        content={{ ...(textContent as any), html_content: html }}
        languageId={languageId}
        visualEditAttributes={visualEditAttributes}
        // First top-level block is above the fold: preload its first embed's poster.
        priority={blockIndex === 0}
      />
    );
  }

  const { default: RendererComponent } = await rendererLoader();

  // Handle different prop requirements for different renderers
  // PostsGridBlockRenderer needs the full block object
  if (block.block_type === 'posts_grid') {
    return (
      <RendererComponent
        content={block.content}
        languageId={languageId}
        block={block}
        visualEditAttributes={visualEditAttributes}
      />
    );
  }

  return (
    <RendererComponent
      content={stripServerOnlyContent(block.block_type, block.content)}
      languageId={languageId}
      excludeProductId={excludeProductId}
      excludeTranslationGroupId={excludeTranslationGroupId}
      visualEditAttributes={visualEditAttributes}
      productVisualEditingEnabled={productVisualEditingEnabled}
      visualEditing={visualEditing}
      parentBlockId={block.id}
      parentBlockIndex={blockIndex}
      botProtectionPublic={botProtectionPublic}
      scriptNonce={scriptNonce}
      // The first top-level block is above the fold, so its media is the LCP
      // candidate. Renderers that own an image (video_embed's poster frame)
      // use this to preload instead of lazy-loading it.
      priority={blockIndex === 0}
    />
  );
}

/**
 * Last line of defence before block content crosses into a client component, where
 * everything is serialized into the RSC payload.
 *
 * Migration 27 removed `recipient_email` from every stored form block, but an install
 * can still acquire one: a CSV/JSON import, a restored revision, or a fork that has not
 * run the migration. Stripping it here means an un-migrated block degrades to "no
 * recipient" (the server resolves one from settings) rather than publishing an address.
 */
function stripServerOnlyContent(blockType: string, content: unknown): unknown {
  if (blockType !== 'form' || !content || typeof content !== 'object') return content;
  if (!('recipient_email' in (content as Record<string, unknown>))) return content;
  const { recipient_email: _dropped, ...safe } = content as Record<string, unknown>;
  return safe;
}

async function renderBlock(context: BlockRenderContext) {
  const { block, blockIndex, languageId, visualEditAttributes, visualEditing } = context;

  if (block.block_type === 'section') {
    return (
      <SectionBlockRenderer
        content={block.content as unknown as SectionBlockContent}
        languageId={languageId}
        visualEditAttributes={visualEditAttributes}
        visualEditing={visualEditing}
        parentBlockId={block.id}
        parentBlockIndex={blockIndex}
        blockType={block.block_type}
        botProtectionPublic={context.botProtectionPublic}
        scriptNonce={context.scriptNonce}
      />
    );
  }

  return renderLoadedBlock(context);
}

export default async function BlockRenderer({
  blocks,
  languageId,
  excludeProductId,
  excludeTranslationGroupId,
  visualEditing,
  productVisualEditingEnabled,
}: BlockRendererProps) {
  if (!blocks || blocks.length === 0) {
    return null;
  }

  let botProtectionPublic: { provider: 'none' | 'turnstile' | 'recaptcha'; siteKey: string } | undefined;
  let scriptNonce = '';

  try {
    scriptNonce = (await headers()).get('x-nonce') || '';
  } catch (e) {
    console.error("[Bot Protection] Error loading CSP nonce in BlockRenderer:", e);
  }

  try {
    botProtectionPublic = await getCachedBotProtectionPublic();
  } catch (e) {
    console.error("[Bot Protection] Error loading settings in BlockRenderer:", e);
  }

  const renderedBlocks = await Promise.all(
    blocks.map(async (block, blockIndex) => ({
      id: block.id,
      node: await renderBlock({
        block,
        blockIndex,
        languageId,
        excludeProductId,
        excludeTranslationGroupId,
        visualEditing,
        productVisualEditingEnabled,
        botProtectionPublic,
        scriptNonce,
        visualEditAttributes: buildVisualEditAttributes(visualEditing, {
          kind: "top-level",
          blockId: block.id,
          blockIndex,
          blockType: block.block_type,
        }),
      }),
    }))
  );

  return (
    <>
      {renderedBlocks.map(({ id, node }) => (
        <React.Fragment key={id}>{node}</React.Fragment>
      ))}
    </>
  );
}
