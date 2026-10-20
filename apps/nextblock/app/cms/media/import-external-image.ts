// app/cms/media/import-external-image.ts
"use server";

import "server-only";

import sharp from "sharp";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { createClient, getServiceRoleSupabaseClient } from "@nextblock-cms/db/server";
import { recordMediaUpload } from "@nextblock-cms/db";
import { getS3Client } from "@nextblock-cms/utils/server";

import { getStorageBackend, getStorageBucket } from "../../../lib/storage/provider";
import { supabaseUploadObject } from "../../../lib/storage/supabase-storage";
import { resolveMediaUrl } from "../../../lib/media/resolveMediaUrl";

const MAX_IMPORT_BYTES = 15 * 1024 * 1024; // 15MB
const IMPORT_TIMEOUT_MS = 15000;

type ImportExternalImageResult =
  | {
      success: true;
      media: {
        id: string;
        object_key: string;
        width: number;
        height: number;
        url: string;
        blur_data_url: string | null;
        alt_text: string;
      };
    }
  | { error: string };

/**
 * Reject local/loopback/private/link-local hosts and cloud metadata endpoints so an
 * admin-supplied URL cannot be used to probe internal infrastructure (SSRF).
 */
/**
 * Unwrap an IPv4-mapped IPv6 address to dotted-quad.
 *
 * `http://[::ffff:127.0.0.1]/` reaches loopback, but the URL parser normalises it to
 * `::ffff:7f00:1`, which matches none of the IPv4 checks below — a working bypass of
 * the whole blocklist. Mirrors `unwrapMappedIpv4` in
 * libs/cortex/src/lib/ai-global-agent-tools.ts; the two blocklists are duplicated
 * because a published lib cannot import from the app, so fix both together.
 */
function unwrapMappedIpv4(host: string): string | null {
  const mapped = host.match(/^::ffff:(.+)$/i);

  if (!mapped) return null;

  const rest = mapped[1] as string;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;

  const hextets = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);

  if (!hextets) return null;

  const high = Number.parseInt(hextets[1] as string, 16);
  const low = Number.parseInt(hextets[2] as string, 16);

  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

function isBlockedImportHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }

  if (
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }

  const mappedIpv4 = unwrapMappedIpv4(host);

  if (mappedIpv4) {
    return isBlockedImportHost(mappedIpv4);
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);

    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)) {
      return true;
    }
  }

  return false;
}

/**
 * DNS-rebinding guard: isBlockedImportHost only inspects the hostname string, so a public name
 * that resolves to an internal address passes it. Resolve the name and block if any address is
 * internal. (Residual TOCTOU before connect; IP-pinning dispatcher is the complete follow-up.)
 */
async function resolvedImportHostIsBlocked(hostname: string): Promise<boolean> {
  const host = (hostname || "").trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return isBlockedImportHost(host);
  }
  try {
    const dns = await import("node:dns");
    const records = await dns.promises.lookup(host, { all: true });
    if (!records || records.length === 0) return true;
    return records.some((r) => isBlockedImportHost(r.address));
  } catch {
    return true;
  }
}

function extensionForImage(contentType: string, sharpFormat?: string): string {
  const format = (sharpFormat || "").toLowerCase();
  const byFormat: Record<string, string> = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", avif: "avif", gif: "gif", svg: "svg" };
  if (byFormat[format]) return byFormat[format];

  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("avif")) return "avif";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("svg")) return "svg";
  return "jpg";
}

function slugifyFileBase(value: string): string {
  const base = (value || "image")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "image";
}

/**
 * Establish the ADMIN/WRITER this import is attributed to.
 *
 * Two paths: a cookie session (the dashboard) or an explicitly supplied actor (the
 * MCP server, which has already authenticated the caller by bearer token). Both
 * end at the same role check, so the second is a different way to *identify* the
 * uploader, not a way to skip authorization.
 */
async function resolveImportActorId(actorUserId?: string): Promise<{ id: string } | { error: string }> {
  if (actorUserId) {
    // `actorUserId` is a pre-authenticated principal supplied only by server paths that have no
    // cookie session (the MCP route, after bearer verification). It must never let a caller that
    // DOES have a session act as a different staff member: if a session is present, it has to be
    // the same user. The MCP path carries no session, so this leaves it untouched.
    try {
      const sessionClient = createClient();
      const {
        data: { user: sessionUser },
      } = await sessionClient.auth.getUser();
      if (sessionUser && sessionUser.id !== actorUserId) {
        return { error: "You do not have permission to import media." };
      }
    } catch {
      // No request context (background/MCP) — nothing to cross-check.
    }

    const { data: profile } = await getServiceRoleSupabaseClient()
      .from("profiles")
      .select("role")
      .eq("id", actorUserId)
      .single();

    if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
      return { error: "You do not have permission to import media." };
    }

    return { id: actorUserId };
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in to import an image." };
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
    return { error: "You do not have permission to import media." };
  }

  return { id: user.id };
}

/**
 * Download an external image (e.g. an AI-inserted stock photo) and persist it into the
 * NextBlock media library (R2 or Supabase Storage) so it becomes a permanent, optimized
 * asset the page no longer hotlinks. ADMIN/WRITER only.
 */
export async function importExternalImageToMedia(input: {
  url: string;
  altText?: string;
  fileName?: string;
  /**
   * Uploader for callers with no cookie session — the MCP server authenticates by
   * bearer token, so `auth.getUser()` finds nobody and every import would fail with
   * "You must be signed in". The role check below still runs against this id, so it
   * confers no authority the caller did not already establish.
   */
  actorUserId?: string;
}): Promise<ImportExternalImageResult> {
  const uploaderId = await resolveImportActorId(input.actorUserId);

  if ("error" in uploaderId) {
    return { error: uploaderId.error };
  }

  const userId = uploaderId.id;

  let target: URL;

  try {
    target = new URL(input.url);
  } catch {
    return { error: "That is not a valid URL." };
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { error: "Only http/https image URLs can be imported." };
  }

  if (isBlockedImportHost(target.hostname) || (await resolvedImportHostIsBlocked(target.hostname))) {
    return { error: "Refusing to fetch a local, private, or internal address." };
  }

  // Unsplash API Guidelines require photos to stay hotlinked to their original
  // image URL — re-hosting them into our own storage is not permitted. Pexels'
  // license does allow downloading/hosting, so only Unsplash is blocked here.
  const importHost = target.hostname.toLowerCase();
  if (importHost === "unsplash.com" || importHost.endsWith(".unsplash.com")) {
    return {
      error:
        "Unsplash requires photos to stay hotlinked, so they can't be saved into your media library. Keep it as an external image (it still displays fine), or use a Pexels photo or your own upload if you need a stored asset.",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  let buffer: Buffer;
  let contentType: string;

  try {
    const response = await fetch(target.toString(), {
      headers: { accept: "image/*" },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      return { error: `The image URL responded with HTTP ${response.status}.` };
    }

    const finalImportHost = new URL(response.url || target.toString()).hostname;
    if (isBlockedImportHost(finalImportHost) || (await resolvedImportHostIsBlocked(finalImportHost))) {
      return { error: "The image URL redirected to a blocked internal address." };
    }

    contentType = response.headers.get("content-type") || "";

    if (!/^image\//i.test(contentType)) {
      return { error: `The URL is not an image (content-type: ${contentType || "unknown"}).` };
    }

    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength > MAX_IMPORT_BYTES) {
      return { error: "The image is too large to import (max 15MB)." };
    }

    buffer = Buffer.from(arrayBuffer);
  } catch (error) {
    const aborted = error instanceof Error && /abort/i.test(error.message);
    return {
      error: aborted
        ? "Fetching the image timed out."
        : `Failed to fetch the image: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }

  let width = 0;
  let height = 0;
  let blurDataUrl: string | null = null;
  let sharpFormat: string | undefined;
  const isSvg = /svg/i.test(contentType);

  if (!isSvg) {
    try {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width || 0;
      height = metadata.height || 0;
      sharpFormat = metadata.format;

      const blurBuffer = await sharp(buffer).resize(16, 16, { fit: "inside" }).webp({ quality: 40 }).toBuffer();
      blurDataUrl = `data:image/webp;base64,${blurBuffer.toString("base64")}`;
    } catch {
      // Non-fatal: proceed without dimensions/blur (e.g. an unusual format sharp can't parse).
    }
  }

  const extension = extensionForImage(contentType, sharpFormat);
  const baseName = slugifyFileBase(
    input.fileName || input.altText || target.hostname.replace(/^www\./, "").split(".")[0] || "image"
  );
  const random = Math.random().toString(36).slice(2, 8);
  const objectKey = `uploads/${baseName}-${Date.now()}-${random}.${extension}`;
  const resolvedContentType = contentType || `image/${extension}`;

  try {
    if (getStorageBackend() === "supabase") {
      await supabaseUploadObject(objectKey, buffer, resolvedContentType);
    } else {
      const s3Client = await getS3Client();
      const bucket = getStorageBucket();

      if (!s3Client || !bucket) {
        return { error: "File storage is not configured on this server." };
      }

      await s3Client.send(
        new PutObjectCommand({
          Body: buffer,
          Bucket: bucket,
          ContentType: resolvedContentType,
          Key: objectKey,
          Metadata: { "uploader-user-id": userId },
        })
      );
    }
  } catch (error) {
    return {
      error: `Failed to upload the image to storage: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const publicUrl = resolveMediaUrl(objectKey) ?? "";
  const fileName = `${baseName}.${extension}`;
  const altText = (input.altText || baseName.replace(/-/g, " ")).trim();
  const originalVariant = {
    fileType: resolvedContentType,
    height,
    objectKey,
    sizeBytes: buffer.byteLength,
    url: publicUrl,
    variantLabel: "original",
    width,
  };

  const record = await recordMediaUpload(
    {
      // Carried through so the media row is attributed to the same actor the role
      // check above passed — without it the recorder falls back to the cookie
      // session and fails for MCP callers after the upload has already happened.
      actorUserId: input.actorUserId,
      blurDataUrl: blurDataUrl || undefined,
      description: altText || undefined,
      fileName,
      originalImageDetails: originalVariant,
      r2OriginalKey: objectKey,
      r2Variants: [originalVariant],
    },
    true
  );

  if (!record || "error" in record) {
    return { error: record && "error" in record ? record.error : "Failed to record the imported image." };
  }

  const media = record.data;

  return {
    media: {
      alt_text: (media.description || altText || "").trim(),
      blur_data_url: media.blur_data_url ?? blurDataUrl,
      height: media.height || height,
      id: media.id,
      object_key: media.object_key,
      url: publicUrl,
      width: media.width || width,
    },
    success: true,
  };
}
