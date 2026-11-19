// app/cms/media/[id]/edit/page.tsx
import React from "react";
import { createClient } from "@nextblock-cms/db/server";
import MediaEditForm from "../../components/MediaEditForm"; // Adjusted path
import { updateMediaItem } from "../../actions"; // Server action for updating
import type { Database } from "@nextblock-cms/db";
import { notFound, redirect } from "next/navigation";

type Media = Database['public']['Tables']['media']['Row'];
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@nextblock-cms/ui";
import MediaUsageList from "../../components/MediaUsageList";
import { getCmsActor, isCmsStaffRole } from "../../../../../lib/auth/cms-actor";
import { findMediaUsage } from "../../../../../lib/media/media-usage";
import { withoutAdminOnlyLabels, type MediaUsage } from "../../../../../lib/media/media-usage-format";

/**
 * Where this file is used (public.media_usage, 02045), or why that could not be said. The lookup
 * runs with the service role, so the actor is checked here (a page renders beside the CMS layout,
 * not behind its second-factor redirect). Anyone but an ADMIN sees it through withoutAdminOnlyLabels:
 * a place whose record their own session cannot read (a partner storefront, a redirect, an ADMIN-tier
 * setting) keeps its kind but loses its label, record id and parent.
 */
async function readMediaUsage(mediaItem: Media): Promise<{ usage: MediaUsage } | { error: string }> {
  const actor = await getCmsActor();
  if (!actor || !isCmsStaffRole(actor.role)) {
    return { error: "Complete two-factor verification to see where this file is used." };
  }
  try {
    const usage = (await findMediaUsage([mediaItem])).get(mediaItem.id.toLowerCase());
    if (!usage) {
      return { error: "Where this file is used could not be checked." };
    }
    return { usage: actor.role === "ADMIN" ? usage : withoutAdminOnlyLabels(usage) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Where this file is used could not be checked." };
  }
}

async function getMediaData(id: string): Promise<Media | null> {
  const supabase = createClient();
  // Validate if ID is a UUID, otherwise Supabase might error
  // For simplicity, we assume it's a valid UUID format if it reaches here.
  const { data, error } = await supabase
    .from("media")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("Error fetching media for edit:", error);
    return null;
  }
  return data;
}

export default async function EditMediaPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const mediaId = params.id;
  if (!mediaId) { // Basic check, UUID validation could be added
    return notFound();
  }

  // Verify admin/writer role before even fetching (optional, RLS on media table should also protect)
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/sign-in?redirect=/cms/media");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
      return <div className="p-6">Access Denied. You do not have permission to edit media.</div>;
  }

  const mediaItem = await getMediaData(mediaId);

  if (!mediaItem) {
    return notFound();
  }

  const usageResult = await readMediaUsage(mediaItem);

  // Bind the mediaId to the updateMediaItem server action
  // Wrap to accept FormData as expected by MediaEditForm
  const updateMediaFormAction = async (formData: FormData) => {
    "use server";
    const description = formData.get("description") as string | undefined;
    const file_name = formData.get("file_name") as string | undefined;
    // Return data instead of redirect to avoid NEXT_REDIRECT noise during dev
    return await updateMediaItem(mediaItem.id, { description, file_name }, true);
  };

  return (
    <div className="w-full">
        <div className="mb-6 flex items-center gap-3">
            <Button variant="outline" size="icon" asChild>
                <Link href="/cms/media">
                    <ArrowLeft className="h-4 w-4" />
                </Link>
            </Button>
            <h1 className="text-2xl font-semibold">Edit Media: {mediaItem.file_name}</h1>
        </div>
      <MediaEditForm
        mediaItem={mediaItem}
        formAction={updateMediaFormAction}
      />
      <section className="mt-8 rounded-lg border p-4" aria-labelledby="media-usage-heading">
        <h2 id="media-usage-heading" className="mb-3 text-lg font-semibold">Where this file is used</h2>
        {"usage" in usageResult ? (
          <MediaUsageList usage={usageResult.usage} maxItems={25} />
        ) : (
          <p className="text-sm text-destructive">{usageResult.error}</p>
        )}
      </section>
    </div>
  );
}
