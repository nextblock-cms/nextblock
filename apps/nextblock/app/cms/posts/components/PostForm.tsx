// app/cms/posts/components/PostForm.tsx
"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@nextblock-cms/ui";
import { Input } from "@nextblock-cms/ui";
import { Label } from "@nextblock-cms/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nextblock-cms/ui";
import { Spinner, Alert, AlertDescription } from "@nextblock-cms/ui";
import { Textarea } from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";
import { useAuth } from '../../../../context/AuthContext';
import FeatureImageField from "../../components/FeatureImageField";
import { useCortexAiActive } from "../../components/CortexAiActiveContext";
import GenerateMetaButton, {
  type GeneratedSeoMetadata,
} from "../../../../components/seo/GenerateMetaButton";
import SocialPreviewDialog from "../../../../components/seo/SocialPreviewDialog";
import { buildSeoContentForGeneration } from "../../../../lib/seo/block-content";
import { usePageSeo } from "../../../../lib/seo/page-audit-context";
import { resolveSiteUrl } from "../../../../lib/site-url";

type Post = Database['public']['Tables']['posts']['Row'];
type Language = Database['public']['Tables']['languages']['Row'];
import { useHotkeys } from '../../../../hooks/use-hotkeys';

/**
 * The same soft limits `SiteSeoSettingsForm` and `PageForm` show, with the same
 * amber-past-the-limit treatment, so a counter means one thing everywhere in the CMS.
 */
const META_TITLE_RECOMMENDED_MAX = 60;
const META_DESCRIPTION_RECOMMENDED_MAX = 160;

interface PostFormProps {
  post?: Post & { feature_image_id?: string | null };
  formAction: (formData: FormData) => Promise<{ error?: string } | void>;
  actionButtonText?: string;
  isEditing?: boolean;
  availableLanguagesProp?: Language[]; // Make optional
  initialFeatureImageUrl?: string | null;
  initialFeatureImageId?: string | null;
  /**
   * The post's block rows, read-only, so Cortex AI can be asked to summarize the article
   * it is writing metadata for.
   *
   * Deliberately NOT a form field and NOT persisted: it is absent from the FormData, from
   * `hasChanges`, and from the autosave dependency list. Blocks are owned by
   * `BlockEditorArea` and have their own save path; this form must never become a second
   * writer of them.
   */
  contentBlocks?: unknown;
}

export default function PostForm({
  post,
  formAction,
  actionButtonText = "Save Post",
  isEditing = false,
  availableLanguagesProp = [], // Default to empty array
  initialFeatureImageUrl,
  initialFeatureImageId,
  contentBlocks,
}: PostFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { user, isLoading: authLoading } = useAuth();

  const [title, setTitle] = useState(post?.title || "");
  const [slug, setSlug] = useState(post?.slug || "");
  const [label, setLabel] = useState(post?.label || "");
  const [languageId, setLanguageId] = useState<string>(
    post?.language_id?.toString() || ""
  );
  const [excerpt, setExcerpt] = useState(post?.excerpt || "");
  const [subtitle, setSubtitle] = useState(post?.subtitle || "");
  const [metaTitle, setMetaTitle] = useState(post?.meta_title || "");
  const [metaDescription, setMetaDescription] = useState(
    post?.meta_description || ""
  );
  const [customCanonical, setCustomCanonical] = useState(post?.custom_canonical || "");
  const [featureImageId, setFeatureImageId] = useState<string | null>(
    initialFeatureImageId || post?.feature_image_id || null
  );
  /**
   * The resolved URL of the feature image, for the share preview only.
   *
   * Exempt from the whole autosave path on purpose, not by omission: it is absent from the
   * FormData, from `hasChanges`, and from the autosave effect's dependency array.
   * `feature_image_id` is the field that persists — `FeatureImageField` renders it as the
   * hidden input and the diff below already watches it — and this URL is only that id
   * resolved against the `media` row, which the server redoes on every render. Storing it
   * would store a duplicate that can go stale, and putting it in the autosave deps would
   * schedule a second save for a change `featureImageId` already covers.
   *
   * It exists because the preview used to read `initialFeatureImageUrl`, which is fixed for
   * the life of the render, so picking an image left the share card showing the previous one
   * (or a placeholder) until a reload — which is the opposite of a live preview.
   */
  const [featureImageUrl, setFeatureImageUrl] = useState<string | null>(
    initialFeatureImageUrl || null
  );

  const isCortexAiActive = useCortexAiActive();
  /**
   * Social-specific copy from Cortex AI, held in state and never stored.
   *
   * `posts` has no `og_title` / `og_description` columns, and adding one is not a one-line
   * change — a new persisted field needs the useState, the sync-from-prop effect AND its
   * dependency array, `hasChanges`, the autosave deps, the FormData fallback list, the JSX
   * `name`, the server action's rawFormData/updateData/payload type, and the draft overlay
   * in the edit RSC; miss one and the field silently never saves. So the OG copy informs
   * the meta fields, which do persist, and the share card is built from those plus the
   * feature image.
   */
  const [socialSuggestion, setSocialSuggestion] = useState<{
    ogDescription: string;
    ogTitle: string;
  } | null>(null);

  /**
   * Prose for the metadata call: the article body first, then the editorial summaries the
   * author has already written, so a post that is still an outline can still be described.
   *
   * Memoized because this form re-renders on every keystroke (each one re-arms the autosave
   * timer), and re-flattening the whole article on each of those would be real, pointless
   * work — the blocks cannot change while this form is mounted, since `BlockEditorArea`
   * below owns them.
   */
  const seoContent = useMemo(
    () => buildSeoContentForGeneration(contentBlocks, excerpt, subtitle, title),
    [contentBlocks, excerpt, subtitle, title]
  );

  // Use the passed-in languages directly
  const [availableLanguages] = useState<Language[]>(availableLanguagesProp);

  const [formMessage, setFormMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const isFirstRender = useRef(true);

  useHotkeys('ctrl+s', () => formRef.current?.requestSubmit());


  useEffect(() => {
    const successMessage = searchParams.get('success');
    const errorMessage = searchParams.get('error');
    if (successMessage) {
      setFormMessage({ type: 'success', text: decodeURIComponent(successMessage) });
    } else if (errorMessage) {
      setFormMessage({ type: 'error', text: decodeURIComponent(errorMessage) });
    }
  }, [searchParams]);

  useEffect(() => {
    if (!post) {
      return;
    }

    setTitle(post.title || "");
    setSlug(post.slug || "");
    setLabel(post.label || "");
    setLanguageId(post.language_id?.toString() || "");
    setExcerpt(post.excerpt || "");
    setSubtitle(post.subtitle || "");
    setMetaTitle(post.meta_title || "");
    setMetaDescription(post.meta_description || "");
    setCustomCanonical(post.custom_canonical || "");
    setFeatureImageId(initialFeatureImageId || post.feature_image_id || null);
    // Re-seeded in lockstep with the id above: both are derived from the same
    // server-resolved media row, so snapping the id back to the props while the URL kept a
    // newer value would leave the preview describing an image the field no longer holds.
    setFeatureImageUrl(initialFeatureImageUrl || null);
  }, [
    initialFeatureImageId,
    initialFeatureImageUrl,
    post?.custom_canonical,
    post?.excerpt,
    post?.id,
    post?.label,
    post?.language_id,
    post?.meta_description,
    post?.meta_title,
    post?.slug,
    post?.subtitle,
    post?.title,
    post?.updated_at,
  ]);

  // Initialize languageId if creating new post and languages are available
  useEffect(() => {
    if (!isEditing && availableLanguages.length > 0 && !languageId) { // check !isEditing too
      const defaultLang = availableLanguages.find(l => l.is_default) || availableLanguages[0];
      if (defaultLang) {
          setLanguageId(defaultLang.id.toString());
      }
    }
  }, [isEditing, availableLanguages, languageId]); // Add isEditing to dependency array


  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (!isEditing || !slug) { // Only auto-generate slug if creating new or slug is empty
      setSlug(newTitle.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]+/g, ""));
    }
  };

  const saveDraft = async (customFormData?: FormData) => {
    if (!title.trim() || !slug.trim()) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);

    const formData = customFormData || (formRef.current ? new FormData(formRef.current) : new FormData());
    if (!customFormData && !formRef.current) {
      formData.append("title", title);
      formData.append("slug", slug);
      formData.append("language_id", languageId);
      formData.append("label", label);
      formData.append("excerpt", excerpt);
      formData.append("subtitle", subtitle);
      formData.append("meta_title", metaTitle);
      formData.append("meta_description", metaDescription);
      formData.append("custom_canonical", customCanonical);
      formData.append("feature_image_id", featureImageId || "");
    }

    try {
      const result = await formAction(formData);
      if (result && 'error' in result && result.error) {
        setSaveError(result.error);
        setFormMessage({ type: 'error', text: result.error });
      } else {
        setLastSaved(new Date());
        setFormMessage(null);
        router.refresh();
      }
    } catch (err: any) {
      const msg = err.message || "Failed to save draft";
      setSaveError(msg);
      setFormMessage({ type: 'error', text: msg });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isEditing) {
      setFormMessage(null);
      const formData = new FormData(event.currentTarget);

      startTransition(async () => {
        const result = await formAction(formData);
        if (result?.error) {
          setFormMessage({ type: 'error', text: result.error });
        }
      });
    } else {
      await saveDraft();
    }
  };

  useEffect(() => {
    if (!isEditing) return;

    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const hasChanges =
      title !== (post?.title || "") ||
      slug !== (post?.slug || "") ||
      label !== (post?.label || "") ||
      languageId !== (post?.language_id?.toString() || "") ||
      excerpt !== (post?.excerpt || "") ||
      subtitle !== (post?.subtitle || "") ||
      metaTitle !== (post?.meta_title || "") ||
      metaDescription !== (post?.meta_description || "") ||
      customCanonical !== (post?.custom_canonical || "") ||
      featureImageId !== (post?.feature_image_id || null);

    if (!hasChanges) return;

    const timer = setTimeout(() => {
      saveDraft();
    }, 1000);

    return () => clearTimeout(timer);
  }, [
    title,
    slug,
    label,
    languageId,
    excerpt,
    subtitle,
    metaTitle,
    metaDescription,
    customCanonical,
    featureImageId,
    post,
    isEditing,
  ]);

  /**
   * Hand the live meta fields to the page-level SEO audit.
   *
   * The panel that grades an article renders as a sibling of this form, not a child, so it
   * cannot read this state directly — the values have to be published outward. This is a
   * one-way broadcast of fields this form ALREADY owns and already persists: it adds no
   * field, changes nothing about what `hasChanges` above compares, and puts nothing in the
   * FormData. Leaving the autosave diff alone is the point, because publishing a value is a
   * different event from changing one — wiring `setMeta` into that diff would make merely
   * mounting the audit panel look like an edit and schedule a draft write.
   *
   * `usePageSeo()` returns null when no provider sits above this form. That is a supported
   * arrangement rather than a bug — these fields are reachable from surfaces with no
   * page-level panel — so the call stays optional the whole way through.
   *
   * The dependency is `setPageSeoMeta` rather than the context value: the setter is a stable
   * `useCallback`, while the context object is rebuilt whenever the blocks array changes,
   * which would re-run this effect on every keystroke elsewhere in the editor. The setter
   * also bails when the values are unchanged, so nothing here can loop back into a render of
   * this form.
   */
  const pageSeo = usePageSeo();
  const setPageSeoMeta = pageSeo?.setMeta;
  const setPageSeoDocumentTitle = pageSeo?.setDocumentTitle;
  useEffect(() => {
    setPageSeoMeta?.({ metaDescription, metaTitle });
  }, [metaDescription, metaTitle, setPageSeoMeta]);

  useEffect(() => {
    setPageSeoDocumentTitle?.(title);
  }, [title, setPageSeoDocumentTitle]);

  // Remove languagesLoading from this condition
  if (authLoading) {
    return <div>Loading form...</div>;
  }
  if (!user) {
    return <div>Please log in to manage posts.</div>;
  }

  const selectedLanguageCode =
    availableLanguages.find((lang) => lang.id.toString() === languageId)?.code ?? null;
  const previewTitle = metaTitle.trim() || title.trim();
  const previewUrl = `${resolveSiteUrl()}/article/${(slug || "").replace(/^\/+/, "")}`;

  /**
   * Fold a generation into the form.
   *
   * Setting state is the entire persistence story: the autosave effect diffs this state
   * against the `post` prop and calls `formAction` a second later, writing into
   * `content_drafts`. A direct row UPDATE here would bypass the draft and mutate the live
   * post — exactly what draft mode exists to prevent.
   */
  /**
   * Track the picked image for the preview as well as for the save.
   *
   * The id half feeds `hasChanges` and therefore the autosave; the URL half is purely
   * presentational (see the state declaration above) and goes no further than the card.
   */
  const handleFeatureImageChange = (imageId: string | null, imageUrl: string | null) => {
    setFeatureImageId(imageId);
    setFeatureImageUrl(imageUrl);
  };

  const handleGeneratedMetadata = (result: GeneratedSeoMetadata) => {
    if (result.metaTitle) {
      setMetaTitle(result.metaTitle);
    }
    if (result.metaDescription) {
      setMetaDescription(result.metaDescription);
    }
    setSocialSuggestion(
      result.ogTitle || result.ogDescription
        ? { ogDescription: result.ogDescription, ogTitle: result.ogTitle }
        : null
    );
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4 w-full mx-auto px-6">
      {isEditing && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 border-b border-border/40 mb-2">
          <span className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground/80">Post Settings</span>
          <div className="flex items-center gap-1.5 min-h-[16px]">
            {isSaving ? (
              <>
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </div>
                <span className="text-amber-600 dark:text-amber-400 font-medium">Autosaving settings...</span>
              </>
            ) : saveError ? (
              <span className="text-red-500 font-medium">Error saving settings: {saveError}</span>
            ) : lastSaved ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                Settings autosaved at {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            ) : (
              <span className="text-muted-foreground/60">Settings autosave in draft mode</span>
            )}
          </div>
        </div>
      )}
      {formMessage && (
        <Alert variant={formMessage.type === 'success' ? 'success' : 'destructive'} className="mb-4">
           <AlertDescription>{formMessage.text}</AlertDescription>
        </Alert>
      )}
      {/* Row 1: Basic Post Information */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Title */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="title" className="text-xs font-medium">Title</Label>
          <Input id="title" name="title" value={title} onChange={handleTitleChange} required className="h-9" />
        </div>

        {/* Slug */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="slug" className="text-xs font-medium">Slug</Label>
          <Input id="slug" name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} required className="h-9" />
        </div>

        {/* Language */}
        <div className="md:col-span-2 flex flex-col gap-1">
          <Label htmlFor="language_id" className="text-xs font-medium">Language</Label>
          {availableLanguages.length > 0 ? (
            <Select name="language_id" value={languageId} onValueChange={setLanguageId} required disabled={isEditing}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select language" /></SelectTrigger>
              <SelectContent>
                {availableLanguages.map((lang) => (
                  <SelectItem key={lang.id} value={lang.id.toString()}>{lang.name} ({lang.code})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-tight py-2">No languages available. Add languages in CMS settings.</p>
          )}
        </div>

      </div>

      {/* Row 2: Label. Visibility and the go-live date live in the top bar — this
          form autosaves into the Live Draft, and publishing must never be a side
          effect of editing post settings. */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-6 flex flex-col gap-1">
          <Label htmlFor="label" className="text-xs font-medium">Label</Label>
          <Input id="label" name="label" value={label} onChange={(e) => setLabel(e.target.value)} className="h-9" placeholder="e.g. Architecture" />
          <p className="text-[10px] text-muted-foreground leading-tight">Short pill text shown on the article hero and post cards.</p>
        </div>
      </div>

      {/* Row 3: Excerpt + Subtitle */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Excerpt */}
        <div className="md:col-span-6 flex flex-col gap-1">
          <Label htmlFor="excerpt" className="text-xs font-medium">Excerpt</Label>
          <Textarea id="excerpt" name="excerpt" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} className="resize-y text-sm leading-normal" rows={3} placeholder="Short editorial summary for the hero metadata row and article cards" />
          <p className="text-[10px] text-muted-foreground leading-tight">Used as the short summary above the hero and on public post cards.</p>
        </div>

        {/* Subtitle */}
        <div className="md:col-span-6 flex flex-col gap-1">
          <Label htmlFor="subtitle" className="text-xs font-medium">Subtitle</Label>
          <Textarea id="subtitle" name="subtitle" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} className="resize-y text-sm leading-normal" rows={3} placeholder="Longer deck shown under the article title" />
          <p className="text-[10px] text-muted-foreground leading-tight">Displayed as the larger deck under the article title.</p>
        </div>
      </div>

      {/* Row 4: SEO Settings. Canonical override (optional): blank = self-referencing canonical.

          This header is no longer gated on `isCortexAiActive`. It now carries the share-card
          trigger, which has nothing to do with the AI package and must be reachable on every
          install; only the generate button stays premium-gated, inside the row. */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
          Search &amp; social
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {isCortexAiActive && (
            <GenerateMetaButton
              content={seoContent}
              locale={selectedLanguageCode}
              onGenerated={handleGeneratedMetadata}
              title={title}
            />
          )}
          {/* The share-card rehearsal moved into a modal: it is a glance, not a field, and
              inline it added roughly four hundred pixels to a form that already scrolls.
              Here it sits beside the two inputs it previews. Every prop is live form state,
              so the card repaints while the dialog is open, and none of it is written
              anywhere — see `SocialPreviewDialog`. */}
          <SocialPreviewDialog
            description={metaDescription}
            imageUrl={featureImageUrl}
            title={previewTitle}
            url={previewUrl}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Meta Title */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="meta_title" className="text-xs font-medium">Meta Title (SEO)</Label>
            <span
              className={`text-[10px] ${
                metaTitle.length > META_TITLE_RECOMMENDED_MAX
                  ? 'text-amber-600'
                  : 'text-muted-foreground'
              }`}
            >
              {metaTitle.length}/{META_TITLE_RECOMMENDED_MAX}
            </span>
          </div>
          <Input id="meta_title" name="meta_title" value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} className="h-9" />
        </div>

        {/* Meta Description */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="meta_description" className="text-xs font-medium">Meta Description (SEO)</Label>
            <span
              className={`text-[10px] ${
                metaDescription.length > META_DESCRIPTION_RECOMMENDED_MAX
                  ? 'text-amber-600'
                  : 'text-muted-foreground'
              }`}
            >
              {metaDescription.length}/{META_DESCRIPTION_RECOMMENDED_MAX}
            </span>
          </div>
          <Textarea id="meta_description" name="meta_description" value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} className="min-h-[36px] h-9 py-1.5 resize-y text-sm leading-normal" rows={1} placeholder="Meta description for search engines..." />
        </div>

        {/* Canonical URL */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="custom_canonical" className="text-xs font-medium">Canonical URL (SEO, optional)</Label>
          <Input id="custom_canonical" name="custom_canonical" value={customCanonical} onChange={(e) => setCustomCanonical(e.target.value)} className="h-9" placeholder="Blank = self-referencing. Absolute https://… URL or /relative path to override." />
        </div>
      </div>

      {/* Suggested social copy. Shown, not stored: posts have no Open Graph columns, so the
          only way this survives is by being folded into the meta fields — hence apply. */}
      {socialSuggestion && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">
            Cortex AI also drafted social-specific copy. Posts have no separate Open Graph
            fields, so this is only a suggestion for the meta fields above.
          </p>
          {socialSuggestion.ogTitle && (
            <p className="text-xs text-foreground"><strong>Social title:</strong> {socialSuggestion.ogTitle}</p>
          )}
          {socialSuggestion.ogDescription && (
            <p className="text-xs text-foreground"><strong>Social description:</strong> {socialSuggestion.ogDescription}</p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                if (socialSuggestion.ogTitle) setMetaTitle(socialSuggestion.ogTitle);
                if (socialSuggestion.ogDescription) setMetaDescription(socialSuggestion.ogDescription);
              }}
            >
              Use for meta fields
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setSocialSuggestion(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <FeatureImageField
        initialImageId={initialFeatureImageId || post?.feature_image_id || null}
        initialImageUrl={initialFeatureImageUrl || null}
        onImageIdChange={handleFeatureImageChange}
        uploadFolder={`posts/${(slug || 'untitled').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')}/`}
      />
    
      {!isEditing && (
        <div className="flex justify-end space-x-3 pt-6"> {/* Increased pt for spacing */}
          <Button type="button" variant="outline" onClick={() => router.push("/cms/posts")} disabled={isPending}>Cancel</Button>
          <Button type="submit" disabled={isPending || authLoading || availableLanguages.length === 0}>
            {isPending ? (
              <>
                <Spinner className="mr-2 h-4 w-4" /> Saving...
              </>
            ) : (
              actionButtonText
            )}
          </Button>
        </div>
      )}
    </form>
  );
}
