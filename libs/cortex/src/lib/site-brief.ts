import { z } from './zod-config';

/**
 * The site brief: what the client wants their website to be.
 *
 * Cortex fills this in during the site-builder interview and persists it in
 * `site_settings` so that every later conversation — dashboard chat, MCP client,
 * a follow-up "make the whole site feel warmer" prompt weeks later — starts from
 * the same understanding of the business instead of re-asking. It is plain,
 * non-secret JSON: readable by any admin session and by every tool context.
 */
export const CORTEX_AI_SITE_BRIEF_SETTING_KEY = 'cortex_ai_site_brief';

/**
 * A time-boxed authorisation for Cortex to apply an approved build plan without a
 * confirmation click per tool call. Written only by `start_site_build` after the
 * operator confirms the plan; the chat route honours it for the actor who opened it
 * and only until `expiresAt`.
 */
export const CORTEX_AI_BUILD_SESSION_SETTING_KEY = 'cortex_ai_build_session';

const localeCodeSchema = z.string().trim().min(2).max(10);

const siteBriefPageSchema = z.strictObject({
  purpose: z
    .string()
    .trim()
    .max(600)
    .optional()
    .describe('What this page is for and what a visitor should do there.'),
  sections: z
    .array(z.string().trim().min(1).max(200))
    .max(20)
    .optional()
    .describe('Planned sections, top to bottom, e.g. ["hero", "services", "testimonials", "contact form"].'),
  slug: z.string().trim().min(1).max(120).describe('URL slug in the primary language, e.g. "home", "services", "contact".'),
  title: z.string().trim().min(1).max(200),
});

const siteBriefBrandSchema = z
  .strictObject({
    accent_color: z.string().trim().max(40).optional(),
    color_scheme: z.enum(['light', 'dark']).optional().describe('Overall look the client prefers.'),
    font_style: z.string().trim().max(120).optional().describe('e.g. "clean sans-serif", "elegant serif".'),
    logo_notes: z.string().trim().max(600).optional().describe('Whether they have a logo, where it is, or what to do meanwhile.'),
    primary_color: z.string().trim().max(40).optional().describe('Hex or plain colour name, e.g. "#1e6f5c" or "forest green".'),
    secondary_color: z.string().trim().max(40).optional(),
    style_keywords: z
      .array(z.string().trim().min(1).max(60))
      .max(12)
      .optional()
      .describe('e.g. ["minimal", "warm", "premium"].'),
    tone: z.string().trim().max(200).optional().describe('Voice for the copy, e.g. "friendly and plain-spoken".'),
  })
  .partial();

const siteBriefContactSchema = z
  .strictObject({
    address: z.string().trim().max(400).optional(),
    email: z.string().trim().max(200).optional(),
    hours: z.string().trim().max(400).optional(),
    phone: z.string().trim().max(60).optional(),
    social: z
      .array(
        z.strictObject({
          platform: z.string().trim().min(1).max(60),
          url: z.string().trim().min(1).max(2048),
        })
      )
      .max(12)
      .optional(),
  })
  .partial();

/** The complete brief as stored. Every field a build step may need has a default. */
export const cortexSiteBriefSchema = z.strictObject({
  audience: z.string().trim().max(1000).optional().describe('Who the site is for.'),
  brand: siteBriefBrandSchema.optional(),
  business_name: z.string().trim().min(1).max(160),
  contact: siteBriefContactSchema.optional(),
  description: z
    .string()
    .trim()
    .max(3000)
    .optional()
    .describe('What the business does, in the client\'s own words where possible.'),
  ecommerce: z
    .strictObject({
      enabled: z.boolean().default(false),
      products_summary: z.string().trim().max(1000).optional(),
    })
    .optional(),
  goals: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .optional()
    .describe('What the site must achieve, e.g. ["get quote requests", "show the menu"].'),
  keep_existing_content: z
    .boolean()
    .default(false)
    .describe('true when the client wants existing pages/posts kept rather than replaced.'),
  languages: z
    .array(localeCodeSchema)
    .min(1)
    .max(10)
    .default(['en'])
    .describe('Locale codes the public site must offer, primary first.'),
  notes: z.string().trim().max(4000).optional().describe('Anything else the client said that matters.'),
  pages: z
    .array(siteBriefPageSchema)
    .max(30)
    .default([])
    .describe('The pages to build. A one-page landing site is a single "home" entry.'),
  primary_language: localeCodeSchema.default('en'),
  site_type: z
    .enum(['landing-page', 'multi-page', 'blog', 'store', 'portfolio', 'other'])
    .default('multi-page'),
  status: z
    .enum(['draft', 'confirmed', 'built'])
    .default('draft')
    .describe('draft while interviewing, confirmed once the client approved the plan, built when the build finished.'),
  tagline: z.string().trim().max(200).optional(),
  updated_at: z.string().max(80).optional(),
});

export type CortexSiteBrief = z.infer<typeof cortexSiteBriefSchema>;

/** What a tool may pass to save or merge: every field optional. */
export const cortexSiteBriefInputSchema = cortexSiteBriefSchema.partial();

export type CortexSiteBriefInput = z.infer<typeof cortexSiteBriefInputSchema>;

export const cortexBuildSessionSchema = z.strictObject({
  actorUserId: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  id: z.string().min(1),
  summary: z.string().max(4000),
});

export type CortexBuildSession = z.infer<typeof cortexBuildSessionSchema>;

/** Parse a stored brief leniently: an unreadable row is treated as "no brief". */
export function safeParseCortexSiteBrief(value: unknown): CortexSiteBrief | null {
  const parsed = cortexSiteBriefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A brief counts as collected once it names the business AND says what it does.
 *
 * The schema only requires the name (a chat interview saves after every answer, so a
 * name-only brief is a normal intermediate state). Everything that decides whether the
 * site builder may skip the interview — the chat kickoff, the wizard's "Brief saved"
 * card and the route's system prompt — must agree, so they all call this one predicate.
 */
export function isCortexSiteBriefComplete(brief: CortexSiteBrief | null | undefined): brief is CortexSiteBrief {
  return Boolean(brief && brief.business_name.trim() && brief.description?.trim());
}

/** A build session is only usable by the admin who opened it, and only until it expires. */
export function isCortexBuildSessionUsable(
  session: CortexBuildSession | null | undefined,
  params: { actorUserId: string | null | undefined; now?: Date }
): session is CortexBuildSession {
  if (!session || !params.actorUserId || session.actorUserId !== params.actorUserId) {
    return false;
  }

  const expiresAt = Date.parse(session.expiresAt);
  const now = (params.now ?? new Date()).getTime();

  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Compact, prompt-ready rendering of the brief. The model reads this at the top of
 * every conversation once a brief exists, so it is deliberately short: facts, not
 * prose, and never the raw JSON (which wastes tokens on braces and quotes).
 */
export function formatCortexSiteBriefForPrompt(brief: CortexSiteBrief): string {
  const lines: string[] = [
    `Business: ${brief.business_name}${brief.tagline ? ` — ${brief.tagline}` : ''}`,
  ];

  if (brief.description) lines.push(`What they do: ${brief.description}`);
  if (brief.audience) lines.push(`Audience: ${brief.audience}`);
  if (brief.goals?.length) lines.push(`Goals: ${brief.goals.join('; ')}`);
  lines.push(`Site type: ${brief.site_type}. Languages: ${brief.languages.join(', ')} (primary ${brief.primary_language}).`);

  if (brief.pages.length > 0) {
    lines.push(
      `Pages: ${brief.pages
        .map((page) => `${page.title} (/${page.slug})${page.purpose ? ` — ${page.purpose}` : ''}`)
        .join('; ')}`
    );
  }

  const brand = brief.brand;
  if (brand && Object.keys(brand).length > 0) {
    const parts = [
      brand.primary_color ? `primary ${brand.primary_color}` : null,
      brand.secondary_color ? `secondary ${brand.secondary_color}` : null,
      brand.accent_color ? `accent ${brand.accent_color}` : null,
      brand.color_scheme ? `${brand.color_scheme} scheme` : null,
      brand.font_style ? `fonts: ${brand.font_style}` : null,
      brand.tone ? `tone: ${brand.tone}` : null,
      brand.style_keywords?.length ? `style: ${brand.style_keywords.join(', ')}` : null,
      brand.logo_notes ? `logo: ${brand.logo_notes}` : null,
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`Brand: ${parts.join('; ')}`);
  }

  const contact = brief.contact;
  if (contact && Object.keys(contact).length > 0) {
    const parts = [
      contact.email ? `email ${contact.email}` : null,
      contact.phone ? `phone ${contact.phone}` : null,
      contact.address ? `address ${contact.address}` : null,
      contact.hours ? `hours ${contact.hours}` : null,
      contact.social?.length ? `social: ${contact.social.map((entry) => `${entry.platform} ${entry.url}`).join(', ')}` : null,
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`Contact: ${parts.join('; ')}`);
  }

  if (brief.ecommerce?.enabled) {
    lines.push(`Ecommerce: yes${brief.ecommerce.products_summary ? ` — ${brief.ecommerce.products_summary}` : ''}`);
  }

  if (brief.keep_existing_content) lines.push('Keep existing content: yes (do not wipe pages or posts).');
  if (brief.notes) lines.push(`Notes: ${brief.notes}`);
  lines.push(`Brief status: ${brief.status}.`);

  return lines.join('\n');
}
