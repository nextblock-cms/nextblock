import { NextResponse } from "next/server";

import {
  FULL_BACKUP_SANDBOX_MESSAGE,
  requireFullBackupAdmin,
  restoreFullBackupArchive,
  reviewFullBackupArchiveForAdmin,
} from "../../../../../lib/full-backup/server";
import type { FullBackupMediaUrlMode } from "../../../../../lib/full-backup/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeMediaUrlMode(value: FormDataEntryValue | null): FullBackupMediaUrlMode {
  return value === "keep_exact_urls" ? "keep_exact_urls" : "rewrite_to_destination";
}

async function readZipFile(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("Choose a full backup ZIP file first.");
  }

  return new Uint8Array(await file.arrayBuffer());
}

export async function POST(request: Request) {
  try {
    await requireFullBackupAdmin();
    const formData = await request.formData();
    const action = String(formData.get("action") || "review");
    const archive = await readZipFile(formData);

    if (action === "review") {
      return NextResponse.json(await reviewFullBackupArchiveForAdmin(archive));
    }

    if (action !== "restore") {
      return NextResponse.json(
        { success: false, error: "Unknown full backup restore action.", warnings: [] },
        { status: 400 }
      );
    }

    const result = await restoreFullBackupArchive({
      archive,
      confirmation: String(formData.get("confirmation") || ""),
      mediaUrlMode: normalizeMediaUrlMode(formData.get("mediaUrlMode")),
      destinationBaseUrl: String(formData.get("destinationBaseUrl") || ""),
      deleteExtraneousR2Objects: formData.get("deleteExtraneousR2Objects") === "true",
    });

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to restore full ZIP backup.",
        warnings: [],
      },
      // The sandbox refuses every review and restore (lib/full-backup/server.ts).
      { status: error instanceof Error && error.message === FULL_BACKUP_SANDBOX_MESSAGE ? 403 : 500 }
    );
  }
}
