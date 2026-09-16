'use server'

import { createClient } from '@nextblock-cms/db/server'
import { INVOICE_SETTINGS_KEY, serializeInvoiceSettings, type InvoiceSettings } from '@nextblock-cms/ecommerce'
import { parseSiteSocialImageSetting, SITE_SOCIAL_IMAGE_SETTING_KEY } from '@nextblock-cms/utils/seo'
import { revalidatePath, updateTag } from 'next/cache'
import { redirect } from 'next/navigation'
import type { Logo } from './types'
import { SITE_SETTINGS_CACHE_TAG } from '../../../lib/site-settings'
import {
  ACTIVE_LOGO_SETTING_KEY,
  resolveActiveLogo,
  resolveActiveLogoId,
} from '../../../../lib/logos/active-logo'

const PUBLIC_LAYOUT_LOGO_CACHE_TAG = 'public-layout-logo'

function revalidateLogoViews() {
  revalidatePath('/cms/settings/logos')
  updateTag(PUBLIC_LAYOUT_LOGO_CACHE_TAG)
}

export async function createLogo(payload: {
  name: string
  media_id: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient()

  const { error } = await supabase.from('logos').insert(payload)

  if (error) {
    console.error('Error creating logo:', error)
    return { success: false, error: error.message }
  }

  revalidateLogoViews()
  return { success: true }
}

export async function updateLogo(payload: {
  id: string
  name: string
  media_id: string
}) {
  const supabase = createClient()
  const { id, ...data } = payload

  const { error } = await supabase.from('logos').update(data).eq('id', id)

  if (error) {
    console.error('Error updating logo:', error)
    // Optionally, handle the error more gracefully
    // redirect('/error?message=Could not update logo')
    return
  }

  revalidateLogoViews()
  revalidatePath(`/cms/settings/logos/${id}/edit`)
  redirect('/cms/settings/logos')
}

export async function deleteLogo(id: string) {
  const supabase = createClient()

  const { error } = await supabase.from('logos').delete().eq('id', id)

  if (error) {
    console.error('Error deleting logo:', error)
    return { success: false, error: error.message }
  }

  revalidateLogoViews()
  return { success: true }
}

export async function getLogos() {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('logos')
    .select('*, media:media_id(*)')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error fetching logos:', error.message)
    throw new Error(`Failed to fetch logos: ${error.message}`)
  }

  return data as unknown as Logo[]
}

export async function getLogoById(id: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('logos')
    .select('*, media:media_id(*)')
    .eq('id', id)
    .single()

  if (error) {
    console.error(`Error fetching logo by id ${id}:`, error.message)
    return null
  }

  return data
}

export async function getActiveLogo(): Promise<Logo | null> {
  const supabase = createClient()
  return (await resolveActiveLogo(supabase)) as Logo | null
}

/** The admin-pinned active logo id (site_settings.active_logo_id), or null when unset. */
export async function getActiveLogoId(): Promise<string | null> {
  const supabase = createClient()
  return resolveActiveLogoId(supabase)
}

/**
 * Pin which logo is active across the storefront, invoices, and transactional emails.
 * Persists the choice as site_settings.active_logo_id (RLS restricts writes to ADMIN/WRITER)
 * and busts the public header + CMS caches so the change shows immediately.
 */
export async function setActiveLogo(
  logoId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient()
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: ACTIVE_LOGO_SETTING_KEY, value: logoId })

  if (error) {
    console.error('Error setting active logo:', error.message)
    return { success: false, error: error.message }
  }

  revalidateLogoViews()
  return { success: true }
}

export async function saveInvoiceSettings(payload: InvoiceSettings) {
  const supabase = createClient()
  const { error } = await supabase.from('site_settings').upsert({
    key: INVOICE_SETTINGS_KEY,
    value: serializeInvoiceSettings(payload),
  })

  if (error) {
    console.error('Error saving invoice settings:', error.message)
    return { success: false, error: error.message }
  }

  revalidatePath('/cms/settings/logos')
  return { success: true }
}

/**
 * The site-wide social preview image as the Branding form handles it: a media
 * library pick (`mediaId` + `objectKey`) or, when Cortex stored a hotlinked photo,
 * a bare `url`. Null means "use NextBlock's bundled banner".
 */
export interface SiteSocialImageSelection {
  mediaId: string | null
  objectKey: string | null
  url: string | null
  width: number | null
  height: number | null
  alt: string | null
}

export interface SiteSeoSettings {
  siteTitle: string
  siteDescription: string
  siteKeywords: string
  socialImage: SiteSocialImageSelection | null
}

export async function getSiteSeoSettings(): Promise<SiteSeoSettings> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', ['site_title', 'site_description', 'site_keywords', SITE_SOCIAL_IMAGE_SETTING_KEY])

  const settings: Record<string, string> = {}
  let socialImageValue: unknown = null
  if (!error && data) {
    data.forEach((item) => {
      if (item.key === SITE_SOCIAL_IMAGE_SETTING_KEY) {
        socialImageValue = item.value
      } else if (typeof item.value === 'string') {
        settings[item.key] = item.value
      }
    })
  }

  const socialImage = parseSiteSocialImageSetting(socialImageValue)

  return {
    siteTitle: settings.site_title ?? '',
    siteDescription: settings.site_description ?? '',
    siteKeywords: settings.site_keywords ?? '',
    socialImage: socialImage
      ? {
          alt: socialImage.alt,
          height: socialImage.height,
          mediaId: socialImage.media_id,
          objectKey: socialImage.object_key,
          url: socialImage.url,
          width: socialImage.width,
        }
      : null,
  }
}

export async function saveSiteSeoSettings(payload: SiteSeoSettings) {
  const supabase = createClient()
  const socialImage = payload.socialImage

  const { error } = await supabase.from('site_settings').upsert([
    { key: 'site_title', value: payload.siteTitle.trim() },
    { key: 'site_description', value: payload.siteDescription.trim() },
    { key: 'site_keywords', value: payload.siteKeywords.trim() },
    // Same shape Cortex's update_site_identity writes and getSiteSettings reads
    // (parseSiteSocialImageSetting); null clears the image.
    {
      key: SITE_SOCIAL_IMAGE_SETTING_KEY,
      value:
        socialImage && (socialImage.objectKey || socialImage.url)
          ? {
              alt: socialImage.alt,
              height: socialImage.height,
              media_id: socialImage.mediaId,
              object_key: socialImage.objectKey,
              url: socialImage.url,
              width: socialImage.width,
            }
          : null,
    },
  ])

  if (error) {
    console.error('Error saving site SEO settings:', error.message)
    return { success: false, error: error.message }
  }

  // Bust the cached public site settings (title/description/keywords) and the
  // root layout so metadata + header brand update immediately.
  updateTag(SITE_SETTINGS_CACHE_TAG)
  revalidatePath('/cms/settings/logos')
  revalidatePath('/', 'layout')
  return { success: true }
}
