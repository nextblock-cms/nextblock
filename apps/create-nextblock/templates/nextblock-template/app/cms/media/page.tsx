// app/cms/media/page.tsx
import React from 'react';
import { createClient } from "@nextblock-cms/db/server";
import type { Database } from "@nextblock-cms/db";
// DropdownMenu related imports are now handled within MediaGridClient or its sub-components if needed individually.

type Media = Database['public']['Tables']['media']['Row'];
// If page.tsx itself doesn't directly use DropdownMenu, these can be removed from here.
// For now, assuming MediaGridClient handles its own dropdowns.
import MediaUploadForm from "./components/MediaUploadForm";
// MediaImage and DeleteMediaButtonClient are used by MediaGridClient, not directly here anymore.
import MediaGridClient from "./components/MediaGridClient"; // Import the new client component
import FolderNavigator from "./components/FolderNavigator";
import Link from "next/link";
import { getPublicMediaBaseUrl } from "../../../lib/media/resolveMediaUrl";
import { getCmsActor, isCmsStaffRole } from "../../../lib/auth/cms-actor";
import { findMediaUsage } from "../../../lib/media/media-usage";
import { countMediaHistoryUses, isMediaUnused } from "../../../lib/media/media-usage-format";

type MediaSearchParams = { folder?: string; folderPrefix?: string; q?: string; usage?: string };

/** /cms/media with the same folder and search, all files or only the unused ones. */
function usageViewHref(params: MediaSearchParams, unused: boolean): string {
  const next = new URLSearchParams();
  if (params.folder) next.set("folder", params.folder);
  if (params.folderPrefix) next.set("folderPrefix", params.folderPrefix);
  if (params.q) next.set("q", params.q);
  if (unused) next.set("usage", "unused");
  const query = next.toString();
  return query ? `/cms/media?${query}` : "/cms/media";
}

/**
 * The "Unused" view: the listed items nothing uses (public.media_usage, 02045). The lookup runs with
 * the service role, so the page checks the actor itself (a page renders beside the CMS layout, not
 * behind its second-factor redirect). A failed lookup lists nothing and says why: an item is never
 * shown as unused on a lookup that did not answer.
 */
async function resolveUnusedView(mediaItems: Media[]): Promise<{
  listed: Media[];
  unusedView: { historyOnlyIds: string[] } | null;
  usageError: string | null;
}> {
  const actor = await getCmsActor();
  if (!actor || !isCmsStaffRole(actor.role)) {
    return { listed: [], unusedView: null, usageError: "Complete two-factor verification to list unused files." };
  }

  try {
    const usage = await findMediaUsage(mediaItems);
    const listed: Media[] = [];
    const historyOnlyIds: string[] = [];
    for (const item of mediaItems) {
      const entry = usage.get(item.id.toLowerCase());
      if (entry && isMediaUnused(entry)) {
        listed.push(item);
        if (countMediaHistoryUses(entry) > 0) historyOnlyIds.push(item.id);
      }
    }
    return { listed, unusedView: { historyOnlyIds }, usageError: null };
  } catch (error) {
    return {
      listed: [],
      unusedView: null,
      usageError: error instanceof Error ? error.message : "Where these files are used could not be checked.",
    };
  }
}

async function getMediaItems(folder?: string, folderPrefix?: string, search?: string): Promise<Media[]> {
  const supabase = createClient();
  let query = supabase
    .from("media")
    .select("*")
    .order("created_at", { ascending: false });

  if (folder && folder.trim()) {
    query = query.eq('folder', folder);
  } else if (folderPrefix && folderPrefix.trim()) {
    query = query.ilike('folder', `${folderPrefix}%`);
  }

  if (search && search.trim()) {
    const term = search.trim();
    query = query.or(`file_name.ilike.%${term}%,description.ilike.%${term}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Error fetching media items:", error);
    return [];
  }
  return data || [];
}

async function getDistinctFolders(search?: string): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("media")
    .select("folder")
    .order("folder", { ascending: true });
  if (error) {
    console.error("Error fetching folders:", error);
    return [];
  }
  let folders = (data || [])
    .map((r: any) => r.folder)
    .filter((f: any) => typeof f === 'string' && f.length > 0);
  if (search && search.trim()) {
    const t = search.trim().toLowerCase();
    folders = folders.filter((f: string) => f.toLowerCase().includes(t));
  }
  // Ensure trailing slash for consistency
  return Array.from(new Set(folders.map((f: string) => (f.endsWith('/') ? f : f + '/'))));
}

async function getFolderCounts(): Promise<Record<string, number>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("media")
    .select("folder");
  if (error) {
    console.error("Error fetching folder counts:", error);
    return {};
  }
  const counts: Record<string, number> = {};
  (data || []).forEach((row: any) => {
    const f: string | null = row.folder;
    if (!f || typeof f !== 'string' || f.length === 0) return;
    const norm = f.endsWith('/') ? f : `${f}/`;
    // accumulate counts for each prefix in the path
    const parts = norm.replace(/^\/+/, '').split('/').filter(Boolean);
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix += (i === 0 ? '' : '/') + parts[i];
      const key = `${prefix}/`;
      counts[key] = (counts[key] || 0) + 1;
    }
  });
  return counts;
}

export default async function CmsMediaLibraryPage(props: { searchParams?: Promise<MediaSearchParams> }) {
  // Read on the server, where process.env is current, and handed to the grid's resolveMediaUrl().
  const mediaBaseUrl = getPublicMediaBaseUrl();
  const searchParams = (await props.searchParams) || {};
  const selectedFolder = searchParams.folder;
  const selectedFolderPrefix = searchParams.folderPrefix;
  const searchQuery = searchParams.q;
  const showUnused = searchParams.usage === "unused";
  const [mediaItems, folders, folderCounts] = await Promise.all([
    getMediaItems(selectedFolder, selectedFolderPrefix, searchQuery),
    getDistinctFolders(searchQuery),
    getFolderCounts(),
  ]);
  const { listed, unusedView, usageError } = showUnused
    ? await resolveUnusedView(mediaItems)
    : { listed: mediaItems, unusedView: null, usageError: null };

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 font-medium ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`;

  return (
    <div className="w-full max-w-screen-2xl mx-auto px-4 overflow-x-hidden space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h1 className="text-2xl font-semibold">Media Library</h1>
        <nav aria-label="Show files" className="flex items-center gap-1 rounded-lg border p-1 text-sm">
          <Link href={usageViewHref(searchParams, false)} aria-current={showUnused ? undefined : "page"} className={tabClass(!showUnused)}>
            All files
          </Link>
          <Link href={usageViewHref(searchParams, true)} aria-current={showUnused ? "page" : undefined} className={tabClass(showUnused)}>
            Unused files
          </Link>
        </nav>
      </div>

      <MediaUploadForm />

      {/* Compact folder navigator with top tabs and subfolder pills */}
      <div className="mt-2">
        <FolderNavigator basePath="/cms/media" folders={folders} selectedFolder={selectedFolder || ''} selectedPrefix={selectedFolderPrefix || ''} counts={folderCounts} searchTerm={searchQuery || ''} />
      </div>

      {/* The media grid and empty state are now handled by MediaGridClient. The key remounts it when
          the view changes, so a selection made in one view never carries into the other. */}
      <MediaGridClient
        key={showUnused ? "unused" : "all"}
        initialMediaItems={listed}
        r2BaseUrl={mediaBaseUrl}
        unusedView={unusedView}
        usageError={usageError}
      />
    </div>
  );
}
