'use client';

import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Button, Input, Label, Textarea } from '@nextblock-cms/ui';
import {
  AFFILIATE_PROFILE_MIN_BIO_LENGTH,
  AFFILIATE_SOCIAL_NETWORKS,
  type AffiliateSocialLinks,
  type AffiliateSocialNetwork,
} from '@nextblock-cms/affiliates';

import { saveRetailerProfile } from '../actions';
import type { PortalCopyKey } from './portal-copy';
import { PORTAL_ACTION_ERROR_KEYS, portalUploadErrorKey } from './portal-messages';
import type { PortalLocale } from './portal-types';
import { PORTAL_UPLOAD_ACCEPT, uploadPortalImage } from './upload-client';
import { usePortalCopy } from './use-portal-copy';

export interface ProfileDraft {
  displayName: string;
  bio: string;
  socialLinks: AffiliateSocialLinks;
  preferredLocale: PortalLocale;
}

export const PROFILE_DISPLAY_NAME_MAX = 80;
export const PROFILE_BIO_MAX = 2000;

const SOCIAL_LABEL_KEYS: Readonly<Record<AffiliateSocialNetwork, PortalCopyKey>> = {
  website: 'affiliates.portal.social_website',
  instagram: 'affiliates.portal.social_instagram',
  tiktok: 'affiliates.portal.social_tiktok',
  youtube: 'affiliates.portal.social_youtube',
  x: 'affiliates.portal.social_x',
  facebook: 'affiliates.portal.social_facebook',
  pinterest: 'affiliates.portal.social_pinterest',
  linkedin: 'affiliates.portal.social_linkedin',
};

const SOCIAL_PLACEHOLDERS: Readonly<Record<AffiliateSocialNetwork, string>> = {
  website: 'https://',
  instagram: 'https://instagram.com/…',
  tiktok: 'https://tiktok.com/@…',
  youtube: 'https://youtube.com/@…',
  x: 'https://x.com/…',
  facebook: 'https://facebook.com/…',
  pinterest: 'https://pinterest.com/…',
  linkedin: 'https://linkedin.com/in/…',
};

type Message = { tone: 'info' | 'error'; text: string } | null;

export interface ProfileCardProps {
  value: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  dirty: boolean;
  avatarUrl: string | null;
  onAvatarChange: (url: string) => void;
  /** Read-only (suspended, or the storefront is in review). */
  disabled: boolean;
  disabledReason: string | null;
  onSaved: (profile: ProfileDraft, completed: boolean) => void;
}

/**
 * The partner's public profile: photo, display name, bio, social links and email language.
 * Saved explicitly (the server validates everything again); it goes live with the next approval.
 */
export function ProfileCard({ value, onChange, dirty, avatarUrl, onAvatarChange, disabled, disabledReason, onSaved }: ProfileCardProps) {
  const { t } = usePortalCopy();
  const id = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [avatarMessage, setAvatarMessage] = useState<Message>(null);
  const [invalidLinks, setInvalidLinks] = useState<AffiliateSocialNetwork[]>([]);

  const headingId = `${id}-heading`;
  const bioCount = value.bio.length;
  const bioShort = value.bio.trim().length < AFFILIATE_PROFILE_MIN_BIO_LENGTH;
  const initial = value.displayName.trim().charAt(0).toUpperCase() || '?';

  const update = (patch: Partial<ProfileDraft>) => onChange({ ...value, ...patch });
  const updateLink = (network: AffiliateSocialNetwork, url: string) => {
    setInvalidLinks((current) => current.filter((entry) => entry !== network));
    update({ socialLinks: { ...value.socialLinks, [network]: url } });
  };

  const save = async () => {
    if (disabled || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveRetailerProfile({
        displayName: value.displayName,
        bio: value.bio,
        socialLinks: Object.fromEntries(
          AFFILIATE_SOCIAL_NETWORKS.map((network) => [network, value.socialLinks[network] ?? '']),
        ),
        preferredLocale: value.preferredLocale,
      });
      if (result.ok) {
        setInvalidLinks([]);
        onSaved(result.profile, result.profileCompleted);
        setMessage({
          tone: 'info',
          text: result.profileCompleted ? t('affiliates.portal.profile_saved_completed') : t('affiliates.portal.profile_saved'),
        });
        return;
      }
      setInvalidLinks(result.error === 'invalid_social_links' ? (result.fields ?? []) : []);
      setMessage({ tone: 'error', text: t(PORTAL_ACTION_ERROR_KEYS[result.error]) });
    } catch {
      setMessage({ tone: 'error', text: t('affiliates.common.error_network') });
    } finally {
      setSaving(false);
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || disabled) return;
    setUploading(true);
    setAvatarMessage({ tone: 'info', text: t('affiliates.portal.avatar_uploading') });
    const result = await uploadPortalImage(file, 'avatar');
    setUploading(false);
    if (result.ok) {
      onAvatarChange(result.src);
      setAvatarMessage({ tone: 'info', text: t('affiliates.portal.avatar_uploaded') });
    } else {
      setAvatarMessage({ tone: 'error', text: t(portalUploadErrorKey(result.error, 'avatar')) });
    }
  };

  return (
    <section id="profile" aria-labelledby={headingId} className="scroll-mt-24 rounded-lg border border-border bg-card p-6 text-card-foreground">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('affiliates.portal.profile_title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('affiliates.portal.profile_description')}</p>
      {disabled && disabledReason ? <p className="mt-2 text-sm font-medium text-foreground">{disabledReason}</p> : null}

      <form
        className="mt-5 space-y-5"
        // The server validates every field (a link without https:// is accepted and normalized).
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={disabled} className="space-y-5">
          <div className="flex items-center gap-4">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- storage-hosted partner avatar (any configured media host)
              <img
                src={avatarUrl}
                alt={t('affiliates.portal.avatar_alt', { name: value.displayName || initial })}
                width={64}
                height={64}
                decoding="async"
                className="h-16 w-16 shrink-0 rounded-full border border-border object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xl font-semibold text-foreground"
              >
                {initial}
              </span>
            )}
            <div className="space-y-1">
              <Button type="button" variant="outline" disabled={disabled || uploading} onClick={() => fileRef.current?.click()}>
                {uploading
                  ? t('affiliates.portal.avatar_uploading')
                  : avatarUrl
                    ? t('affiliates.portal.avatar_change')
                    : t('affiliates.portal.avatar_upload')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('affiliates.portal.avatar_hint')}</p>
              <input
                ref={fileRef}
                type="file"
                accept={PORTAL_UPLOAD_ACCEPT}
                className="hidden"
                tabIndex={-1}
                aria-label={t('affiliates.portal.avatar_upload')}
                onChange={(event) => void onFile(event)}
              />
            </div>
          </div>
          <p role="status" aria-live="polite" className={avatarMessage?.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {avatarMessage?.text ?? ''}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>{t('affiliates.portal.profile_display_name')}</Label>
            <Input
              id={`${id}-name`}
              value={value.displayName}
              required
              maxLength={PROFILE_DISPLAY_NAME_MAX}
              autoComplete="nickname"
              onChange={(event) => update({ displayName: event.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-bio`}>{t('affiliates.portal.profile_bio')}</Label>
            <Textarea
              id={`${id}-bio`}
              value={value.bio}
              rows={6}
              maxLength={PROFILE_BIO_MAX}
              aria-describedby={`${id}-bio-hint ${id}-bio-count`}
              onChange={(event) => update({ bio: event.target.value })}
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <p id={`${id}-bio-hint`}>
                {bioShort
                  ? t('affiliates.portal.profile_bio_hint', { min: AFFILIATE_PROFILE_MIN_BIO_LENGTH })
                  : t('affiliates.portal.profile_bio_hint_ok')}
              </p>
              <p id={`${id}-bio-count`} className="tabular-nums">
                {t('affiliates.portal.character_count', { count: bioCount, max: PROFILE_BIO_MAX })}
              </p>
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t('affiliates.portal.profile_social_title')}</legend>
            <p className="text-xs text-muted-foreground">{t('affiliates.portal.profile_social_hint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {AFFILIATE_SOCIAL_NETWORKS.map((network) => {
                const invalid = invalidLinks.includes(network);
                const errorId = `${id}-social-${network}-error`;
                return (
                  <div key={network} className="space-y-1">
                    <Label htmlFor={`${id}-social-${network}`}>{t(SOCIAL_LABEL_KEYS[network])}</Label>
                    <Input
                      id={`${id}-social-${network}`}
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      spellCheck={false}
                      maxLength={300}
                      placeholder={SOCIAL_PLACEHOLDERS[network]}
                      value={value.socialLinks[network] ?? ''}
                      aria-invalid={invalid ? true : undefined}
                      aria-describedby={invalid ? errorId : undefined}
                      onChange={(event) => updateLink(network, event.target.value)}
                    />
                    {invalid ? (
                      <p id={errorId} className="text-xs text-destructive">
                        {t('affiliates.portal.profile_social_invalid')}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-locale`}>{t('affiliates.portal.profile_locale')}</Label>
            <select
              id={`${id}-locale`}
              value={value.preferredLocale}
              onChange={(event) => update({ preferredLocale: event.target.value === 'fr' ? 'fr' : 'en' })}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              aria-describedby={`${id}-locale-hint`}
            >
              <option value="en">{t('affiliates.portal.locale_en')}</option>
              <option value="fr">{t('affiliates.portal.locale_fr')}</option>
            </select>
            <p id={`${id}-locale-hint`} className="text-xs text-muted-foreground">
              {t('affiliates.portal.profile_locale_hint')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={disabled || saving || !value.displayName.trim()}>
              {saving ? t('affiliates.common.saving') : t('affiliates.portal.profile_save')}
            </Button>
            {dirty && !saving ? <span className="text-sm text-muted-foreground">{t('affiliates.portal.profile_unsaved')}</span> : null}
          </div>
        </fieldset>
        <p role="status" aria-live="polite" className={message?.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
          {message?.text ?? ''}
        </p>
      </form>
    </section>
  );
}
