'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StorefrontEditor } from '@nextblock-cms/affiliates/editor';
import {
  AFFILIATE_PAGE_STATUS_COPY_KEYS,
  isStorefrontDocEmpty,
  type AffiliatePageStatus,
  type StorefrontDoc,
  type StorefrontEditorApi,
  type StorefrontEditorProduct,
  type StorefrontEditorUploadResult,
} from '@nextblock-cms/affiliates';
import { Button, Input, Label, Textarea } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';

import { StorefrontCopilotPanel } from '../../../../../components/affiliates/StorefrontCopilotPanel';
import {
  resolveStorefrontProducts,
  saveStorefrontDraft,
  searchStorefrontProducts,
  submitStorefrontForReview,
  withdrawStorefrontSubmission,
} from '../actions';
import { createDraftAutosaver, STOREFRONT_AUTOSAVE_DELAY_MS, type DraftAutosaveStatus, type DraftAutosaver, type DraftSaveOutcome } from './draft-autosave';
import { FeaturedProductsCard } from './FeaturedProductsCard';
import { ProfileCard, type ProfileDraft } from './ProfileCard';
import { PortalNotice } from './PortalNotice';
import type { PortalCopyKey } from './portal-copy';
import { PORTAL_ACTION_ERROR_KEYS, portalUploadErrorKey } from './portal-messages';
import type { RetailerPortalActionError } from './portal-types';
import { StorefrontPreview } from './StorefrontPreview';
import { uploadPortalImage } from './upload-client';
import { usePortalCopy } from './use-portal-copy';

export const STOREFRONT_TITLE_MAX = 120;
export const STOREFRONT_META_DESCRIPTION_MAX = 300;
const META_DESCRIPTION_IDEAL_MAX = 160;

export interface StorefrontStudioPage {
  title: string;
  metaDescription: string;
  /** The stored draft, sanitized on the server. */
  doc: StorefrontDoc;
  featuredProductIds: string[];
  featuredProducts: StorefrontEditorProduct[];
  draftVersion: number;
  approvalStatus: AffiliatePageStatus;
  adminFeedbackNote: string | null;
}

export interface StorefrontStudioProps {
  siteOrigin: string;
  allowedImageOrigins: string[];
  suspended: boolean;
  isLive: boolean;
  profile: ProfileDraft;
  avatarUrl: string | null;
  page: StorefrontStudioPage;
  profileChangedSincePublish: boolean;
  /**
   * Localized reason, set by the page when the site's Cortex AI package is inactive: the copilot
   * panel is then disabled and says why, instead of answering every message with a 403 notice.
   */
  copilotUnavailableReason?: string | null;
}

interface DraftSnapshot {
  title: string;
  metaDescription: string;
  doc: StorefrontDoc;
  featuredIds: string[];
}

type Notice = { tone: 'info' | 'success' | 'error'; text: string } | null;

const STATUS_PILL_CLASSES: Readonly<Record<AffiliatePageStatus, string>> = {
  DRAFT: 'border-border bg-muted text-foreground',
  PENDING_REVIEW: 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-50',
  PUBLISHED: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-50',
  CHANGES_REQUESTED: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50',
};

const AUTOSAVE_STATUS_KEYS: Readonly<Record<Exclude<DraftAutosaveStatus, 'blocked'>, PortalCopyKey>> = {
  saved: 'affiliates.portal.autosave_saved',
  unsaved: 'affiliates.portal.autosave_unsaved',
  saving: 'affiliates.portal.autosave_saving',
  error: 'affiliates.portal.autosave_error',
};

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The partner's storefront studio: profile, page settings, the restricted editor with debounced
 * autosave (optimistic concurrency on `draft_version`), featured products, a preview through the
 * public renderer, submission for review, and the copilot panel.
 *
 * Nothing here is trusted by the server: every save is validated, sanitized and re-scoped to the
 * partner's own page by the server actions.
 */
export function StorefrontStudio(props: StorefrontStudioProps) {
  const { t, locale } = usePortalCopy();
  const id = useId();
  const { page, suspended } = props;

  // ---- draft state ----
  const [title, setTitle] = useState(page.title);
  const [metaDescription, setMetaDescription] = useState(page.metaDescription);
  const [doc, setDoc] = useState<StorefrontDoc>(page.doc);
  const [editorDoc, setEditorDoc] = useState<StorefrontDoc>(page.doc);
  const [editorKey, setEditorKey] = useState(0);
  const [featuredIds, setFeaturedIds] = useState<string[]>(page.featuredProductIds);
  const [knownProducts, setKnownProducts] = useState<ReadonlyMap<string, StorefrontEditorProduct>>(
    () => new Map(page.featuredProducts.map((product) => [product.id, product])),
  );
  const [approvalStatus, setApprovalStatus] = useState<AffiliatePageStatus>(page.approvalStatus);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(page.adminFeedbackNote);
  const [saveStatus, setSaveStatus] = useState<DraftAutosaveStatus>('saved');
  const [blockReason, setBlockReason] = useState<RetailerPortalActionError | null>(null);
  /** Why the last autosave failed, when the partner can act on it (the page is over the size limit). */
  const [saveError, setSaveError] = useState<'too_large' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<'submit' | 'withdraw' | null>(null);
  const [editorApi, setEditorApi] = useState<StorefrontEditorApi | null>(null);

  // ---- profile state (saved explicitly by the profile card) ----
  const [profile, setProfile] = useState<ProfileDraft>(props.profile);
  const [profileDirty, setProfileDirty] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(props.avatarUrl);
  const [profileChanged, setProfileChanged] = useState(props.profileChangedSincePublish);

  const versionRef = useRef(page.draftVersion);
  const snapshotRef = useRef<DraftSnapshot>({ title: page.title, metaDescription: page.metaDescription, doc: page.doc, featuredIds: page.featuredProductIds });
  const autosaverRef = useRef<DraftAutosaver<DraftSnapshot> | null>(null);

  const pending = approvalStatus === 'PENDING_REVIEW';
  const editable = !pending && !suspended && blockReason === null;

  // ---- autosave ----
  const saveDraft = useCallback(async (snapshot: DraftSnapshot): Promise<DraftSaveOutcome> => {
    const result = await saveStorefrontDraft({
      title: snapshot.title,
      metaDescription: snapshot.metaDescription,
      draft: snapshot.doc,
      featuredProductIds: snapshot.featuredIds,
      expectedDraftVersion: versionRef.current,
    });
    if (result.ok) {
      setSaveError(null);
      versionRef.current = result.draftVersion;
      setApprovalStatus(result.approvalStatus);
      // The server keeps only active products; show what it stored unless the partner changed them since.
      if (!sameIds(result.featuredProductIds, snapshot.featuredIds) && sameIds(snapshotRef.current.featuredIds, snapshot.featuredIds)) {
        snapshotRef.current = { ...snapshotRef.current, featuredIds: result.featuredProductIds };
        setFeaturedIds(result.featuredProductIds);
      }
      return 'saved';
    }
    // Still retried with the next edit: once the partner shortens the page, the save goes through.
    setSaveError(result.error === 'too_large' ? 'too_large' : null);
    switch (result.error) {
      case 'pending_review':
        setApprovalStatus('PENDING_REVIEW');
        setBlockReason('pending_review');
        return 'blocked';
      case 'conflict':
      case 'unauthorized':
      case 'forbidden':
      case 'suspended':
      case 'package_inactive':
      case 'not_found':
        setBlockReason(result.error);
        return 'blocked';
      default:
        return 'retry';
    }
  }, []);

  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  useEffect(() => {
    const saver = createDraftAutosaver<DraftSnapshot>({
      delayMs: STOREFRONT_AUTOSAVE_DELAY_MS,
      save: (snapshot) => saveDraftRef.current(snapshot),
      onStatus: setSaveStatus,
    });
    autosaverRef.current = saver;
    return () => {
      saver.dispose();
      if (autosaverRef.current === saver) autosaverRef.current = null;
    };
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!autosaverRef.current?.hasPendingChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const queueSave = useCallback((patch: Partial<DraftSnapshot>) => {
    snapshotRef.current = { ...snapshotRef.current, ...patch };
    autosaverRef.current?.update(snapshotRef.current);
  }, []);

  const flushDraft = useCallback(async () => {
    await autosaverRef.current?.flush();
  }, []);

  // ---- follow the server when it re-renders this page ----
  useEffect(() => {
    setApprovalStatus(page.approvalStatus);
    setFeedbackNote(page.adminFeedbackNote);
    if (page.approvalStatus !== 'PENDING_REVIEW') {
      setBlockReason((current) => (current === 'pending_review' ? null : current));
    }
  }, [page.approvalStatus, page.adminFeedbackNote]);

  useEffect(() => {
    // Versions only grow: an older one is a stale render, the same one is what we hold.
    if (page.draftVersion <= versionRef.current) return;
    const saver = autosaverRef.current;
    if (saver?.hasPendingChanges()) {
      saver.block();
      setBlockReason('conflict');
      return;
    }
    versionRef.current = page.draftVersion;
    snapshotRef.current = { title: page.title, metaDescription: page.metaDescription, doc: page.doc, featuredIds: page.featuredProductIds };
    setTitle(page.title);
    setMetaDescription(page.metaDescription);
    setDoc(page.doc);
    setEditorDoc(page.doc);
    setFeaturedIds(page.featuredProductIds);
    setKnownProducts((current) => {
      const next = new Map(current);
      for (const product of page.featuredProducts) next.set(product.id, product);
      return next;
    });
    setEditorKey((key) => key + 1);
    saver?.reset();
    // The page props are replaced as a whole; only a newer version matters here.
  }, [page.draftVersion]);

  // A server re-render brings the stored profile: adopt it only when it really changed and the
  // partner has no unsaved profile edits.
  const profileDirtyRef = useRef(profileDirty);
  profileDirtyRef.current = profileDirty;
  const serverProfileRef = useRef(JSON.stringify(props.profile));
  useEffect(() => {
    const serialized = JSON.stringify(props.profile);
    if (serialized === serverProfileRef.current) return;
    serverProfileRef.current = serialized;
    if (!profileDirtyRef.current) setProfile(props.profile);
  }, [props.profile]);

  useEffect(() => {
    setAvatarUrl(props.avatarUrl);
  }, [props.avatarUrl]);

  // ---- catalog helpers for the editor, the picker and the preview ----
  const rememberProducts = useCallback((products: readonly StorefrontEditorProduct[]) => {
    if (products.length === 0) return;
    setKnownProducts((current) => {
      const next = new Map(current);
      for (const product of products) next.set(product.id, product);
      return next;
    });
  }, []);

  const searchProducts = useCallback(async (query: string) => {
    const result = await searchStorefrontProducts({ query });
    if (!result.ok) throw new Error(result.error);
    return result.products;
  }, []);

  const resolveProducts = useCallback(
    async (ids: string[]) => {
      const result = await resolveStorefrontProducts({ ids });
      if (!result.ok) throw new Error(result.error);
      rememberProducts(result.products);
      return result.products;
    },
    [rememberProducts],
  );

  const uploadImage = useCallback(
    async (file: File): Promise<StorefrontEditorUploadResult | null> => {
      const result = await uploadPortalImage(file, 'image');
      if (result.ok) return { src: result.src, width: result.width, height: result.height };
      setNotice({ tone: 'error', text: t(portalUploadErrorKey(result.error, 'image')) });
      return null;
    },
    [t],
  );

  // ---- change handlers (the only places that queue a save) ----
  const onTitleChange = (value: string) => {
    setTitle(value);
    queueSave({ title: value });
  };
  const onMetaChange = (value: string) => {
    setMetaDescription(value);
    queueSave({ metaDescription: value });
  };
  const onDocChange = useCallback(
    (next: StorefrontDoc) => {
      setDoc(next);
      queueSave({ doc: next });
    },
    [queueSave],
  );
  const onFeaturedChange = (ids: string[], products: StorefrontEditorProduct[]) => {
    rememberProducts(products);
    setFeaturedIds(ids);
    queueSave({ featuredIds: ids });
  };

  // ---- submit and withdraw ----
  const hasTitle = title.trim().length > 0;
  const hasContent = !isStorefrontDocEmpty(doc);
  const upToDate = approvalStatus === 'PUBLISHED' && !profileChanged;
  const canSubmit = editable && hasTitle && hasContent && !upToDate && busy === null;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy('submit');
    setNotice(null);
    try {
      await flushDraft();
      const saver = autosaverRef.current;
      if (saver?.hasPendingChanges() || saver?.getStatus() === 'error' || saver?.getStatus() === 'blocked') {
        setNotice({ tone: 'error', text: t('affiliates.portal.submit_save_first') });
        return;
      }
      const result = await submitStorefrontForReview({ expectedDraftVersion: versionRef.current });
      if (result.ok) {
        setApprovalStatus(result.approvalStatus);
        setNotice({ tone: 'success', text: t('affiliates.portal.submit_success') });
        return;
      }
      if (result.error === 'conflict') setBlockReason('conflict');
      if (result.error === 'pending_review') setApprovalStatus('PENDING_REVIEW');
      setNotice({ tone: 'error', text: t(PORTAL_ACTION_ERROR_KEYS[result.error]) });
    } catch {
      setNotice({ tone: 'error', text: t('affiliates.common.error_network') });
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    if (!pending || busy !== null || suspended) return;
    setBusy('withdraw');
    setNotice(null);
    try {
      const result = await withdrawStorefrontSubmission();
      if (result.ok) {
        setApprovalStatus(result.approvalStatus);
        setBlockReason((current) => (current === 'pending_review' ? null : current));
        autosaverRef.current?.reset();
        setNotice({ tone: 'info', text: t('affiliates.portal.withdraw_success') });
        return;
      }
      setNotice({ tone: 'error', text: t(PORTAL_ACTION_ERROR_KEYS[result.error]) });
    } catch {
      setNotice({ tone: 'error', text: t('affiliates.common.error_network') });
    } finally {
      setBusy(null);
    }
  };

  // ---- copy for the current state ----
  const lockedReason: string | null = suspended
    ? t('affiliates.portal.studio_locked_suspended')
    : pending
      ? t('affiliates.portal.studio_locked_pending')
      : blockReason === 'conflict'
        ? t('affiliates.portal.error_conflict')
        : blockReason
          ? t(PORTAL_ACTION_ERROR_KEYS[blockReason])
          : null;

  const autosaveText =
    saveStatus === 'blocked'
      ? (lockedReason ?? t('affiliates.portal.autosave_error'))
      : saveStatus === 'error' && saveError === 'too_large'
        ? t(PORTAL_ACTION_ERROR_KEYS.too_large)
        : t(AUTOSAVE_STATUS_KEYS[saveStatus]);

  const submitHint = !hasTitle
    ? t('affiliates.portal.submit_need_title')
    : !hasContent
      ? t('affiliates.portal.submit_need_content')
      : upToDate
        ? t('affiliates.portal.submit_up_to_date')
        : null;

  const metaLength = metaDescription.length;
  const metaHintKey: PortalCopyKey =
    metaLength === 0
      ? 'affiliates.portal.meta_hint_empty'
      : metaLength > META_DESCRIPTION_IDEAL_MAX
        ? 'affiliates.portal.meta_hint_long'
        : 'affiliates.portal.meta_hint_ok';

  const onApplyBio = useCallback(
    ({ bio, metaDescription: meta }: { bio: string; metaDescription: string }) => {
      if (!editable) return;
      setProfile((current) => ({ ...current, bio: bio.slice(0, 2000) }));
      setProfileDirty(true);
      const nextMeta = meta.slice(0, STOREFRONT_META_DESCRIPTION_MAX);
      setMetaDescription(nextMeta);
      queueSave({ metaDescription: nextMeta });
      setNotice({ tone: 'info', text: t('affiliates.portal.copilot_bio_applied') });
    },
    [editable, queueSave, t],
  );

  return (
    <div className="space-y-8">
      {suspended ? null : approvalStatus === 'CHANGES_REQUESTED' && feedbackNote ? (
        <PortalNotice tone="warning" title={t('affiliates.portal.banner_changes_title')}>
          <p>{t('affiliates.portal.studio_changes_body')}</p>
          <blockquote className="whitespace-pre-line border-l-4 border-current pl-3 italic">{feedbackNote}</blockquote>
        </PortalNotice>
      ) : null}
      {pending && !suspended ? (
        <PortalNotice tone="info" title={t('affiliates.portal.studio_pending_title')}>
          <p>{t('affiliates.portal.studio_pending_body')}</p>
        </PortalNotice>
      ) : null}
      {blockReason === 'conflict' ? (
        <PortalNotice
          tone="danger"
          title={t('affiliates.portal.conflict_title')}
          action={
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              {t('affiliates.portal.conflict_reload')}
            </Button>
          }
        >
          <p>{t('affiliates.portal.error_conflict')}</p>
        </PortalNotice>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          <section aria-labelledby={`${id}-settings`} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
            <h2 id={`${id}-settings`} className="text-lg font-semibold">
              {t('affiliates.portal.settings_title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('affiliates.portal.settings_description')}</p>
            <div className="mt-5 space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-title`}>{t('affiliates.portal.settings_page_title')}</Label>
                <Input
                  id={`${id}-title`}
                  value={title}
                  maxLength={STOREFRONT_TITLE_MAX}
                  disabled={!editable}
                  aria-describedby={`${id}-title-count`}
                  onChange={(event) => onTitleChange(event.target.value)}
                />
                <p id={`${id}-title-count`} className="text-right text-xs tabular-nums text-muted-foreground">
                  {t('affiliates.portal.character_count', { count: title.length, max: STOREFRONT_TITLE_MAX })}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-meta`}>{t('affiliates.portal.settings_meta')}</Label>
                <Textarea
                  id={`${id}-meta`}
                  value={metaDescription}
                  rows={3}
                  maxLength={STOREFRONT_META_DESCRIPTION_MAX}
                  disabled={!editable}
                  aria-describedby={`${id}-meta-hint ${id}-meta-count`}
                  onChange={(event) => onMetaChange(event.target.value.replace(/[\r\n]+/g, ' '))}
                />
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <p id={`${id}-meta-hint`}>{t(metaHintKey, { max: META_DESCRIPTION_IDEAL_MAX })}</p>
                  <p id={`${id}-meta-count`} className="tabular-nums">
                    {t('affiliates.portal.character_count', { count: metaLength, max: STOREFRONT_META_DESCRIPTION_MAX })}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section aria-labelledby={`${id}-content`} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`${id}-content`} className="text-lg font-semibold text-foreground">
                {t('affiliates.portal.content_title')}
              </h2>
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {autosaveText}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">{t('affiliates.portal.content_description')}</p>
            {saveStatus === 'error' ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void flushDraft()}>
                {t('affiliates.common.retry')}
              </Button>
            ) : null}
            <StorefrontEditor
              key={editorKey}
              initialContent={editorDoc}
              onChange={onDocChange}
              allowedImageOrigins={props.allowedImageOrigins}
              searchProducts={searchProducts}
              resolveProducts={resolveProducts}
              uploadImage={uploadImage}
              editable={editable}
              onEditorReady={setEditorApi}
              ariaLabel={t('affiliates.portal.content_editor_label')}
            />
          </section>

          <StorefrontPreview
            doc={doc}
            title={title}
            displayName={profile.displayName}
            bio={profile.bio}
            avatarUrl={avatarUrl}
            featuredIds={featuredIds}
            knownProducts={knownProducts}
            allowedImageOrigins={props.allowedImageOrigins}
            siteOrigin={props.siteOrigin}
            resolveProducts={resolveProducts}
          />
        </div>

        <div className="min-w-0 space-y-8">
          <section aria-labelledby={`${id}-publish`} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`${id}-publish`} className="text-lg font-semibold">
                {t('affiliates.portal.publish_title')}
              </h2>
              <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', STATUS_PILL_CLASSES[approvalStatus])}>
                <span className="sr-only">{t('affiliates.portal.publish_status_label')} </span>
                {t(AFFILIATE_PAGE_STATUS_COPY_KEYS[approvalStatus])}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t('affiliates.portal.publish_explainer')}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {props.isLive ? t('affiliates.portal.publish_live') : t('affiliates.portal.publish_not_live')}
            </p>

            <div className="mt-4 space-y-2">
              {pending ? (
                <Button type="button" variant="outline" disabled={busy !== null || suspended} onClick={() => void withdraw()}>
                  {busy === 'withdraw' ? t('affiliates.portal.withdrawing') : t('affiliates.portal.withdraw_button')}
                </Button>
              ) : (
                <Button type="button" disabled={!canSubmit} aria-describedby={submitHint ? `${id}-submit-hint` : undefined} onClick={() => void submit()}>
                  {busy === 'submit' ? t('affiliates.portal.submitting') : t('affiliates.portal.submit_button')}
                </Button>
              )}
              {!pending && submitHint && editable ? (
                <p id={`${id}-submit-hint`} className="text-sm text-muted-foreground">
                  {submitHint}
                </p>
              ) : null}
            </div>
            <p
              role="status"
              aria-live="polite"
              className={cn('mt-3 min-h-5 text-sm', notice?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
            >
              {notice?.text ?? ''}
            </p>
          </section>

          <ProfileCard
            value={profile}
            onChange={(next) => {
              setProfile(next);
              setProfileDirty(true);
            }}
            dirty={profileDirty}
            avatarUrl={avatarUrl}
            onAvatarChange={(url) => {
              setAvatarUrl(url);
              setProfileChanged(true);
            }}
            disabled={!editable}
            disabledReason={lockedReason}
            onSaved={(saved) => {
              setProfile(saved);
              setProfileDirty(false);
              setProfileChanged(true);
            }}
          />

          <FeaturedProductsCard
            ids={featuredIds}
            products={knownProducts}
            disabled={!editable}
            searchProducts={searchProducts}
            onChange={onFeaturedChange}
          />

          <StorefrontCopilotPanel
            editorApi={editorApi}
            locale={locale}
            allowedImageOrigins={props.allowedImageOrigins}
            disabled={!editable || Boolean(props.copilotUnavailableReason)}
            disabledReason={props.copilotUnavailableReason ?? lockedReason}
            onApplyBio={onApplyBio}
            onBeforeInsert={flushDraft}
          />
        </div>
      </div>
    </div>
  );
}
