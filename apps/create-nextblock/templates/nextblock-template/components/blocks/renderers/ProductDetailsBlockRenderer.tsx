import React from 'react';
import type { VisualEditAttributes, VisualEditingDocumentContext } from '../../../lib/visual-editing/types';
import { headers } from 'next/headers';
import { createClient } from "@nextblock-cms/db/server";
import { getProviderReadiness } from "@nextblock-cms/ecommerce/pages/cms/payments/queries";
import BlockRenderer from "../../BlockRenderer";
import {
  LazyContactSellerSection,
  LazyProductDetailsLayout,
  LazyProductReviewsSection,
} from "../../commerce/LazyCommerceClients";
import PaymentReadinessBoundary from "../../commerce/PaymentReadinessBoundary";
import { getRequiredPackagesForFreemiusProduct } from "@nextblock-cms/utils/nextblock-packages";
import { loadAddonBaseProducts } from "../../../lib/commerce/addon-base-products";

interface ProductDetailsBlockRendererProps {
  visualEditAttributes?: VisualEditAttributes;
  productVisualEditingEnabled?: boolean;
  excludeProductId?: string;
  languageId: number;
  visualEditing?: VisualEditingDocumentContext;
}

export default async function ProductDetailsBlockRenderer({
  visualEditAttributes,
  productVisualEditingEnabled = false,
  excludeProductId,
  languageId,
  visualEditing,
}: ProductDetailsBlockRendererProps) {
  const supabase = createClient();
  
  let descriptionBlocks: any[] = [];
  let productSlug = "";
  let productDraftId: number | null = null;
  // Default to purchasable: a store that is set up correctly must never be degraded by
  // a lookup that failed for some unrelated reason.
  let canPurchase = true;
  // An add-on license (Affiliates needs Commerce Pro): the products it needs, for the notice above
  // its purchase controls. Read only for an add-on.
  let addonBaseProducts: Awaited<ReturnType<typeof loadAddonBaseProducts>> = [];

  if (excludeProductId) {
    const { data: productInfo } = await supabase
      .from('products')
      .select('slug, payment_provider, freemius_product_id')
      .eq('id', excludeProductId)
      .maybeSingle();

    if (productInfo) {
      productSlug = productInfo.slug;

      if (getRequiredPackagesForFreemiusProduct(productInfo.freemius_product_id).length > 0) {
        addonBaseProducts = await loadAddonBaseProducts(languageId);
      }

      const provider = productInfo.payment_provider;
      if (provider === 'stripe' || provider === 'freemius') {
        try {
          const readiness = await getProviderReadiness(provider);
          canPurchase = readiness.ready;
        } catch (error) {
          console.error('[ProductDetails] Could not resolve payment readiness:', error);
        }
      }
    }

    let hasDraft = false;
    if (productVisualEditingEnabled) {
      const { data: draftData } = await supabase
        .from('product_drafts')
        .select('id, blocks')
        .eq('product_id', excludeProductId)
        .maybeSingle();

      // The draft's blocks are what Publish writes, an empty list included: publish deletes the
      // live ones then, so the preview shows none rather than the live blocks it is about to remove.
      if (draftData) {
        hasDraft = true;
        productDraftId = draftData.id;
        descriptionBlocks = Array.isArray(draftData.blocks) ? draftData.blocks : [];
      }
    }

    if (!hasDraft) {
      const { data: liveBlocks } = await supabase
        .from('blocks')
        .select('*')
        .eq('product_id', excludeProductId)
        .order('order', { ascending: true });
      descriptionBlocks = liveBlocks || [];
    }
  }

  const productDescriptionVisualEditing = {
    enabled: productVisualEditingEnabled,
    documentType: "product" as const,
    documentId: excludeProductId!,
    slug: productSlug,
    languageId: languageId,
    draftId: productDraftId,
  };

  // Bot protection for the enquiry form, resolved the same way BlockRenderer does for
  // the contact-form block. Only read when the form will actually render.
  let botProtection: { provider: 'none' | 'turnstile' | 'recaptcha'; siteKey: string } = {
    provider: 'none',
    siteKey: '',
  };
  let scriptNonce = '';

  if (!canPurchase && excludeProductId) {
    try {
      scriptNonce = (await headers()).get('x-nonce') || '';
    } catch (error) {
      console.error('[Bot Protection] Error loading CSP nonce in ProductDetails:', error);
    }

    try {
      const { data: publicSetting } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', 'bot_protection_public')
        .maybeSingle();
      if (publicSetting?.value) {
        const publicVal = publicSetting.value as Record<string, any>;
        botProtection = {
          provider: publicVal.provider || 'none',
          siteKey: publicVal.siteKey || '',
        };
      }
    } catch (error) {
      console.error('[Bot Protection] Error loading settings in ProductDetails:', error);
    }
  }

  const descriptionNode = descriptionBlocks.length > 0 ? (
    <BlockRenderer 
      blocks={descriptionBlocks} 
      languageId={languageId} 
      productVisualEditingEnabled={productVisualEditingEnabled}
      visualEditing={productDescriptionVisualEditing}
    />
  ) : undefined;

  // Only resolved when actually needed — a working store pays nothing for this.
  const purchaseFallbackNode =
    !canPurchase && excludeProductId ? (
      <LazyContactSellerSection
        productId={excludeProductId}
        botProtectionProvider={botProtection.provider}
        botProtectionSiteKey={botProtection.siteKey}
        scriptNonce={scriptNonce}
      />
    ) : undefined;

  return (
    <div {...visualEditAttributes}>
      <PaymentReadinessBoundary>
      <LazyProductDetailsLayout
        visualEditingEnabled={productVisualEditingEnabled}
        descriptionNode={descriptionNode}
        reviewsNode={excludeProductId ? <LazyProductReviewsSection productId={excludeProductId} /> : undefined}
        canPurchase={canPurchase}
        purchaseFallbackNode={purchaseFallbackNode}
        addonBaseProducts={addonBaseProducts}
      />
      </PaymentReadinessBoundary>
    </div>
  );
}
