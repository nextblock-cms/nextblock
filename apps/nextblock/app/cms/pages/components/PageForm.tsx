// app/cms/pages/components/PageForm.tsx
"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@nextblock-cms/ui";
import { Spinner, Alert, AlertDescription } from "@nextblock-cms/ui";
import { Input } from "@nextblock-cms/ui";
import { Label } from "@nextblock-cms/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nextblock-cms/ui";
import { Textarea } from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";
import { useAuth } from '../../../../context/AuthContext';
import { useHotkeys } from '../../../../hooks/use-hotkeys';
import FeatureImageField from "../../components/FeatureImageField";
import { useCortexAiActive } from "../../components/CortexAiActiveContext";
import GenerateMetaButton, {
  type GeneratedSeoMetadata,
} from "../../../../components/seo/GenerateMetaButton";
import SocialPreviewDialog from "../../../../components/seo/SocialPreviewDialog";
import { buildSeoContentForGeneration } from "../../../../lib/seo/block-content";
import { usePageSeo } from "../../../../lib/seo/page-audit-context";
import { resolveSiteUrl } from "../../../../lib/site-url";

type Page = Database['public']['Tables']['pages']['Row'];
type Language = Database['public']['Tables']['languages']['Row'];
// Remove: import { getActiveLanguagesClientSide } from "@nextblock-cms/db";

/**
 * Google truncates a title around 60 characters and a description around 160. These are
 * soft advice, not validation — the same numbers `SiteSeoSettingsForm` shows, and the same
 * amber-past-the-limit treatment, so the counter means one thing everywhere in the CMS.
 */
const META_TITLE_RECOMMENDED_MAX = 60;
const META_DESCRIPTION_RECOMMENDED_MAX = 160;

interface PageFormProps {
  page?: (Page & { feature_image_id?: string | null }) | null;
  formAction: (formData: FormData) => Promise<{ error?: string } | void>;
  actionButtonText?: string;
  isEditing?: boolean;
  availableLanguagesProp: Language[]; // New prop
  translationGroupId?: string;
  target_lang_id?: string;
  initialFeatureImageUrl?: string | null;
  initialFeatureImageId?: string | null;
  /**
   * The page's block rows, read-only, purely so Cortex AI can be asked to summarize the
   * page it is writing metadata for.
   *
   * Deliberately NOT a form field and NOT persisted by this form: nothing here is added to
   * the FormData, to `hasChanges`, or to the autosave dependency list. It flows one way,
   * parent → form → AI request. Blocks have their own editor and their own save path
   * (`BlockEditorArea`); this form must never become a second writer of them.
   */
  contentBlocks?: unknown;
}

export default function PageForm({
  page,
  formAction,
  actionButtonText = "Save Page",
  isEditing = false,
  availableLanguagesProp, // Use the new prop
  translationGroupId,
  target_lang_id,
  initialFeatureImageUrl,
  initialFeatureImageId,
  contentBlocks,
}: PageFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { user, isLoading: authLoading } = useAuth();

  const [title, setTitle] = useState(page?.title || "");
  const [slug, setSlug] = useState(page?.slug || "");
  const [languageId, setLanguageId] = useState<string>(() => {
    // If editing, use the page's language
    if (page?.language_id) {
      return page.language_id.toString();
    }
    // If creating a translation, use the target language
    if (target_lang_id) {
      return target_lang_id;
    }
    // Otherwise, find the default language from the available languages
    if (availableLanguagesProp && availableLanguagesProp.length > 0) {
      const defaultLang = availableLanguagesProp.find((l) => l.is_default);
      if (defaultLang) {
        return defaultLang.id.toString();
      }
      // As a fallback, use the first available language
      return availableLanguagesProp[0].id.toString();
    }
    // If no languages are available, default to an empty string
    return "";
  });
  const [metaTitle, setMetaTitle] = useState(page?.meta_title || "");
  const [metaDescription, setMetaDescription] = useState(
    page?.meta_description || ""
  );
  const [customCanonical, setCustomCanonical] = useState(page?.custom_canonical || "");
  const [featureImageId, setFeatureImageId] = useState<string | null>(
    initialFeatureImageId || page?.feature_image_id || null
  );
  /**
   * The resolved URL of the feature image, for the share preview only.
   *
   * This one is exempt from everything the autosave path looks at, and the exemption is
   * deliberate rather than an oversight: it is absent from the FormData, from `hasChanges`,
   * and from the autosave effect's dependency array. `feature_image_id` is the persisted
   * field — `FeatureImageField` renders it as the hidden input and the diff above already
   * watches it — and the URL is nothing but that id resolved against the `media` row, which
   * the server redoes on the next render. Persisting it would store a duplicate that can go
   * stale, and adding it to the autosave deps would only schedule a second save for the
   * change `featureImageId` already covers.
   *
   * It exists because the preview was previously bound to `initialFeatureImageUrl`, which
   * is fixed for the life of the render — so picking an image left the share card showing
   * the old one (or a placeholder) until a full reload, which defeats a live preview.
   */
  const [featureImageUrl, setFeatureImageUrl] = useState<string | null>(
    initialFeatureImageUrl || null
  );

  const isCortexAiActive = useCortexAiActive();
  /**
   * The social-specific copy Cortex AI returns alongside the meta fields.
   *
   * This is held in component state and never written anywhere. There are no
   * `og_title` / `og_description` columns on `pages`, and adding one is not a one-line
   * change — a new persisted field needs the useState, the sync-from-prop effect AND its
   * dependency array, `hasChanges`, the autosave deps, the FormData fallback list, the JSX
   * `name`, the server action's rawFormData/updateData/payload type, and the draft overlay
   * in the edit RSC, and missing any one of those makes the field silently never save.
   * So the OG copy exists to inform the meta fields, which DO persist, and the operator can
   * fold it in with one click. The live share card is built from the meta title and
   * description below plus the feature image.
   */
  const [socialSuggestion, setSocialSuggestion] = useState<{
    ogDescription: string;
    ogTitle: string;
  } | null>(null);

  /**
   * Prose for the metadata call. Memoized because this form re-renders on every keystroke
   * (each one re-arms the autosave timer) and flattening a page's whole block tree on each
   * of those would be real, pointless work — the blocks themselves cannot change while
   * this form is mounted, since they are edited by `BlockEditorArea` below.
   *
   * On a brand-new page with no blocks the title is a thin but genuine brief, which beats
   * a permanently disabled button on day one.
   */
  const seoContent = useMemo(
    () => buildSeoContentForGeneration(contentBlocks, title),
    [contentBlocks, title]
  );

  // Use the passed-in languages
  const [availableLanguages] = useState<Language[]>(availableLanguagesProp);
  // languagesLoading is no longer needed if languages are passed as props
  // const [languagesLoading, setLanguagesLoading] = useState(true); // Remove or set to false initially

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
      setFormMessage({ type: 'success', text: successMessage });
    } else if (errorMessage) {
      setFormMessage({ type: 'error', text: errorMessage });
    }
  }, [searchParams]);

  useEffect(() => {
    if (!page) {
      return;
    }

    setTitle(page.title || "");
    setSlug(page.slug || "");
    setLanguageId(page.language_id?.toString() || "");
    setMetaTitle(page.meta_title || "");
    setMetaDescription(page.meta_description || "");
    setCustomCanonical(page.custom_canonical || "");
    setFeatureImageId(initialFeatureImageId || page.feature_image_id || null);
    // Re-seeded in lockstep with the id above. Both come from the same server-resolved
    // media row, so letting the id snap back to the props while the URL kept a newer value
    // would put the preview and the field it previews out of step.
    setFeatureImageUrl(initialFeatureImageUrl || null);
  }, [
    initialFeatureImageId,
    initialFeatureImageUrl,
    page?.id,
    page?.custom_canonical,
    page?.language_id,
    page?.meta_description,
    page?.meta_title,
    page?.slug,
    page?.title,
    page?.updated_at,
  ]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (!isEditing || !slug) {
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
      formData.append("meta_title", metaTitle);
      formData.append("meta_description", metaDescription);
      formData.append("custom_canonical", customCanonical);
      formData.append("feature_image_id", featureImageId || "");
      if (translationGroupId) {
        formData.append("translation_group_id", translationGroupId);
      }
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
      title !== (page?.title || "") ||
      slug !== (page?.slug || "") ||
      languageId !== (page?.language_id?.toString() || "") ||
      metaTitle !== (page?.meta_title || "") ||
      metaDescription !== (page?.meta_description || "") ||
      customCanonical !== (page?.custom_canonical || "") ||
      featureImageId !== (page?.feature_image_id || null);

    if (!hasChanges) return;

    const timer = setTimeout(() => {
      saveDraft();
    }, 1000);

    return () => clearTimeout(timer);
    // customCanonical belongs here too: hasChanges checks it, so leaving it out
    // meant editing only the canonical URL never scheduled a save.
  }, [title, slug, languageId, metaTitle, metaDescription, customCanonical, featureImageId, page, isEditing]);

  /**
   * Hand the live meta fields to the page-level SEO audit.
   *
   * The panel that grades a page cannot read this form's state directly — it renders as a
   * sibling, not a child — so the title and description have to be published outward. This
   * is a one-way broadcast of values this form ALREADY owns and already persists; it adds
   * no field, changes nothing about what `hasChanges` above compares, and puts nothing in
   * the FormData. The autosave diff is deliberately untouched, because publishing a value
   * is not the same event as changing one: were `setMeta` wired into that diff, merely
   * mounting the audit panel would look like an edit and schedule a draft write.
   *
   * `usePageSeo()` returns null when no provider is above this form, which is a supported
   * arrangement rather than a bug — some surfaces embed these fields without a page-level
   * panel — so the call is optional all the way through.
   *
   * The dependency is `setPageSeoMeta`, not the whole context value: the setter is a stable
   * `useCallback`, whereas the context object is rebuilt whenever the blocks array changes,
   * which would re-run this effect on every keystroke elsewhere in the editor. The setter
   * also bails when the values are unchanged, so there is no path from this effect back into
   * a render of this form and therefore no loop.
   */
  const setPageSeoMeta = usePageSeo()?.setMeta;
  useEffect(() => {
    setPageSeoMeta?.({ metaDescription, metaTitle });
  }, [metaDescription, metaTitle, setPageSeoMeta]);

  // Removed languagesLoading from this condition
  if (authLoading) {
    return <div>Loading form...</div>;
  }

  if (!user) {
    return <div>Please log in to manage pages.</div>;
  }

  const selectedLanguageCode =
    availableLanguages.find((lang) => lang.id.toString() === languageId)?.code ?? null;
  // What the share card will actually show. Meta title wins when set, because that is what
  // `buildSocialMetadata` uses; otherwise the page title, exactly as the public site does.
  const previewTitle = metaTitle.trim() || title.trim();
  const previewUrl = `${resolveSiteUrl()}/${(slug || "").replace(/^\/+/, "")}`;

  /**
   * Fold a generation into the form.
   *
   * Setting state is the whole persistence story here: the autosave effect above diffs
   * this state against the `page` prop and calls `formAction` a second later, writing into
   * `content_drafts`. A direct row UPDATE from this handler would bypass the draft and
   * mutate the live page — precisely the thing draft mode exists to prevent.
   */
  /**
   * Track the picked image for the preview as well as for the save.
   *
   * The id half feeds `hasChanges` and therefore the autosave; the URL half is purely
   * presentational (see the state declaration above) and stops here.
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
          <span className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground/80">Page Settings</span>
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
      {translationGroupId && (
        <input type="hidden" name="translation_group_id" value={translationGroupId} />
      )}

      {/* Row 1: Basic Page Information */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Title */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="title" className="text-xs font-medium">Title</Label>
          <Input
            id="title"
            name="title"
            value={title}
            onChange={handleTitleChange}
            required
            className="h-9"
          />
        </div>

        {/* Slug */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="slug" className="text-xs font-medium">Slug</Label>
          <Input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            className="h-9"
          />
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight truncate" title="URL-friendly identifier. Auto-generated from title if left empty on creation.">
            URL-friendly identifier. Auto-generated from title if left empty.
          </p>
        </div>

        {/* Language. Visibility deliberately lives in the top bar, not here: this
            form autosaves into the Live Draft on every keystroke, and publishing
            must never be a side effect of editing settings. */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="language_id" className="text-xs font-medium">Language</Label>
          {availableLanguages.length > 0 ? (
            <Select
              name="language_id"
              defaultValue={target_lang_id}
              value={languageId}
              onValueChange={setLanguageId}
              required
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                {availableLanguages.map((lang) => (
                  <SelectItem key={lang.id} value={lang.id.toString()}>
                    {lang.name} ({lang.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground py-2 leading-none">No languages available.</p>
          )}
        </div>
      </div>

      {/* Row 2: SEO Settings. Canonical override (optional): blank = self-referencing canonical.

          This header is no longer gated on `isCortexAiActive`. It now carries the share-card
          trigger, which has nothing to do with the AI package and must be reachable on every
          install; only the generate button remains premium-gated, inside the row. */}
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
          {/* The share-card rehearsal lives in a modal rather than inline: it is a glance,
              not a field, and inline it added roughly four hundred pixels to a form that
              already scrolls. Sitting here it is adjacent to the two inputs it previews.
              Every prop is live form state, so the card repaints while the dialog is open,
              and none of it is written anywhere — see `SocialPreviewDialog`. */}
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
          <Input
            id="meta_title"
            name="meta_title"
            value={metaTitle}
            onChange={(e) => setMetaTitle(e.target.value)}
            className="h-9"
          />
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
          <Textarea
            id="meta_description"
            name="meta_description"
            value={metaDescription}
            onChange={(e) => setMetaDescription(e.target.value)}
            className="min-h-[36px] h-9 py-1.5 resize-y text-sm leading-normal"
            rows={1}
            placeholder="Meta description for search engines..."
          />
        </div>

        {/* Canonical URL */}
        <div className="md:col-span-4 flex flex-col gap-1">
          <Label htmlFor="custom_canonical" className="text-xs font-medium">Canonical URL (SEO, optional)</Label>
          <Input
            id="custom_canonical"
            name="custom_canonical"
            value={customCanonical}
            onChange={(e) => setCustomCanonical(e.target.value)}
            className="h-9"
            placeholder="Blank = self-referencing. Absolute https://… URL or /relative path to override."
          />
        </div>
      </div>

      {/* Social-specific copy Cortex AI suggested. It is shown, not stored: pages have no
          Open Graph columns, so the only way it can survive is by being folded into the
          meta fields — hence the one-click apply rather than a read-only curiosity. */}
      {socialSuggestion && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">
            Cortex AI also drafted social-specific copy. Pages have no separate Open Graph
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
        description={
          slug === 'home' ? (
            <>
              On a page this renders a <strong>full-width banner above your content</strong>, with the page
              title centred over it. A home page that starts with its own hero section usually should not
              have one. To set the image shown when someone shares a link, use{' '}
              <Link className="underline" href="/cms/settings/logos">
                Branding &rarr; Social preview image
              </Link>{' '}
              instead.
            </>
          ) : (
            <>
              Renders as a full-width banner above your content, with the page title centred over it, so
              pick a very wide image. Leave it empty on a page that opens with its own hero section. It is
              also this page&rsquo;s link preview image.
            </>
          )
        }
        initialImageId={initialFeatureImageId || page?.feature_image_id || null}
        initialImageUrl={initialFeatureImageUrl || null}
        onImageIdChange={handleFeatureImageChange}
        uploadFolder={`pages/${(slug || 'untitled').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')}/`}
      />

      {!isEditing && (
        <div className="flex justify-end space-x-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/cms/pages")}
            disabled={isPending}
          >
            Cancel
          </Button>
          {/* Ensure button is not disabled due to removed languagesLoading */}
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
