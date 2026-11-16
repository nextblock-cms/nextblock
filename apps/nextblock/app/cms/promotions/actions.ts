"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { requireCmsAdmin } from "../../../lib/auth/cms-actor";
import {
  applyPromotionsImport,
  dryRunPromotionsImport,
  exportPromotionsCsv,
  getPromotionsTemplateCsv,
  type PromotionImportSummary,
  type PromotionKind,
  type PromotionTransferResult,
} from "../../../lib/promotions/server";

/*
 * lib/promotions/server.ts reads and writes products with the service role, and an applied sale
 * import pushes each Freemius product's sale coupon (SALE<SKU>, up to 100% off) through the
 * developer key pair. Every action therefore starts with requireCmsAdmin(): an ADMIN whose session
 * has passed the enrolled second factor. Until 2026-11-13 a local assertAdmin() checked the role
 * only, which an ADMIN password alone satisfies (a server action never meets the CMS layout's 2FA
 * redirect). tools/scripts/server-action-actors.test.ts fails on an action that reaches a coupon
 * push without requireEcomAdmin() / requireCmsAdmin() first.
 */

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function kindLabel(kind: PromotionKind) {
  return kind === "sale" ? "promotions" : "price-changes";
}

export async function getPromotionsTemplateAction(
  kind: PromotionKind
): Promise<PromotionTransferResult> {
  try {
    await requireCmsAdmin();
    return {
      success: true,
      fileName: `nextblock-${kindLabel(kind)}-import-template.csv`,
      mimeType: "text/csv",
      content: getPromotionsTemplateCsv(kind),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to build template.",
    };
  }
}

export async function exportPromotionsAction(
  kind: PromotionKind
): Promise<PromotionTransferResult> {
  try {
    await requireCmsAdmin();
    return {
      success: true,
      fileName: `nextblock-${kindLabel(kind)}-${dateStamp()}.csv`,
      mimeType: "text/csv",
      content: await exportPromotionsCsv(kind),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to export CSV.",
    };
  }
}

export async function dryRunPromotionsImportAction(params: {
  kind: PromotionKind;
  content: string;
}): Promise<{ success: boolean; summary?: PromotionImportSummary; error?: string }> {
  try {
    await requireCmsAdmin();
    const summary = await dryRunPromotionsImport(params.kind, params.content);
    return { success: true, summary };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to validate import.",
    };
  }
}

export async function applyPromotionsImportAction(params: {
  kind: PromotionKind;
  content: string;
}): Promise<{ success: boolean; summary?: PromotionImportSummary; error?: string }> {
  try {
    await requireCmsAdmin();
    const summary = await applyPromotionsImport(params.kind, params.content);
    revalidatePath("/cms/promotions");
    revalidatePath("/cms/products");
    return { success: true, summary };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to apply import.",
    };
  }
}
