/**
 * Vendor copy of the NextBlock™ Affiliates & Creator Storefronts license product, EN and FR:
 * title, descriptions, SEO meta and the five description sections (hero, stat tiles, feature
 * cards, how it works, CTA).
 *
 * Consumers, kept identical:
 * - this route's enrichAffiliatesProducts(), which rewrites the product blocks on the sandbox
 *   after every reset (a migration never reaches them: products are synced from Freemius after
 *   the SQL replay);
 * - a future vendor-only migration for nextblock.dev, which will carry the same sections the way
 *   02019 does for Cortex AI (products are vendor-only rows; fresh installs have none, so it will
 *   be a no-op there).
 *
 * The final call to action links to the product's own page, whose slug exists only once Freemius
 * has synced the product: it holds AFFILIATES_PRODUCT_URL_PLACEHOLDER, which the route replaces
 * with the nextblock.dev store page once `purchase_url` is one, else /product/<en slug> (EN) and
 * /product/<en slug>-fr (FR); the migration will write the address itself. The hero button opens the live demo on the public sandbox (cms.nextblock.dev/partners,
 * /partenaires: AFFILIATES_DEMO_URLS), which answers while the sandbox runs the program
 * (FREEMIUS_AFFILIATES_SANDBOX_KEY and FREEMIUS_ECOMMERCE_SANDBOX_KEY set there); the route drops
 * it while the Affiliates key is unset. The CTA heading is "white", not the "background"
 * token: that token turns near-black in dark mode, on a gradient that stays dark.
 *
 * The FR sections are a Québec French translation of the EN ones with the same layout. Claims
 * follow docs/15-AFFILIATES-AND-STOREFRONTS.md: an add-on that needs an active Commerce Pro
 * license on the same site (sold separately) and pauses, keeping its data, without it; one
 * storefront per partner, every version approved by an admin before it goes live; referral links
 * and storefront visits credited at checkout, never for a visitor who declined marketing cookies;
 * tier rates, referral windows and refund holds set by the store (02030 seeds four tiers);
 * commissions on an order's first payment, reduced pro rata by partial refunds, held by open
 * disputes, paid through Stripe Connect Express; the copilot needs Cortex AI. No prices: they
 * change, and the product's price fields show them.
 */
export interface AffiliatesProductCopy {
  title: string;
  short_description: string;
  meta_title: string;
  meta_description: string;
  sections: ReadonlyArray<Record<string, unknown>>;
}

/** Stands for the product page URL in the copy; the route swaps in the synced slug. */
export const AFFILIATES_PRODUCT_URL_PLACEHOLDER = '{{PRODUCT_URL}}';

/** The hero's live-demo links: the public sandbox's partner pages (EN, FR). */
export const AFFILIATES_DEMO_URL_EN = 'https://cms.nextblock.dev/partners';
export const AFFILIATES_DEMO_URL_FR = 'https://cms.nextblock.dev/partenaires';
export const AFFILIATES_DEMO_URLS: readonly string[] = [AFFILIATES_DEMO_URL_EN, AFFILIATES_DEMO_URL_FR];

export const AFFILIATES_PRODUCT_COPY: Readonly<Record<'en' | 'fr', AffiliatesProductCopy>> = {
  "en": {
    "title": "NextBlock™ Affiliates & Creator Storefronts License",
    "short_description": "NextBlock™ Affiliates & Creator Storefronts adds a partner program to your store. Partners sign up at /partners, publish a co-branded storefront you approve, and earn commissions at the tier rates you set, paid automatically through Stripe Connect. An add-on that needs NextBlock™ Commerce Pro, sold separately. Free for 30 days, no credit card.",
    "meta_title": "NextBlock™ Affiliate Program & Storefronts for Next.js",
    "meta_description": "Add an affiliate program to your NextBlock™ Commerce Pro store: partner signup, approved co-branded storefronts, commission tiers and Stripe Connect payouts.",
    "sections": [
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "gradient",
          "gradient": {
            "type": "linear",
            "stops": [
              {
                "color": "#172554",
                "position": 0
              },
              {
                "color": "#1e3a8a",
                "position": 35
              },
              {
                "color": "#0f172a",
                "position": 100
              }
            ],
            "direction": "135deg"
          }
        },
        "column_gap": "xl",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-sky-400 font-semibold mb-4'>Commerce Pro Add-On · 30-Day Free Trial</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Your Own Affiliate Program, Built Into Your Store.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Partners sign up at /partners, build a co-branded storefront in a restricted editor, and share their referral links. You approve every storefront version before it goes live, and commissions reach each partner's bank automatically through Stripe Connect Express.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>Affiliates &amp; Creator Storefronts is an add-on for NextBlock™ Commerce Pro: it needs an active Commerce Pro license on the same site, sold separately. While Commerce Pro is off, the program pauses and keeps its partners, storefronts and ledger. The license starts with a 30-day free trial and no credit card.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": AFFILIATES_DEMO_URL_EN,
                "size": "lg",
                "text": "Explore the Live Demo →",
                "variant": "default",
                "position": "left"
              },
              "block_type": "button"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='rounded-2xl border border-sky-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Everything a Partner Program Needs</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Signup and landing page</strong> — /partners shows your tier ladder, a revenue calculator and the signup form in the visitor's language, and /partenaires always shows it in French.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Approved storefronts</strong> — one co-branded page per partner, and no version goes live until you approve it.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Referral tracking</strong> — referral links and storefront visits credit the partner at checkout. Visitors who decline marketing cookies are never attributed.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Automatic payouts</strong> — each commission waits out a refund-protection hold, then goes to the partner's bank through Stripe Connect Express.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Refund-aware ledger</strong> — refunds cancel or reduce an unpaid commission, pro rata for partial refunds, and open disputes hold it. A refund after a payout alerts you.</span></li></ul></div>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 1,
          "desktop": 2
        },
        "vertical_alignment": "center"
      },
      {
        "padding": {
          "top": "lg",
          "bottom": "lg"
        },
        "background": {
          "type": "theme",
          "theme": "muted"
        },
        "column_gap": "lg",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>30</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Days free, no card</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>1</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Approved storefront per partner</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>4</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Ready-made tiers, all editable</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>EN + FR</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Partner pages and emails</span></p>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 2,
          "desktop": 4
        },
        "vertical_alignment": "center"
      },
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "none"
        },
        "column_gap": "lg",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9'></path><path d='M3 10 5 4h14l2 6Z'></path><path d='M10 20v-5h4v5'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Co-Branded Storefronts</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Each partner gets one page at /partners/&lt;handle&gt;, built in a restricted editor with product grids from your catalog. Partner content is sanitized and never rendered as raw HTML.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><rect x='3' y='4' width='7' height='16' rx='1.5'></rect><rect x='14' y='4' width='7' height='16' rx='1.5'></rect><path d='m15.5 12 1.5 1.5 2.5-3'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Side-by-Side Review</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Submissions wait in a review queue. Compare the live page with the proposed one, changed blocks highlighted, then approve it or request changes with a note.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='M19 5 5 19'></path><circle cx='6.5' cy='6.5' r='2.5'></circle><circle cx='17.5' cy='17.5' r='2.5'></circle></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Commission Tiers</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Set each tier's rate, referral window and refund hold, and run a capped launch offer for your first partners. Commissions use the order total after discounts, without tax or shipping.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='m3 9 9-5 9 5'></path><path d='M5 10v8M9.5 10v8M14.5 10v8M19 10v8'></path><path d='M3 20h18'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Stripe Connect Payouts</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Partners connect their bank once through Stripe Connect Express. Cleared commissions are transferred from your Stripe balance in your store's base currency, automatically or when you click Run payouts now.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><circle cx='12' cy='8' r='4'></circle><path d='M4 21a8 8 0 0 1 16 0'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Partner Portal</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Partners follow their getting-started steps, see referral visits and balances, build referral links, and track their commissions and payouts. They never enter your CMS.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z'></path><path d='M19 15v4M17 17h4'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Storefront Copilot</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>With Cortex AI active, partners get an optional assistant that drafts their bio and storefront copy on your OpenRouter key, within hourly limits. Its tools only return suggestions.</p></div>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 2,
          "desktop": 3
        },
        "vertical_alignment": "stretch"
      },
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "gradient",
          "gradient": {
            "type": "linear",
            "stops": [
              {
                "color": "#020617",
                "position": 0
              },
              {
                "color": "#0f172a",
                "position": 100
              }
            ],
            "direction": "180deg"
          }
        },
        "column_gap": "xl",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-sky-400 font-semibold mb-4'>How It Works</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>From Referral to Payout, Tracked End to End.</h3><p class='text-slate-300 leading-relaxed mb-5'>A referral link or a storefront visit credits the partner when the order is placed, through Stripe or Freemius checkout. The commission is recorded when the order is first paid and waits out the tier's refund-protection hold. It then goes out with the partner's next automatic payout, once their cleared balance reaches your minimum and your Stripe balance covers it.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>Only active partners with an approved storefront earn, from their first approval on.</span></li><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>No self-referrals: orders placed with a partner's own account or email never earn.</span></li><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>One commission per order, on its first payment. Renewals never earn.</span></li><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>Suspending a partner takes their storefront off your site at once.</span></li></ul>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Admin Control Center</h4><p class='text-xs text-slate-400 leading-relaxed'>A partner table with search, tier moves and suspension, a tier editor, the review queue, the commission ledger, and payout controls with Retry, Release and Run payouts now.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Email Notifications</h4><p class='text-xs text-slate-400 leading-relaxed'>With SMTP set up, admins hear about signups, submissions, failed payouts and refunds after a payout. Partners are emailed when their page is published or needs changes, when they earn, and when a payout is sent.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Bilingual by Default</h4><p class='text-xs text-slate-400 leading-relaxed'>The landing page, storefronts, partner portal and partner emails speak English and Québec French. The CMS screens stay in English.</p></div></div>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 1,
          "desktop": 2
        },
        "vertical_alignment": "center"
      },
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "gradient",
          "gradient": {
            "type": "linear",
            "stops": [
              {
                "color": "#1e3a8a",
                "position": 0
              },
              {
                "color": "#172554",
                "position": 100
              }
            ],
            "direction": "135deg"
          }
        },
        "column_gap": "none",
        "column_blocks": [
          [
            {
              "content": {
                "level": 2,
                "textAlign": "center",
                "textColor": "white",
                "text_content": "Ready to launch your partner program?"
              },
              "block_type": "heading"
            },
            {
              "content": {
                "html_content": "<p class='text-center text-sky-100 max-w-xl mx-auto mt-2 mb-6'>Add Affiliates &amp; Creator Storefronts to your Commerce Pro store. Start with 30 days free and no credit card, set your tiers, and approve your first partner storefront.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": "{{PRODUCT_URL}}",
                "size": "lg",
                "text": "Start the 30-Day Free Trial",
                "variant": "secondary",
                "position": "center"
              },
              "block_type": "button"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 1,
          "desktop": 1
        },
        "vertical_alignment": "center"
      }
    ]
  },
  "fr": {
    "title": "Licence NextBlock™ Affiliates & Creator Storefronts",
    "short_description": "NextBlock™ Affiliates & Creator Storefronts ajoute un programme de partenaires à votre boutique. Vos partenaires s'inscrivent sur /partenaires, publient une vitrine à leur nom après votre approbation et touchent des commissions aux taux que vous fixez pour chaque niveau, versées automatiquement par Stripe Connect. Un module complémentaire qui exige NextBlock™ Commerce Pro, vendu séparément. Gratuit pendant 30 jours, sans carte de crédit.",
    "meta_title": "Programme d'affiliation NextBlock™ pour boutiques Next.js",
    "meta_description": "Ajoutez un programme d'affiliation à votre boutique NextBlock™ Commerce Pro\u00a0: inscription, vitrines approuvées, niveaux de commission et versements Stripe.",
    "sections": [
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "gradient",
          "gradient": {
            "type": "linear",
            "stops": [
              {
                "color": "#172554",
                "position": 0
              },
              {
                "color": "#1e3a8a",
                "position": 35
              },
              {
                "color": "#0f172a",
                "position": 100
              }
            ],
            "direction": "135deg"
          }
        },
        "column_gap": "xl",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-sky-400 font-semibold mb-4'>Module complémentaire de Commerce Pro · Essai gratuit de 30 jours</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Votre propre programme d'affiliation, intégré à votre boutique.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Vos partenaires s'inscrivent sur /partenaires, bâtissent dans un éditeur restreint une vitrine à leur nom, aux couleurs de votre boutique, et partagent leurs liens de recommandation. Vous approuvez chaque version d'une vitrine avant sa mise en ligne, et les commissions sont versées automatiquement dans le compte bancaire de chaque partenaire par Stripe Connect Express.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>Affiliates &amp; Creator Storefronts est un module complémentaire de NextBlock™ Commerce Pro&nbsp;: il exige une licence Commerce Pro active sur le même site, vendue séparément. Tant que Commerce Pro est désactivé, le programme est en pause et conserve ses partenaires, ses vitrines et son registre des commissions. La licence commence par un essai gratuit de 30 jours, sans carte de crédit.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": AFFILIATES_DEMO_URL_FR,
                "size": "lg",
                "text": "Explorer la démo en ligne →",
                "variant": "default",
                "position": "left"
              },
              "block_type": "button"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='rounded-2xl border border-sky-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Tout ce qu'il faut pour un programme de partenaires</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Inscription et page du programme</strong> — /partenaires présente vos niveaux de partenaire, un calculateur de revenus et le formulaire d'inscription en français, et /partners affiche la même page dans la langue du visiteur.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Vitrines approuvées</strong> — une page à son nom pour chaque partenaire, et aucune version n'est mise en ligne avant votre approbation.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Suivi des recommandations</strong> — les liens de recommandation et les visites de vitrine attribuent la vente au partenaire au moment de la commande. Un visiteur qui refuse les témoins marketing n'est jamais attribué à un partenaire.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Versements automatiques</strong> — chaque commission attend la fin d'une période de retenue qui protège contre les remboursements, puis est versée dans le compte bancaire du partenaire par Stripe Connect Express.</span></li><li class='flex items-start gap-3'><span aria-hidden='true' class='flex-shrink-0 w-6 h-6 rounded-full bg-sky-950 flex items-center justify-center text-sky-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Registre qui tient compte des remboursements</strong> — un remboursement annule ou réduit une commission non versée, au prorata s'il est partiel, et un litige ouvert la retient. Un remboursement après un versement vous est signalé.</span></li></ul></div>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 1,
          "desktop": 2
        },
        "vertical_alignment": "center"
      },
      {
        "padding": {
          "top": "lg",
          "bottom": "lg"
        },
        "background": {
          "type": "theme",
          "theme": "muted"
        },
        "column_gap": "lg",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>30</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Jours gratuits, sans carte</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>1</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Vitrine approuvée par partenaire</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>4</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Niveaux prêts à l'emploi, tous modifiables</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>EN + FR</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Pages et courriels des partenaires</span></p>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 2,
          "desktop": 4
        },
        "vertical_alignment": "center"
      },
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "none"
        },
        "column_gap": "lg",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9'></path><path d='M3 10 5 4h14l2 6Z'></path><path d='M10 20v-5h4v5'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Vitrines de partenaires</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Chaque partenaire obtient une page à l'adresse /partners/&lt;identifiant&gt;, bâtie dans un éditeur restreint avec des grilles de produits de votre catalogue. Le contenu des partenaires est filtré et n'est jamais affiché en HTML brut.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><rect x='3' y='4' width='7' height='16' rx='1.5'></rect><rect x='14' y='4' width='7' height='16' rx='1.5'></rect><path d='m15.5 12 1.5 1.5 2.5-3'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Révision côte à côte</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Les soumissions attendent dans une file de révision. Comparez la page en ligne et la page proposée, blocs modifiés surlignés, puis approuvez-la ou demandez des changements avec une note.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='M19 5 5 19'></path><circle cx='6.5' cy='6.5' r='2.5'></circle><circle cx='17.5' cy='17.5' r='2.5'></circle></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Niveaux de commission</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Fixez le taux, la fenêtre de recommandation et la période de retenue de chaque niveau, et proposez une offre de lancement à places limitées à vos premiers partenaires. Les commissions portent sur le total de la commande après rabais, sans les taxes ni la livraison.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='m3 9 9-5 9 5'></path><path d='M5 10v8M9.5 10v8M14.5 10v8M19 10v8'></path><path d='M3 20h18'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Versements Stripe Connect</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Vos partenaires lient leur banque une seule fois avec Stripe Connect Express. Les commissions confirmées sont transférées depuis votre solde Stripe, dans la devise de base de votre boutique, automatiquement ou quand vous cliquez sur Run payouts now.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><circle cx='12' cy='8' r='4'></circle><path d='M4 21a8 8 0 0 1 16 0'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Portail partenaire</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Vos partenaires franchissent les étapes de démarrage, consultent leurs visites et leurs soldes, créent leurs liens de recommandation et suivent leurs commissions et leurs versements. Ils n'ont jamais accès à votre CMS.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-sky-500 sm:p-7'><div class='mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'><svg class='h-5 w-5' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24' aria-hidden='true'><path d='M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z'></path><path d='M19 15v4M17 17h4'></path></svg></div><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'>Copilote de vitrine</h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Avec Cortex AI actif, vos partenaires profitent d'un assistant facultatif qui rédige leur bio et le texte de leur vitrine à l'aide de votre clé OpenRouter, avec un nombre de requêtes limité par heure. Ses outils se contentent de faire des suggestions.</p></div>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 2,
          "desktop": 3
        },
        "vertical_alignment": "stretch"
      },
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "gradient",
          "gradient": {
            "type": "linear",
            "stops": [
              {
                "color": "#020617",
                "position": 0
              },
              {
                "color": "#0f172a",
                "position": 100
              }
            ],
            "direction": "180deg"
          }
        },
        "column_gap": "xl",
        "column_blocks": [
          [
            {
              "content": {
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-sky-400 font-semibold mb-4'>Comment ça marche</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>De la recommandation au versement, tout est suivi.</h3><p class='text-slate-300 leading-relaxed mb-5'>Un lien de recommandation ou une visite de vitrine attribue la commande au partenaire au moment de l'achat, avec le paiement Stripe ou Freemius. La commission est enregistrée au premier paiement de la commande, puis attend la fin de la période de retenue du niveau. Elle part ensuite avec le prochain versement automatique du partenaire, dès que son solde confirmé atteint votre minimum et que votre solde Stripe le couvre.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>Seuls les partenaires actifs dont la vitrine est approuvée touchent des commissions, à partir de leur première approbation.</span></li><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>Pas de commission sur ses propres achats&nbsp;: une commande passée avec le compte ou le courriel du partenaire ne rapporte rien.</span></li><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>Une commission par commande, sur son premier paiement. Les renouvellements ne rapportent rien.</span></li><li class='flex items-start gap-2.5'><span aria-hidden='true' class='text-sky-400'>→</span><span>Suspendre un partenaire retire aussitôt sa vitrine de votre site.</span></li></ul>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Centre de contrôle</h4><p class='text-xs text-slate-400 leading-relaxed'>Un tableau des partenaires avec recherche, changements de niveau et suspension, un éditeur de niveaux, la file de révision, le registre des commissions et la gestion des versements, avec les boutons Retry, Release et Run payouts now.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Notifications par courriel</h4><p class='text-xs text-slate-400 leading-relaxed'>Si le SMTP est configuré, les administrateurs sont avisés des inscriptions, des soumissions, des versements en échec et des remboursements survenus après un versement. Les partenaires reçoivent un courriel quand leur page est publiée ou doit être modifiée, quand ils gagnent une commission et quand un versement leur est envoyé.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Bilingue d'emblée</h4><p class='text-xs text-slate-400 leading-relaxed'>La page du programme, les vitrines, le portail partenaire et les courriels des partenaires sont offerts en anglais et en français du Québec. Les écrans du CMS restent en anglais.</p></div></div>"
              },
              "block_type": "text"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 1,
          "desktop": 2
        },
        "vertical_alignment": "center"
      },
      {
        "padding": {
          "top": "xl",
          "bottom": "xl"
        },
        "background": {
          "type": "gradient",
          "gradient": {
            "type": "linear",
            "stops": [
              {
                "color": "#1e3a8a",
                "position": 0
              },
              {
                "color": "#172554",
                "position": 100
              }
            ],
            "direction": "135deg"
          }
        },
        "column_gap": "none",
        "column_blocks": [
          [
            {
              "content": {
                "level": 2,
                "textAlign": "center",
                "textColor": "white",
                "text_content": "Prêt à lancer votre programme de partenaires?"
              },
              "block_type": "heading"
            },
            {
              "content": {
                "html_content": "<p class='text-center text-sky-100 max-w-xl mx-auto mt-2 mb-6'>Ajoutez Affiliates &amp; Creator Storefronts à votre boutique Commerce Pro. Commencez avec 30 jours gratuits, sans carte de crédit, fixez vos niveaux et approuvez la vitrine de votre premier partenaire.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": "{{PRODUCT_URL}}",
                "size": "lg",
                "text": "Commencer l'essai gratuit de 30 jours",
                "variant": "secondary",
                "position": "center"
              },
              "block_type": "button"
            }
          ]
        ],
        "container_type": "container",
        "responsive_columns": {
          "mobile": 1,
          "tablet": 1,
          "desktop": 1
        },
        "vertical_alignment": "center"
      }
    ]
  }
};
