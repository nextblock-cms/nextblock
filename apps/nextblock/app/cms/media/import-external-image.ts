// app/cms/media/import-external-image.ts
"use server";

import "server-only";

import { requireCmsStaff } from "../../../lib/auth/cms-actor";
import {
  importExternalImageAsActor,
  type ImportExternalImageInput,
  type ImportExternalImageResult,
} from "../../../lib/media/external-image-import";

/**
 * Download an external image (e.g. an AI-inserted stock photo) into the media library as
 * the signed-in ADMIN or WRITER.
 *
 * A server action is a public POST endpoint, so it takes no actor: the importer is always
 * the cookie session's staff member (`requireCmsStaff()`, second factor included). Until
 * 2026-10-21 it accepted `actorUserId` for the MCP server, and the session cross-check ran
 * only when a session existed, so a cookieless POST naming an admin's id (public via
 * `posts.author_id`) imported as that admin. `/api/mcp` now calls
 * `importExternalImageAsActor` (lib/media/external-image-import.ts) after authenticating.
 */
export async function importExternalImageToMedia(input: ImportExternalImageInput): Promise<ImportExternalImageResult> {
  let userId: string;

  try {
    ({ userId } = await requireCmsStaff());
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message === "Unauthorized"
          ? "You must be signed in to import an image."
          : "You do not have permission to import media.",
    };
  }

  // Only the known fields: anything else in the POST body (an `actorUserId`) is ignored.
  return importExternalImageAsActor({
    actorUserId: userId,
    altText: input?.altText,
    fileName: input?.fileName,
    url: input?.url,
  });
}
