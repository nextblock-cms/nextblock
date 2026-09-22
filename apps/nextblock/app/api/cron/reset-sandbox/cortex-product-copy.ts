/**
 * Vendor copy of the NextBlock™ Cortex AI license product, EN and FR: title, descriptions, SEO meta
 * and the five description sections (hero, stat tiles, MCP tool cards, how it works, CTA).
 *
 * Two consumers, kept identical:
 * - this route's enrichCortexAiProducts(), which deletes and re-inserts the product blocks on the
 *   sandbox after every reset (a migration never reaches them: products are synced from Freemius
 *   after the SQL replay);
 * - libs/db/src/supabase/migrations/02019_open_handed_licensing_and_mcp_clients.sql, which
 *   carries the same sections for nextblock.dev (products are vendor-only rows; fresh installs
 *   have none, so the migration is a no-op there).
 *
 * The FR sections are a translation of the EN ones with the same layout. Claims follow the code:
 * 6 contract aliases + 50 typed tools (libs/cortex/src/lib/mcp-tool-registry.ts), only
 * generate_jsonb_layout stages a Live Draft, the editor AI is OpenRouter-only with one site-wide
 * model, and MCP clients authenticate with a static bearer token (so ChatGPT's web chat and the
 * Gemini app, which need OAuth, are not named). Cortex AI is one premium module among others.
 */
export interface CortexProductCopy {
  title: string;
  short_description: string;
  meta_title: string;
  meta_description: string;
  sections: ReadonlyArray<Record<string, unknown>>;
}

export const CORTEX_PRODUCT_COPY: Readonly<Record<'en' | 'fr', CortexProductCopy>> = {
  "en": {
    "title": "NextBlock™ Cortex AI MCP Server & AI Editor License",
    "short_description": "NextBlock™ Cortex AI is the AI layer for your free, open-source CMS. Pick an OpenRouter model for the editor with your own key, or register /api/mcp so Claude Code, Cursor, VS Code, or Codex can build layouts, inspect your schema, and manage content on the AI plan you already pay for. Free for 30 days, no credit card.",
    "meta_title": "Cortex AI MCP Server — Connect Claude & Cursor to Your CMS",
    "meta_description": "Turn NextBlock into a Cortex AI MCP server. Connect Claude Code, Cursor, or Codex to create layouts, inspect your schema, and manage content on your AI plan.",
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
                "color": "#1e1b4b",
                "position": 0
              },
              {
                "color": "#312e81",
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
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>MCP-Native AI Layer · 30-Day Free Trial</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Your CMS as a Cortex AI MCP Server.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Cortex AI runs two ways. Inside the editor it runs on the OpenRouter model you choose, with your own key. Over MCP it turns NextBlock into a server that Claude Code, Cursor, VS Code, and Codex operate from their own chat.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>The CMS is free and open source under the AGPL. Cortex AI is a premium module, like Commerce Pro, and it starts with a 30-day free trial and no credit card.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": "/article/cortex-ai-mcp-connection-guide",
                "size": "lg",
                "text": "Read the MCP Setup Guide →",
                "variant": "default",
                "position": "left"
              },
              "block_type": "button"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Bring Your Own AI Subscription</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Free for 30 days</strong> — start the trial with no credit card. If you do nothing, it simply ends.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>No token markup</strong> — register /api/mcp in Claude Code, Cursor, VS Code, or Codex, and the agent runs on the AI plan you already pay for, such as Claude Pro or ChatGPT Plus. You pay your provider, not us.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Editor BYOK</strong> — one OpenRouter key, free models included. You pick the model and keep the bill.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Scoped tokens</strong> — mint read-only or write tokens on the MCP server access card and revoke them any time.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Drafts and revisions</strong> — page rewrites stage as Live Drafts, and new pages stay drafts unless you ask to publish. Other write tools can change live content, and page, post, and product edits are saved as revisions you can restore.</span></li></ul></div>"
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
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>0 %</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Token markup</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>6</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>MCP contract tools</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>50</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Typed agent tools</span></p>"
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
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>get_database_schema</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Returns every table the agent may read or change, with columns, keys, and read-only flags. The model plans against real structure, not guesses.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>query_site_analytics</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Reads revenue, order counts, status breakdowns, and top products over a date range. Read-only, so it is safe on any token.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>generate_jsonb_layout</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Rewrites an existing page or post as a complete layout. Blocks are validated against the NextBlock schema and staged as a Live Draft.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>search_stock_media</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Finds free stock photos on Pexels or Unsplash, with alt text and credits, using your free API key. Drop a result straight into an image block.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>update_site_navigation</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Adds, renames, or reorders header menu items per locale. Append to keep the current menu or replace it in one call.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>and 45 more</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>create_page_layout builds a new page from validated blocks in one call. The rest create posts and products, translate pages, upload media, and manage themes, menus, and scripts. Every tool is typed and scoped.</p></div>"
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
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>How It Works</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>One Registry, Standard Transport.</h3><p class='text-slate-300 leading-relaxed mb-5'>The Cortex AI MCP server speaks Streamable HTTP at /api/mcp. Your client posts JSON-RPC messages and gets typed results back. There is no SDK to install on your server and no proxy in the middle.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Bearer tokens are stored as SHA-256 hashes and shown once.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Optional localhost trust lets a local dev server skip the token. It never applies in production.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Read-only tokens never see a mutating tool in the list.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Copy-paste config for Claude Code, Codex, Cursor, VS Code, and Claude Desktop.</span></li></ul>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Editor BYOK via OpenRouter</h4><p class='text-xs text-slate-400 leading-relaxed'>Choose one model for the whole site in Cortex AI settings, from Claude or Gemini to open weights, with one key. Free models are included, and paid usage stays on your OpenRouter bill.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>AI Inside the Editor</h4><p class='text-xs text-slate-400 leading-relaxed'>The inline assistant writes and rewrites copy in any text block. The dashboard chat edits sections, builds pages, and translates whole pages, and every block is validated before it is saved.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Privacy-First Design</h4><p class='text-xs text-slate-400 leading-relaxed'>Editor requests go from your own server to OpenRouter with your key, and MCP traffic runs between your AI app and your site. NextBlock never sees, stores, or trains on your content.</p></div></div>"
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
                "color": "#312e81",
                "position": 0
              },
              {
                "color": "#1e1b4b",
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
                "textColor": "background",
                "text_content": "Ready to connect your AI to your CMS?"
              },
              "block_type": "heading"
            },
            {
              "content": {
                "html_content": "<p class='text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6'>One license unlocks Cortex AI in the editor and the MCP server. Start with 30 days free and no credit card, bring your own AI subscription, and keep your data yours.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": "https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license",
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
    "title": "Licence NextBlock™ du serveur MCP Cortex AI et de l'IA dans l'éditeur",
    "short_description": "NextBlock™ Cortex AI est la couche IA de votre CMS gratuit et open source. Choisissez un modèle OpenRouter pour l'éditeur avec votre propre clé, ou enregistrez /api/mcp pour que Claude Code, Cursor, VS Code ou Codex construisent des mises en page, lisent votre schéma et gèrent votre contenu avec le forfait IA que vous payez déjà. Gratuit pendant 30 jours, sans carte de crédit.",
    "meta_title": "Serveur MCP Cortex AI — Claude et Cursor dans votre CMS",
    "meta_description": "Faites de NextBlock un serveur MCP Cortex AI. Connectez Claude Code, Cursor ou Codex pour créer des mises en page et gérer votre contenu avec votre forfait IA.",
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
                "color": "#1e1b4b",
                "position": 0
              },
              {
                "color": "#312e81",
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
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Couche IA native MCP · Essai gratuit de 30 jours</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Votre CMS devient un serveur MCP Cortex AI.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Cortex AI fonctionne de deux façons. Dans l'éditeur, il utilise le modèle OpenRouter de votre choix, avec votre propre clé. Via MCP, il fait de NextBlock un serveur que Claude Code, Cursor, VS Code et Codex pilotent depuis leur propre fenêtre de discussion.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>Le CMS est gratuit et open source sous licence AGPL. Cortex AI est un module premium, comme Commerce Pro, et il commence par un essai gratuit de 30 jours, sans carte de crédit.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": "/article/guide-connexion-mcp-cortex-ai",
                "size": "lg",
                "text": "Lire le guide de configuration MCP →",
                "variant": "default",
                "position": "left"
              },
              "block_type": "button"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Utilisez votre propre abonnement IA</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Gratuit pendant 30 jours</strong> — lancez l'essai sans carte de crédit. Si vous ne faites rien, il prend simplement fin.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Aucune majoration sur les jetons</strong> — enregistrez /api/mcp dans Claude Code, Cursor, VS Code ou Codex, et l'agent fonctionne avec le forfait IA que vous payez déjà, comme Claude Pro ou ChatGPT Plus. Vous payez votre fournisseur, pas nous.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Votre clé dans l'éditeur</strong> — une seule clé OpenRouter, modèles gratuits compris. Vous choisissez le modèle et gardez la facture.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Jetons à portée limitée</strong> — créez des jetons en lecture seule ou en écriture dans la carte MCP server access du CMS, et révoquez-les à tout moment.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Brouillons et révisions</strong> — les réécritures de page arrivent en brouillon en direct, et les nouvelles pages restent en brouillon sauf si vous demandez de les publier. D'autres outils d'écriture peuvent modifier le contenu en ligne, et les modifications des pages, articles et produits sont enregistrées comme des révisions que vous pouvez restaurer.</span></li></ul></div>"
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
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>0 %</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Majoration sur les jetons</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>6</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Outils de contrat MCP</span></p>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>50</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Outils d'agent typés</span></p>"
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
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>get_database_schema</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Renvoie chaque table que l'agent peut lire ou modifier, avec ses colonnes, ses clés et ses indicateurs de lecture seule. Le modèle planifie sur la vraie structure, pas sur des suppositions.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>query_site_analytics</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Lit les revenus, le nombre de commandes, la répartition par statut et les meilleurs produits sur une période. En lecture seule, donc sans risque avec n'importe quel jeton.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>generate_jsonb_layout</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Réécrit une page ou un article existant en mise en page complète. Chaque bloc est validé contre le schéma NextBlock, puis mis en attente comme brouillon en direct.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>search_stock_media</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Trouve des photos libres de droits sur Pexels ou Unsplash, avec texte alternatif et crédits, grâce à votre clé API gratuite. Déposez un résultat directement dans un bloc image.</p></div>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>update_site_navigation</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Ajoute, renomme ou réordonne les éléments du menu d'en-tête, par langue. Ajoutez des liens en gardant le menu actuel, ou remplacez-le en un seul appel.</p></div>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "html_content": "<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>et 45 autres</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>create_page_layout crée une nouvelle page à partir de blocs validés, en un seul appel. Les autres créent des articles et des produits, traduisent des pages, téléversent des médias et gèrent thèmes, menus et scripts. Chaque outil est typé et limité par la portée du jeton.</p></div>"
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
                "html_content": "<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Comment ça marche</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>Un seul registre, un transport standard.</h3><p class='text-slate-300 leading-relaxed mb-5'>Le serveur MCP Cortex AI parle Streamable HTTP à l'adresse /api/mcp. Votre client envoie des messages JSON-RPC et reçoit des résultats typés. Aucun SDK à installer sur votre serveur, aucun intermédiaire.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Les jetons Bearer sont stockés sous forme de hachages SHA-256 et affichés une seule fois.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>La confiance localhost, facultative, permet à un serveur de développement local de se passer du jeton. Elle ne s'applique jamais en production.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Un jeton en lecture seule ne voit jamais d'outil d'écriture dans la liste.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Configuration à copier-coller pour Claude Code, Codex, Cursor, VS Code et Claude Desktop.</span></li></ul>"
              },
              "block_type": "text"
            }
          ],
          [
            {
              "content": {
                "html_content": "<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Votre clé OpenRouter dans l'éditeur</h4><p class='text-xs text-slate-400 leading-relaxed'>Choisissez un modèle pour tout le site dans les réglages de Cortex AI, de Claude ou Gemini aux modèles ouverts, avec une seule clé. Les modèles gratuits sont inclus, et l'usage payant reste sur votre facture OpenRouter.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>L'IA dans l'éditeur</h4><p class='text-xs text-slate-400 leading-relaxed'>L'assistant intégré écrit et réécrit le texte de n'importe quel bloc de texte. Le chat du tableau de bord modifie les sections, construit des pages et traduit des pages entières, et chaque bloc est validé avant d'être enregistré.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Conçu pour la confidentialité</h4><p class='text-xs text-slate-400 leading-relaxed'>Les requêtes de l'éditeur partent de votre propre serveur vers OpenRouter avec votre clé, et le trafic MCP circule entre votre application IA et votre site. NextBlock ne voit jamais votre contenu, ne le stocke pas et ne s'en sert pas pour entraîner des modèles.</p></div></div>"
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
                "color": "#312e81",
                "position": 0
              },
              {
                "color": "#1e1b4b",
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
                "textColor": "background",
                "text_content": "Prêt à connecter votre IA à votre CMS ?"
              },
              "block_type": "heading"
            },
            {
              "content": {
                "html_content": "<p class='text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6'>Une licence débloque à la fois Cortex AI dans l'éditeur et le serveur MCP. Commencez avec 30 jours gratuits, sans carte de crédit, apportez votre propre abonnement IA et gardez la maîtrise de vos données.</p>"
              },
              "block_type": "text"
            },
            {
              "content": {
                "url": "https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license-fr",
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
