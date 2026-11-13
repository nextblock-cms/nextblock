import { NextResponse } from "next/server";

import { FULL_BACKUP_SANDBOX_MESSAGE, exportFullBackupArchive } from "../../../../../lib/full-backup/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const archive = await exportFullBackupArchive();
    const body = archive.content.buffer.slice(
      archive.content.byteOffset,
      archive.content.byteOffset + archive.content.byteLength
    ) as ArrayBuffer;

    return new NextResponse(body, {
      headers: {
        "Content-Type": archive.mimeType,
        "Content-Disposition": `attachment; filename="${archive.fileName}"`,
        "Content-Length": String(archive.content.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to export full ZIP backup.",
      },
      // The sandbox refuses every full backup (lib/full-backup/server.ts).
      { status: error instanceof Error && error.message === FULL_BACKUP_SANDBOX_MESSAGE ? 403 : 500 }
    );
  }
}
