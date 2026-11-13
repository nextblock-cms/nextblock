// app/cms/media/page.tsx
import React from 'react';
import { createClient } from "@nextblock-cms/db/server";
// import Link from "next/link"; // Unused, MediaGridClient handles item links
import type { Database } from "@nextblock-cms/db";
// DropdownMenu related imports are now handled within MediaGridClient or its sub-components if needed individually.

type Media = Database['public']['Tables']['media']['Row'];
// If page.tsx itself doesn't directly use DropdownMenu, these can be removed from here.
// For now, assuming MediaGridClient handles its own dropdowns.
import MediaUploadForm from "./components/MediaUploadForm";
// MediaImage and DeleteMediaButtonClient are used by MediaGridClient, not directly here anymore.
import MediaGridClient from "./components/MediaGridClient"; // Import the new client component
import FolderNavigator from "./components/FolderNavigator";
import { getPublicMediaBaseUrl } from "../../../lib/media/resolveMediaUrl";

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

export default async function CmsMediaLibraryPage(props: { searchParams?: Promise<{ folder?: string; folderPrefix?: string; q?: string }> }) {
  // Read on the server, where process.env is current, and handed to the grid's resolveMediaUrl().
  const mediaBaseUrl = getPublicMediaBaseUrl();
  const searchParams = (await props.searchParams) || {};
  const selectedFolder = searchParams.folder;
  const selectedFolderPrefix = searchParams.folderPrefix;
  const searchQuery = searchParams.q;
  const [mediaItems, folders, folderCounts] = await Promise.all([
    getMediaItems(selectedFolder, selectedFolderPrefix, searchQuery),
    getDistinctFolders(searchQuery),
    getFolderCounts(),
  ]);

  return (
    <div className="w-full max-w-screen-2xl mx-auto px-4 overflow-x-hidden space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">Media Library</h1>
      </div>

      <MediaUploadForm />

      {/* Compact folder navigator with top tabs and subfolder pills */}
      <div className="mt-2">
        <FolderNavigator basePath="/cms/media" folders={folders} selectedFolder={selectedFolder || ''} selectedPrefix={selectedFolderPrefix || ''} counts={folderCounts} searchTerm={searchQuery || ''} />
      </div>

      {/* The media grid and empty state are now handled by MediaGridClient */}
      <MediaGridClient initialMediaItems={mediaItems} r2BaseUrl={mediaBaseUrl} />
    </div>
  );
}
