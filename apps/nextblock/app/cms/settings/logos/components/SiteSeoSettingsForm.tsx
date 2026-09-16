'use client'

import { useState, useTransition } from 'react'
import { Button, Input, Label, Textarea } from '@nextblock-cms/ui'
import type { Database } from '@nextblock-cms/db'
import { ImageIcon, X as XIcon } from 'lucide-react'

import MediaPickerDialog from '../../../media/components/MediaPickerDialog'
import { resolveMediaUrl } from '../../../../../lib/media/resolveMediaUrl'
import { findOriginalUploadVariant, pickOriginalUploadObjectKey } from '../../../../../lib/media/original-upload'
import { saveSiteSeoSettings, type SiteSeoSettings, type SiteSocialImageSelection } from '../actions'

type Media = Database['public']['Tables']['media']['Row']

interface SiteSeoSettingsFormProps {
  initialSettings: SiteSeoSettings
}

const TITLE_RECOMMENDED_MAX = 60
const DESCRIPTION_RECOMMENDED_MAX = 160

/** Where the preview loads from: a hotlinked URL as-is, else the media host. */
function resolveSocialImageSrc(image: SiteSocialImageSelection | null) {
  if (!image) return null
  return image.url ?? resolveMediaUrl(image.objectKey)
}

export default function SiteSeoSettingsForm({ initialSettings }: SiteSeoSettingsFormProps) {
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [settings, setSettings] = useState<SiteSeoSettings>(() => ({
    siteTitle: initialSettings.siteTitle ?? '',
    siteDescription: initialSettings.siteDescription ?? '',
    siteKeywords: initialSettings.siteKeywords ?? '',
    socialImage: initialSettings.socialImage ?? null,
  }))

  const socialImageSrc = resolveSocialImageSrc(settings.socialImage)

  const handleSocialImageSelect = (media: Media) => {
    // Store the UNTOUCHED upload, not the row's AVIF derivative: this image exists
    // only to be fetched by social crawlers, and those do not decode AVIF. The
    // original keeps its own dimensions, so read those from the variant when it has
    // them. Rows with no original variant fall back to the row itself.
    const original = findOriginalUploadVariant(media)
    setSettings((current) => ({
      ...current,
      socialImage: {
        alt: media.description?.trim() || null,
        height: original?.height ?? media.height ?? null,
        mediaId: media.id,
        objectKey: pickOriginalUploadObjectKey(media),
        url: null,
        width: original?.width ?? media.width ?? null,
      },
    }))
  }

  const handleSave = () => {
    setMessage(null)
    startTransition(async () => {
      const result = await saveSiteSeoSettings(settings)

      if (result?.error) {
        setMessage({ type: 'error', text: result.error })
        return
      }

      setMessage({ type: 'success', text: 'Site SEO settings updated successfully.' })
    })
  }

  return (
    <div className="space-y-6 rounded-xl border bg-background p-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Site identity &amp; SEO</h2>
        <p className="text-sm text-muted-foreground">
          Used for the browser tab, search results, and social link previews (Open Graph / Twitter).
          The site title is also appended to every page title and shown next to the logo.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="seo-site-title">Site title</Label>
          <span
            className={`text-xs ${
              settings.siteTitle.length > TITLE_RECOMMENDED_MAX
                ? 'text-amber-600'
                : 'text-muted-foreground'
            }`}
          >
            {settings.siteTitle.length}/{TITLE_RECOMMENDED_MAX}
          </span>
        </div>
        <Input
          id="seo-site-title"
          placeholder="NextBlock™ CMS"
          value={settings.siteTitle}
          onChange={(event) =>
            setSettings((current) => ({ ...current, siteTitle: event.target.value }))
          }
        />
        <p className="text-xs text-muted-foreground">
          Example result: <span className="font-medium">Home | {settings.siteTitle || 'NextBlock™ CMS'}</span>
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="seo-site-description">Default meta description</Label>
          <span
            className={`text-xs ${
              settings.siteDescription.length > DESCRIPTION_RECOMMENDED_MAX
                ? 'text-amber-600'
                : 'text-muted-foreground'
            }`}
          >
            {settings.siteDescription.length}/{DESCRIPTION_RECOMMENDED_MAX}
          </span>
        </div>
        <Textarea
          id="seo-site-description"
          rows={3}
          placeholder="A short, compelling summary of your site for search engines and social cards."
          value={settings.siteDescription}
          onChange={(event) =>
            setSettings((current) => ({ ...current, siteDescription: event.target.value }))
          }
        />
        <p className="text-xs text-muted-foreground">
          Shown when a page has no description of its own. Aim for ~150–160 characters.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="seo-site-keywords">Default keywords</Label>
        <Input
          id="seo-site-keywords"
          placeholder="NextBlock, CMS, Next.js, Supabase"
          value={settings.siteKeywords}
          onChange={(event) =>
            setSettings((current) => ({ ...current, siteKeywords: event.target.value }))
          }
        />
        <p className="text-xs text-muted-foreground">Comma-separated. Used as the default meta keywords.</p>
      </div>

      <div className="space-y-2">
        <Label>Social preview image</Label>
        <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-start">
          {/* A 1.91:1 box, the crop social networks apply, so the preview is honest. */}
          <div className="relative aspect-[1200/630] w-full max-w-sm shrink-0 overflow-hidden rounded-md border bg-muted">
            {socialImageSrc ? (
              // Plain <img>: a Cortex-set image may be hotlinked from a host next/image is not configured for.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={socialImageSrc}
                alt={settings.socialImage?.alt ?? 'Social preview image'}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                <ImageIcon className="h-8 w-8" />
                <span className="text-xs">NextBlock banner (default)</span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 sm:flex-col">
            <MediaPickerDialog
              triggerLabel={socialImageSrc ? 'Change image' : 'Select from library'}
              onSelect={handleSocialImageSelect}
              accept={(m: Media) => !!m.file_type?.startsWith('image/')}
              title="Select or upload the social preview image"
              defaultFolder="branding/"
            />
            {settings.socialImage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSettings((current) => ({ ...current, socialImage: null }))}
              >
                <XIcon className="mr-1.5 h-3.5 w-3.5" />
                Remove
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Shown in link previews (Open Graph, X, LinkedIn, messaging apps) for every page, post or product
          that has no feature image of its own — the home page in particular, which should not carry a
          feature image. Use a wide image, ideally 1200×630 px. Without one, NextBlock&rsquo;s own banner
          is used.
        </p>
      </div>

      {message ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            message.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving...' : 'Save SEO Settings'}
        </Button>
      </div>
    </div>
  )
}
