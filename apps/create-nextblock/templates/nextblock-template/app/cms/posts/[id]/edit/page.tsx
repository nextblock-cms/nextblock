// app/cms/posts/[id]/edit/page.tsx
import React from "react";
import { Separator } from "@nextblock-cms/ui";
import { createClient } from "@nextblock-cms/db/server";
import PostForm from "../../components/PostForm";
import { updatePost } from "../../actions";
import type { Database } from "@nextblock-cms/db";
import { notFound, redirect } from "next/navigation";
import BlockEditorArea from "../../../blocks/components/BlockEditorArea";
import Link from "next/link";
import { Button } from "@nextblock-cms/ui";
import { ArrowLeft, Eye, FilePenLine } from "lucide-react";
import ContentLanguageSwitcher from "../../../components/ContentLanguageSwitcher";
import { getActiveLanguagesServerSide } from "@nextblock-cms/db/server";
import { normalizeContentDraftRow } from "../../../../../lib/visual-editing/draft-content";
import CopyContentFromLanguage from "../../../components/CopyContentFromLanguage";
import { UploadFolderProvider } from '../../../media/UploadFolderContext';
import RevisionHistoryButton from "../../../revisions/RevisionHistoryButton";
import { resolveMediaUrl } from "../../../../../lib/media/resolveMediaUrl";
import { CortexAiPageContextRegistrar } from "../../../components/CortexAiPageContext";
import DraftStatusActions from "../../../components/DraftStatusActions";
import VisibilityControl from "../../../components/VisibilityControl";
import { buildViewUrl } from "../../../../../lib/publishing/viewUrl";
import { PageSeoAuditSection } from "../../../../../components/seo/PageSeoAuditSection";
import { PageSeoProvider } from "../../../../../lib/seo/page-audit-context";

type PostType = Database['public']['Tables']['posts']['Row'];
type BlockType = Database['public']['Tables']['blocks']['Row'];
type Language = Database['public']['Tables']['languages']['Row'];

interface PostWithBlocks extends PostType {
  blocks: BlockType[];
  language_code?: string; // From joined languages table
  translation_group_id: string;
}

async function getPostDataWithBlocks(id: number): Promise<{
  post: PostWithBlocks;
  hasDraft: boolean;
  liveStatus: string;
  liveSlug: string;
  livePublishedAt: string | null;
} | null> {
  const supabase = createClient();
  const { data: postData, error: postError } = await supabase
    .from("posts")
    .select(`
      *,
      languages!inner (code),
      blocks (*)
    `)
    .eq("id", id)
    .order('order', { foreignTable: 'blocks', ascending: true })
    .single();

  if (postError) {
    console.error("Error fetching post with blocks for edit:", postError);
    return null;
  }

  const langCode = Array.isArray(postData.languages)
    ? postData.languages[0]?.code
    : (postData.languages as unknown as Language)?.code;

  let postWithBlocks: PostWithBlocks = {
    ...postData,
    blocks: postData.blocks || [],
    language_code: langCode,
    translation_group_id: postData.translation_group_id ?? "",
  } as PostWithBlocks;

  const { data: draftData } = await supabase
    .from("content_drafts")
    .select("*")
    .eq("parent_type", "post")
    .eq("parent_id", id)
    .maybeSingle();

  const hasDraft = draftData !== null;
  if (draftData) {
    const draft = normalizeContentDraftRow(draftData);
    postWithBlocks = {
      ...postWithBlocks,
      title: (draft.meta.title as string) ?? postWithBlocks.title,
      slug: (draft.meta.slug as string) ?? postWithBlocks.slug,
      language_id: (draft.meta.language_id as number) ?? postWithBlocks.language_id,
      // `status`/`published_at` are intentionally NOT overlaid — see the matching
      // note in cms/pages/[id]/edit/page.tsx. Visibility comes from the row.
      meta_title: (draft.meta.meta_title as string) ?? postWithBlocks.meta_title,
      meta_description: (draft.meta.meta_description as string) ?? postWithBlocks.meta_description,
      label: (draft.meta.label as string) ?? postWithBlocks.label,
      excerpt: (draft.meta.excerpt as string) ?? postWithBlocks.excerpt,
      subtitle: (draft.meta.subtitle as string) ?? postWithBlocks.subtitle,
      feature_image_id: (draft.meta.feature_image_id as any) ?? postWithBlocks.feature_image_id,
      blocks: draft.blocks as any[],
    };
  }

  return {
    post: postWithBlocks,
    hasDraft,
    // The LIVE row's visibility/slug — the top-bar control and the "View Live"
    // link must reflect what is actually published, never the draft.
    liveStatus: postData.status as string,
    liveSlug: postData.slug as string,
    livePublishedAt: (postData.published_at as string | null) ?? null,
  };
}

export default async function EditPostPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const postId = parseInt(params.id, 10);
  if (isNaN(postId)) {
    return notFound();
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect(`/sign-in?redirect=/cms/posts/${postId}/edit`);

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !['ADMIN', 'WRITER'].includes(profile.role)) {
      return <div className="p-6 text-center text-red-600">Access Denied. You do not have permission to edit posts.</div>;
  }

  // Fetch post data and all site languages concurrently
  const postDataResult = await getPostDataWithBlocks(postId);
  const allSiteLanguages = await getActiveLanguagesServerSide();

  if (!postDataResult) {
    return notFound();
  }

  const { post: postWithBlocks, hasDraft, liveStatus, liveSlug, livePublishedAt } = postDataResult;
  const language = allSiteLanguages.find((lang) => lang.id === postWithBlocks.language_id);
  const languageCode = language?.code ?? postWithBlocks.language_code ?? null;

  let initialFeatureImageUrl: string | null = null;
  let initialFeatureImageIdProp: string | null = null;

  const featureImageIdFromDb = postWithBlocks.feature_image_id as unknown as (string | number | null);

  if (featureImageIdFromDb) {
    const { data: mediaItem, error: mediaError } = await supabase
      .from("media")
      .select("id, object_key, file_path")
      .eq("id", String(featureImageIdFromDb)) // Query using the ID as string
      .single();

    if (mediaError) {
      console.error(`Error fetching media item for feature_image_id '${featureImageIdFromDb}':`, mediaError.message);
    } else if (mediaItem) {
      initialFeatureImageIdProp = mediaItem.id; // string UUID from media table
      initialFeatureImageUrl = resolveMediaUrl(mediaItem.file_path || mediaItem.object_key);
    }
  }

  const updatePostWithId = updatePost.bind(null, postId);
  const publicPostUrl = `/article/${postWithBlocks.slug}`;
  const liveViewUrl = `/article/${liveSlug}`;
  const previewUrl = buildViewUrl({ path: publicPostUrl, languageCode, draft: true });
  const liveUrl = buildViewUrl({ path: liveViewUrl, languageCode });
  const isLive = liveStatus === "published";
  
  return (
    <UploadFolderProvider defaultFolder={`posts/${postWithBlocks.slug}/`}>
      <CortexAiPageContextRegistrar
        context={{
          contentType: "post",
          entityId: postWithBlocks.id,
          languageId: postWithBlocks.language_id,
          slug: postWithBlocks.slug,
          title: postWithBlocks.title,
          translationGroupId: postWithBlocks.translation_group_id,
        }}
      />
      {/*
        A server component may render a client provider around client children,
        which is the whole reason this file does not need converting: everything
        inside the provider that touches the context — the form, the block editor
        and the audit section — is already a client component, and this file
        stays an RSC that can keep awaiting Supabase above them.

        The provider must enclose both `PostForm` and `BlockEditorArea` because
        the audit is assembled from halves they each own: the form publishes the
        meta title and description, the block editor publishes the live blocks.
        Seeding it from the row (draft overlay included, since `postWithBlocks`
        already carries it) means the panel grades the real article on first
        paint instead of an empty document.
      */}
      <PageSeoProvider
        documentTitle={postWithBlocks.title}
        documentType="post"
        initialBlocks={postWithBlocks.blocks}
        initialMetaDescription={postWithBlocks.meta_description}
        initialMetaTitle={postWithBlocks.meta_title}
      >
      <div className="space-y-8 w-full mx-auto px-6">
        <div className="flex justify-between items-center flex-wrap gap-4 w-full">
          <div className="flex items-center gap-3">
              <Button variant="outline" size="icon" aria-label="Back to posts" asChild>
                  <Link href="/cms/posts">
                      <ArrowLeft className="h-4 w-4" />
                  </Link>
              </Button>
              <div>
                  <h1 className="text-2xl font-bold">Edit Post</h1>
                  <p className="text-sm text-muted-foreground truncate max-w-md" title={postWithBlocks.title}>{postWithBlocks.title}</p>
              </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
              {allSiteLanguages.length > 0 && (
                   <ContentLanguageSwitcher
                      currentItem={postWithBlocks}
                      itemType="post"
                      allSiteLanguages={allSiteLanguages}
                    />
              )}
              {postWithBlocks.translation_group_id && allSiteLanguages.length > 1 && (
                <CopyContentFromLanguage
                  parentId={postId}
                  parentType="post"
                  currentLanguageId={postWithBlocks.language_id}
                  translationGroupId={postWithBlocks.translation_group_id}
                  allSiteLanguages={allSiteLanguages}
                />
              )}
              <Button variant="secondary" asChild>
                <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                  <FilePenLine className="mr-2 h-4 w-4" />
                  Preview
                </a>
              </Button>
              {isLive && (
                <Button variant="outline" asChild>
                  <a href={liveUrl} target="_blank" rel="noopener noreferrer">
                    <Eye className="mr-2 h-4 w-4" /> View Live
                  </a>
                </Button>
              )}
              <RevisionHistoryButton parentType="post" parentId={postId} />
              <VisibilityControl
                type="post"
                id={postId}
                status={liveStatus}
                publishedAt={livePublishedAt}
                publicPath={liveViewUrl}
                languageName={language ? `${language.name} (${language.code.toUpperCase()})` : undefined}
                translationGroupId={postWithBlocks.translation_group_id}
                languages={allSiteLanguages}
                hasDraft={hasDraft}
              />
          </div>
        </div>

        <DraftStatusActions parentId={postId} parentType="post" hasDraft={hasDraft} />

        <PostForm
          post={postWithBlocks as PostType & { feature_image_id?: string | null }}
          formAction={updatePostWithId}
          // Read-only: the form never writes blocks, it only lets Cortex AI read them so it
          // can summarize the article when drafting meta title and description.
          contentBlocks={postWithBlocks.blocks}
          actionButtonText="Update Post Metadata"
          isEditing={true}
          availableLanguagesProp={allSiteLanguages}
          initialFeatureImageUrl={initialFeatureImageUrl}
          initialFeatureImageId={initialFeatureImageIdProp}
        />

        {/*
          Between the metadata form and the blocks because that is exactly what
          it grades: everything above it and everything below it, together. It
          collapses to a single summary row so the block editor keeps its place
          on the screen.
        */}
        <PageSeoAuditSection />

        <Separator className="my-8" />

        <div className="w-full mx-auto px-6">
          <h2 className="text-xl font-semibold mb-4">Post Content Blocks</h2>
          <BlockEditorArea
            parentId={postWithBlocks.id}
            parentType="post"
            initialBlocks={postWithBlocks.blocks}
            languageId={postWithBlocks.language_id}
          />
        </div>
      </div>
      </PageSeoProvider>
    </UploadFolderProvider>
  );
}
