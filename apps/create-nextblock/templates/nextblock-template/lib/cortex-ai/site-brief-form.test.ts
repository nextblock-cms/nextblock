import { describe, expect, it } from 'vitest';

import type { CortexSiteBrief } from '@nextblock-cms/cortex';

import {
  briefToSiteBriefFormValues,
  siteBriefFormSchema,
  siteBriefFormToBrief,
  slugifySiteBriefPageTitle,
  type SiteBriefFormValues,
} from './site-brief-form';

const activeLanguages = [
  { code: 'en', name: 'English', isDefault: true },
  { code: 'fr', name: 'Français', isDefault: false },
];

function validValues(overrides: Partial<SiteBriefFormValues> = {}): SiteBriefFormValues {
  return {
    business_name: 'Maple Dental',
    tagline: 'Gentle care for the whole family',
    description: 'A family dental clinic in Ottawa.',
    audience: 'Families in the west end',
    goals: ['book', 'Ask about insurance coverage'],
    site_type: 'multi-page',
    pages: ['about', 'services', 'contact', 'custom:Our Clinic Tour', 'custom:  Émergences & Urgences  '],
    languages: ['en', 'fr'],
    primary_language: 'en',
    brand: {
      color_mode: 'custom',
      primary_color: '#1e6f5c',
      secondary_color: '#f4f1ea',
      color_scheme: 'light',
      tone: 'friendly',
      logo: 'have',
    },
    contact: {
      email: 'hello@mapledental.ca',
      phone: '613-555-0100',
      address: '12 Maple St, Ottawa',
      hours: 'Mon–Fri 8–5',
      social: [{ platform: 'Instagram', url: 'https://instagram.com/mapledental' }],
    },
    keep_existing_content: false,
    reference_url: 'https://example.com',
    sells_online: false,
    notes: 'Open Saturdays in summer.',
    ...overrides,
  };
}

describe('siteBriefFormSchema', () => {
  it('accepts a complete form and trims / drops empty optional strings', () => {
    const parsed = siteBriefFormSchema.safeParse({
      ...validValues(),
      business_name: '  Maple Dental  ',
      tagline: '   ',
      audience: '',
      brand: { ...validValues().brand, tone: '' },
      reference_url: '',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.business_name).toBe('Maple Dental');
    expect(parsed.data.tagline).toBeUndefined();
    expect(parsed.data.audience).toBeUndefined();
    expect(parsed.data.brand.tone).toBeUndefined();
    expect(parsed.data.reference_url).toBeUndefined();
  });

  it('requires a business name and a description', () => {
    const parsed = siteBriefFormSchema.safeParse(validValues({ business_name: '  ', description: '' }));

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('business_name');
    expect(paths).toContain('description');
  });

  it('requires the primary language to be one of the offered languages', () => {
    const parsed = siteBriefFormSchema.safeParse(validValues({ languages: ['fr'], primary_language: 'en' }));

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('primary_language');
    expect(siteBriefFormSchema.safeParse(validValues({ languages: [], primary_language: 'en' })).success).toBe(false);
  });

  it('validates URL shape for the reference site and the social links', () => {
    expect(siteBriefFormSchema.safeParse(validValues({ reference_url: 'example.com' })).success).toBe(false);
    expect(siteBriefFormSchema.safeParse(validValues({ reference_url: 'ftp://example.com' })).success).toBe(false);
    expect(siteBriefFormSchema.safeParse(validValues({ reference_url: 'http://example.com/path?x=1' })).success).toBe(true);

    const badSocial = siteBriefFormSchema.safeParse(
      validValues({ contact: { social: [{ platform: 'X', url: 'not a url' }] } })
    );
    expect(badSocial.success).toBe(false);
    if (badSocial.success) return;
    expect(badSocial.error.issues[0]?.path.join('.')).toBe('contact.social.0.url');
  });

  it('rejects unknown site types and over-long lists', () => {
    expect(siteBriefFormSchema.safeParse({ ...validValues(), site_type: 'other' }).success).toBe(false);
    expect(
      siteBriefFormSchema.safeParse(validValues({ goals: Array.from({ length: 11 }, (_, i) => `goal ${i}`) })).success
    ).toBe(false);
    // A custom page title is capped where the stored brief caps it (200), prefix included.
    expect(siteBriefFormSchema.safeParse(validValues({ pages: [`custom:${'x'.repeat(200)}`] })).success).toBe(true);
    expect(siteBriefFormSchema.safeParse(validValues({ pages: [`custom:${'x'.repeat(201)}`] })).success).toBe(false);
  });

  it('caps the notes together with the reference link, which is appended to them when stored', () => {
    const notes = 'n'.repeat(3990);
    const alone = siteBriefFormSchema.safeParse(validValues({ notes, reference_url: undefined }));
    expect(alone.success).toBe(true);

    const combined = siteBriefFormSchema.safeParse(validValues({ notes, reference_url: 'https://example.com/a-long-path' }));
    expect(combined.success).toBe(false);
    if (combined.success) return;
    expect(combined.error.issues.map((issue) => issue.path.join('.'))).toEqual(['notes']);
  });
});

describe('slugifySiteBriefPageTitle', () => {
  it('lowercases, strips accents, and collapses separators', () => {
    expect(slugifySiteBriefPageTitle('Our Clinic Tour')).toBe('our-clinic-tour');
    expect(slugifySiteBriefPageTitle('  Émergences & Urgences  ')).toBe('emergences-urgences');
    expect(slugifySiteBriefPageTitle('---')).toBe('');
  });
});

describe('siteBriefFormToBrief', () => {
  it('maps every form field onto the stored brief shape', () => {
    const brief = siteBriefFormToBrief(validValues());

    expect(brief).toEqual({
      audience: 'Families in the west end',
      brand: {
        color_scheme: 'light',
        logo_notes: 'Client has a logo and will upload it',
        primary_color: '#1e6f5c',
        secondary_color: '#f4f1ea',
        tone: 'friendly',
      },
      business_name: 'Maple Dental',
      contact: {
        address: '12 Maple St, Ottawa',
        email: 'hello@mapledental.ca',
        hours: 'Mon–Fri 8–5',
        phone: '613-555-0100',
        social: [{ platform: 'Instagram', url: 'https://instagram.com/mapledental' }],
      },
      description: 'A family dental clinic in Ottawa.',
      ecommerce: { enabled: false },
      goals: ['Book an appointment', 'Ask about insurance coverage'],
      keep_existing_content: false,
      languages: ['en', 'fr'],
      notes: 'Open Saturdays in summer.\nReference site: https://example.com',
      pages: [
        { slug: 'home', title: 'Home' },
        { slug: 'about', title: 'About' },
        { slug: 'services', title: 'Services' },
        { slug: 'contact', title: 'Contact' },
        { slug: 'our-clinic-tour', title: 'Our Clinic Tour' },
        { slug: 'emergences-urgences', title: 'Émergences & Urgences' },
      ],
      primary_language: 'en',
      site_type: 'multi-page',
      status: 'draft',
      tagline: 'Gentle care for the whole family',
    });
  });

  it('keeps only the home page for a landing page and drops custom colours in auto mode', () => {
    const brief = siteBriefFormToBrief(
      validValues({
        site_type: 'landing-page',
        brand: { color_mode: 'auto', primary_color: '#000', color_scheme: 'dark', logo: 'none' },
        contact: { social: [] },
        notes: undefined,
        reference_url: undefined,
        sells_online: true,
      })
    );

    expect(brief.pages).toEqual([{ slug: 'home', title: 'Home' }]);
    expect(brief.brand).toEqual({ color_scheme: 'dark', logo_notes: 'No logo; design a clean text logo' });
    expect(brief.contact).toEqual({});
    expect(brief.notes).toBeUndefined();
    expect(brief.ecommerce).toEqual({ enabled: true });
  });

  it('uses the logo notes for "later", ignores a duplicated custom page, and keeps a non-Latin title under a positional slug', () => {
    const brief = siteBriefFormToBrief(
      validValues({
        brand: { color_mode: 'auto', color_scheme: 'light', logo: 'later' },
        pages: ['about', 'custom:About', 'custom:メニュー', 'custom:Home', 'custom:   '],
      })
    );

    expect(brief.brand?.logo_notes).toBe('Client will upload a logo later; use a text logo meanwhile');
    expect(brief.pages).toEqual([
      { slug: 'home', title: 'Home' },
      { slug: 'about', title: 'About' },
      { slug: 'page-3', title: 'メニュー' },
    ]);
  });

  it('carries over what the form cannot show from the existing brief, and keeps its status', () => {
    const existing: CortexSiteBrief = {
      business_name: 'Old name',
      brand: { accent_color: '#ff0', font_style: 'elegant serif', primary_color: '#000', style_keywords: ['warm'] },
      ecommerce: { enabled: true, products_summary: 'Bread and pastries' },
      keep_existing_content: false,
      languages: ['en'],
      pages: [
        { slug: 'home', title: 'Home', purpose: 'Hook visitors', sections: ['hero', 'services'] },
        { slug: 'about', title: 'About', sections: ['story', 'team'] },
        { slug: 'menu', title: 'Menu', purpose: 'List the menu' },
      ],
      primary_language: 'en',
      site_type: 'multi-page',
      status: 'built',
    };

    const brief = siteBriefFormToBrief(
      validValues({ brand: { color_mode: 'auto', color_scheme: 'dark', logo: 'none' }, pages: ['about', 'contact'] }),
      existing
    );

    // Form fields win, including their absence: auto colours really clear the primary colour.
    expect(brief.business_name).toBe('Maple Dental');
    expect(brief.brand).toEqual({
      accent_color: '#ff0',
      color_scheme: 'dark',
      font_style: 'elegant serif',
      logo_notes: 'No logo; design a clean text logo',
      style_keywords: ['warm'],
    });
    expect(brief.ecommerce).toEqual({ enabled: false, products_summary: 'Bread and pastries' });
    expect(brief.pages).toEqual([
      { slug: 'home', title: 'Home', purpose: 'Hook visitors', sections: ['hero', 'services'] },
      { slug: 'about', title: 'About', sections: ['story', 'team'] },
      { slug: 'contact', title: 'Contact' },
    ]);
    expect(brief.status).toBe('built');
    expect(siteBriefFormToBrief(validValues()).status).toBe('draft');
  });
});

describe('briefToSiteBriefFormValues', () => {
  it('returns sensible defaults without a brief', () => {
    expect(briefToSiteBriefFormValues(null, activeLanguages)).toEqual({
      business_name: '',
      description: '',
      goals: [],
      site_type: 'multi-page',
      pages: ['about', 'services', 'contact'],
      languages: ['en', 'fr'],
      primary_language: 'en',
      brand: { color_mode: 'auto', color_scheme: 'light', logo: 'later' },
      contact: { social: [] },
      keep_existing_content: false,
      sells_online: false,
    });
    expect(briefToSiteBriefFormValues(null, []).languages).toEqual(['en']);
  });

  it('round-trips a form-saved brief', () => {
    const values = validValues();
    const stored: CortexSiteBrief = {
      ...(siteBriefFormToBrief(values) as CortexSiteBrief),
      languages: ['en', 'fr'],
      pages: siteBriefFormToBrief(values).pages ?? [],
      primary_language: 'en',
      site_type: 'multi-page',
      status: 'draft',
      keep_existing_content: false,
      updated_at: '2026-09-15T00:00:00.000Z',
    };

    expect(briefToSiteBriefFormValues(stored, activeLanguages)).toEqual({
      ...values,
      pages: ['about', 'services', 'contact', 'custom:Our Clinic Tour', 'custom:Émergences & Urgences'],
    });
  });

  it('maps a chat-interview brief back as far as it can', () => {
    const stored: CortexSiteBrief = {
      business_name: 'Studio Nord',
      brand: { logo_notes: 'They have no logo yet', accent_color: '#fff' },
      goals: ['get quote requests'],
      keep_existing_content: true,
      languages: ['de', 'fr'],
      pages: [{ slug: 'home', title: 'Home' }, { slug: 'portfolio', title: 'Work' }],
      primary_language: 'de',
      site_type: 'other',
      status: 'confirmed',
      notes: 'Reference site: https://ref.example\nLikes big photos.',
    };

    const values = briefToSiteBriefFormValues(stored, activeLanguages);

    expect(values.business_name).toBe('Studio Nord');
    expect(values.description).toBe('');
    expect(values.goals).toEqual(['get quote requests']);
    expect(values.site_type).toBe('multi-page');
    expect(values.pages).toEqual(['custom:Work']);
    expect(values.languages).toEqual(['fr']);
    expect(values.primary_language).toBe('fr');
    expect(values.brand).toEqual({ color_mode: 'auto', color_scheme: 'light', logo: 'none' });
    expect(values.keep_existing_content).toBe(true);
    expect(values.reference_url).toBe('https://ref.example');
    expect(values.notes).toBe('Likes big photos.');

    // The only thing the operator still has to type is the missing description.
    const incomplete = siteBriefFormSchema.safeParse(values);
    expect(incomplete.success).toBe(false);
    if (!incomplete.success) {
      expect(incomplete.error.issues.map((issue) => issue.path.join('.'))).toEqual(['description']);
    }
    expect(siteBriefFormSchema.safeParse({ ...values, description: 'A design studio.' }).success).toBe(true);
  });
});
