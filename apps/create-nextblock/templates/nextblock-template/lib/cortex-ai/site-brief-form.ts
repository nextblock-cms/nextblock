import type { CortexSiteBrief, CortexSiteBriefInput } from '@nextblock-cms/cortex';

import { z } from '../zod-config';

/**
 * The site-brief FORM: the discovery questions the site builder used to ask in
 * chat, collected once in the setup wizard instead. This module is the shared
 * contract between the wizard step (UI) and the server action that persists the
 * answers as the Cortex site brief, so the chat's first turn is the plan rather
 * than a questionnaire.
 *
 * Pure: no server imports, safe to use from the client component for the schema
 * and the option lists.
 */

export const SITE_BRIEF_GOAL_OPTIONS = [
  { value: 'contact', label: 'Call or email us' },
  { value: 'book', label: 'Book an appointment' },
  { value: 'buy', label: 'Buy online' },
  { value: 'quote', label: 'Request a quote' },
  { value: 'read', label: 'Read our content' },
  { value: 'signup', label: 'Sign up or subscribe' },
] as const;

export const SITE_BRIEF_PAGE_OPTIONS = [
  { value: 'about', label: 'About' },
  { value: 'services', label: 'Services' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'contact', label: 'Contact' },
  { value: 'blog', label: 'Blog' },
  { value: 'shop', label: 'Shop' },
  { value: 'faq', label: 'FAQ' },
  { value: 'team', label: 'Team' },
] as const;

export const SITE_BRIEF_TONE_OPTIONS = ['friendly', 'professional', 'playful', 'luxury', 'minimal', 'bold'] as const;

export const SITE_BRIEF_SITE_TYPES = ['landing-page', 'multi-page', 'blog', 'store', 'portfolio'] as const;

/** Custom pages travel through the form as `custom:<Title>`; home is implicit. */
export const SITE_BRIEF_CUSTOM_PAGE_PREFIX = 'custom:';

/** Limits of the STORED brief (`cortexSiteBriefSchema`) that the form must respect. */
export const SITE_BRIEF_NOTES_MAX_LENGTH = 4000;
const SITE_BRIEF_PAGE_TITLE_MAX_LENGTH = 200;

export type SiteBriefSiteType = (typeof SITE_BRIEF_SITE_TYPES)[number];

export type SiteBriefFormValues = {
  business_name: string;
  tagline?: string;
  description: string;
  audience?: string;
  goals: string[];
  site_type: SiteBriefSiteType;
  pages: string[];
  languages: string[];
  primary_language: string;
  brand: {
    color_mode: 'auto' | 'custom';
    primary_color?: string;
    secondary_color?: string;
    color_scheme: 'light' | 'dark';
    tone?: string;
    logo: 'later' | 'none' | 'have';
  };
  contact: {
    email?: string;
    phone?: string;
    address?: string;
    hours?: string;
    social: Array<{ platform: string; url: string }>;
  };
  keep_existing_content: boolean;
  reference_url?: string;
  sells_online: boolean;
  notes?: string;
};

type ActiveLanguage = { code: string; name: string; isDefault: boolean };

const LOGO_NOTES: Record<SiteBriefFormValues['brand']['logo'], string> = {
  have: 'Client has a logo and will upload it',
  later: 'Client will upload a logo later; use a text logo meanwhile',
  none: 'No logo; design a clean text logo',
};

const REFERENCE_NOTE_PREFIX = 'Reference site: ';

/**
 * The stored `notes` field: the free-text notes plus the reference link on its own
 * line. One function so the form's client-side check, the schema and the mapping
 * agree on the exact length the stored brief will see.
 */
export function buildSiteBriefNotes(values: Pick<SiteBriefFormValues, 'notes' | 'reference_url'>): string | undefined {
  const reference = values.reference_url?.trim();
  const parts = [values.notes?.trim() || null, reference ? `${REFERENCE_NOTE_PREFIX}${reference}` : null].filter(
    (part): part is string => Boolean(part)
  );

  return parts.length > 0 ? parts.join('\n') : undefined;
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/** An optional free-text field: trimmed, and an empty string counts as "not given". */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(isHttpUrl, { message: 'Enter a full web address starting with http:// or https://.' });

const optionalHttpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .transform((value) => (value ? value : undefined))
  .refine((value) => value === undefined || isHttpUrl(value), {
    message: 'Enter a full web address starting with http:// or https://.',
  });

const localeCodeSchema = z.string().trim().min(2).max(10);

export const siteBriefFormSchema: z.ZodType<SiteBriefFormValues, unknown> = z
  .object({
    business_name: z.string().trim().min(1, 'Tell us the name of the business or project.').max(160),
    tagline: optionalText(200),
    description: z.string().trim().min(1, 'Describe what the business does.').max(3000),
    audience: optionalText(1000),
    goals: z.array(z.string().trim().min(1).max(300)).max(10),
    site_type: z.enum(SITE_BRIEF_SITE_TYPES),
    pages: z.array(z.string().trim().min(1).max(SITE_BRIEF_CUSTOM_PAGE_PREFIX.length + SITE_BRIEF_PAGE_TITLE_MAX_LENGTH)).max(30),
    languages: z.array(localeCodeSchema).min(1, 'Pick at least one language.').max(10),
    primary_language: localeCodeSchema,
    brand: z.object({
      color_mode: z.enum(['auto', 'custom']),
      primary_color: optionalText(40),
      secondary_color: optionalText(40),
      color_scheme: z.enum(['light', 'dark']),
      tone: optionalText(200),
      logo: z.enum(['later', 'none', 'have']),
    }),
    contact: z.object({
      email: optionalText(200),
      phone: optionalText(60),
      address: optionalText(400),
      hours: optionalText(400),
      social: z
        .array(
          z.object({
            platform: z.string().trim().min(1, 'Name the platform.').max(60),
            url: httpUrlSchema,
          })
        )
        .max(12),
    }),
    keep_existing_content: z.boolean(),
    reference_url: optionalHttpUrlSchema,
    sells_online: z.boolean(),
    notes: optionalText(SITE_BRIEF_NOTES_MAX_LENGTH),
  })
  .superRefine((values, ctx) => {
    if (!values.languages.includes(values.primary_language)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The primary language must be one of the languages the site offers.',
        path: ['primary_language'],
      });
    }

    // The reference link is appended to the notes when stored; together they must
    // fit the stored field, or the save would fail after validation with no field.
    if ((buildSiteBriefNotes(values)?.length ?? 0) > SITE_BRIEF_NOTES_MAX_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: `Notes plus the reference link must stay under ${SITE_BRIEF_NOTES_MAX_LENGTH} characters.`,
        path: ['notes'],
      });
    }
  });

/* -------------------------------------------------------------------------- */
/* Mapping: form → brief                                                       */
/* -------------------------------------------------------------------------- */

export function slugifySiteBriefPageTitle(title: string) {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function goalLabel(value: string) {
  return SITE_BRIEF_GOAL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/**
 * `position` is the page's 1-based place in the brief, the fallback slug for a title
 * with no Latin letters or digits ("メニュー", "Меню"): such a page is kept under
 * `page-N` rather than silently dropped while its chip stays selected in the form.
 */
function pageEntry(value: string, position: number): { slug: string; title: string } | null {
  const known = SITE_BRIEF_PAGE_OPTIONS.find((option) => option.value === value);
  if (known) {
    return { slug: known.value, title: known.label };
  }

  if (value.startsWith(SITE_BRIEF_CUSTOM_PAGE_PREFIX)) {
    const title = value.slice(SITE_BRIEF_CUSTOM_PAGE_PREFIX.length).trim().slice(0, SITE_BRIEF_PAGE_TITLE_MAX_LENGTH);
    if (!title) return null;
    return { slug: slugifySiteBriefPageTitle(title) || `page-${position}`, title };
  }

  return null;
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

type SiteBriefPage = CortexSiteBrief['pages'][number];

/**
 * Pure mapping of the form answers onto the stored brief shape (mode "replace").
 *
 * The form is the source of truth for every field it has an input for, including
 * their absence (switching colours back to "pick for me" really clears them). The
 * fields it cannot show — a page's planned `sections` and `purpose`, the brand's
 * `accent_color`, `font_style` and `style_keywords`, the ecommerce `products_summary`,
 * and the brief `status` — are carried over from `existing` when given, so editing a
 * phone number after a chat interview or a finished build does not throw away what
 * the model collected, nor flip a "built" brief back to "draft".
 */
export function siteBriefFormToBrief(
  values: SiteBriefFormValues,
  existing: CortexSiteBrief | null = null
): CortexSiteBriefInput {
  const existingPages = new Map((existing?.pages ?? []).map((page) => [page.slug, page]));
  const withExistingPage = (page: { slug: string; title: string }): SiteBriefPage => {
    const previous = existingPages.get(page.slug);
    return compact({ ...page, purpose: previous?.purpose, sections: previous?.sections });
  };

  const pages: SiteBriefPage[] = [withExistingPage({ slug: 'home', title: 'Home' })];
  if (values.site_type !== 'landing-page') {
    const seen = new Set(['home']);
    for (const value of values.pages) {
      const entry = pageEntry(value, pages.length + 1);
      if (entry && !seen.has(entry.slug)) {
        seen.add(entry.slug);
        pages.push(withExistingPage(entry));
      }
    }
  }

  const brand = compact({
    accent_color: existing?.brand?.accent_color,
    color_scheme: values.brand.color_scheme,
    font_style: existing?.brand?.font_style,
    logo_notes: LOGO_NOTES[values.brand.logo],
    primary_color: values.brand.color_mode === 'custom' ? values.brand.primary_color : undefined,
    secondary_color: values.brand.color_mode === 'custom' ? values.brand.secondary_color : undefined,
    style_keywords: existing?.brand?.style_keywords,
    tone: values.brand.tone,
  });

  const contact = compact({
    address: values.contact.address,
    email: values.contact.email,
    hours: values.contact.hours,
    phone: values.contact.phone,
    social: values.contact.social.length > 0 ? values.contact.social.map((entry) => ({ ...entry })) : undefined,
  });

  return compact({
    audience: values.audience,
    brand,
    business_name: values.business_name,
    contact,
    description: values.description,
    ecommerce: compact({ enabled: values.sells_online, products_summary: existing?.ecommerce?.products_summary }),
    goals: values.goals.map(goalLabel),
    keep_existing_content: values.keep_existing_content,
    languages: [...values.languages],
    notes: buildSiteBriefNotes(values),
    pages,
    primary_language: values.primary_language,
    site_type: values.site_type,
    status: existing?.status ?? 'draft',
    tagline: values.tagline,
  });
}

/* -------------------------------------------------------------------------- */
/* Mapping: brief → form (prefill)                                             */
/* -------------------------------------------------------------------------- */

function goalValue(label: string) {
  const normalized = label.trim().toLowerCase();
  return (
    SITE_BRIEF_GOAL_OPTIONS.find(
      (option) => option.label.toLowerCase() === normalized || option.value === normalized
    )?.value ?? label
  );
}

function pageValue(page: { slug: string; title: string }): string | null {
  if (page.slug === 'home') return null;
  const known = SITE_BRIEF_PAGE_OPTIONS.find((option) => option.value === page.slug);
  return known ? known.value : `${SITE_BRIEF_CUSTOM_PAGE_PREFIX}${page.title}`;
}

function logoChoice(notes: string | undefined): SiteBriefFormValues['brand']['logo'] {
  if (!notes) return 'later';
  const normalized = notes.toLowerCase();
  if (normalized === LOGO_NOTES.none.toLowerCase() || /\bno logo\b/.test(normalized)) return 'none';
  if (normalized === LOGO_NOTES.have.toLowerCase() || /\bhas a logo\b/.test(normalized)) return 'have';
  return 'later';
}

function splitNotes(notes: string | undefined): { notes?: string; reference_url?: string } {
  if (!notes) return {};
  const lines = notes.split('\n');
  const referenceLine = lines.find((line) => line.startsWith(REFERENCE_NOTE_PREFIX));
  const rest = lines.filter((line) => line !== referenceLine).join('\n').trim();
  const reference = referenceLine?.slice(REFERENCE_NOTE_PREFIX.length).trim();

  return {
    notes: rest || undefined,
    reference_url: reference && isHttpUrl(reference) ? reference : undefined,
  };
}

/**
 * Default answers for the form, with whatever a previously saved brief (from an
 * earlier form save or a chat interview) can be mapped back onto it.
 */
export function briefToSiteBriefFormValues(
  brief: CortexSiteBrief | null,
  activeLanguages: ActiveLanguage[]
): SiteBriefFormValues {
  const activeCodes = activeLanguages.map((language) => language.code);
  const defaultLanguage =
    activeLanguages.find((language) => language.isDefault)?.code ?? activeCodes[0] ?? 'en';

  const defaults: SiteBriefFormValues = {
    business_name: '',
    description: '',
    goals: [],
    site_type: 'multi-page',
    pages: ['about', 'services', 'contact'],
    languages: activeCodes.length > 0 ? activeCodes : [defaultLanguage],
    primary_language: defaultLanguage,
    brand: { color_mode: 'auto', color_scheme: 'light', logo: 'later' },
    contact: { social: [] },
    keep_existing_content: false,
    sells_online: false,
  };

  if (!brief) {
    return defaults;
  }

  const languages = activeCodes.length > 0
    ? brief.languages.filter((code) => activeCodes.includes(code))
    : brief.languages;
  const resolvedLanguages = languages.length > 0 ? languages : defaults.languages;
  const primaryLanguage = resolvedLanguages.includes(brief.primary_language)
    ? brief.primary_language
    : resolvedLanguages.includes(defaultLanguage)
      ? defaultLanguage
      : resolvedLanguages[0];

  const siteType: SiteBriefSiteType =
    brief.site_type === 'other' ? 'multi-page' : brief.site_type;
  const pages = brief.pages
    .map(pageValue)
    .filter((value): value is string => Boolean(value));

  const hasCustomColors = Boolean(brief.brand?.primary_color || brief.brand?.secondary_color);
  const { notes, reference_url } = splitNotes(brief.notes);

  return compact({
    business_name: brief.business_name,
    tagline: brief.tagline,
    description: brief.description ?? '',
    audience: brief.audience,
    goals: (brief.goals ?? []).map(goalValue),
    site_type: siteType,
    pages: siteType === 'landing-page' ? [] : brief.pages.length > 0 ? pages : defaults.pages,
    languages: resolvedLanguages,
    primary_language: primaryLanguage,
    brand: compact({
      color_mode: hasCustomColors ? 'custom' : 'auto',
      primary_color: brief.brand?.primary_color,
      secondary_color: brief.brand?.secondary_color,
      color_scheme: brief.brand?.color_scheme ?? 'light',
      tone: brief.brand?.tone,
      logo: logoChoice(brief.brand?.logo_notes),
    }),
    contact: compact({
      email: brief.contact?.email,
      phone: brief.contact?.phone,
      address: brief.contact?.address,
      hours: brief.contact?.hours,
      social: (brief.contact?.social ?? []).map((entry) => ({ platform: entry.platform, url: entry.url })),
    }),
    keep_existing_content: brief.keep_existing_content,
    reference_url,
    sells_online: brief.ecommerce?.enabled ?? false,
    notes,
  });
}
