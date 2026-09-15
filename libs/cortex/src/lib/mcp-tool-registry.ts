import { createCortexGlobalAgentTools } from './ai-global-agent-tools';
import { availableCortexAiBlockTypes } from './block-content-schemas';
import { z } from './zod-config';
import type { CortexAiMcpScope } from './mcp-tokens';

/**
 * Adapts the existing Cortex AI tool registry to the Model Context Protocol.
 *
 * This file deliberately owns NO business logic. Every tool exposed over MCP is the
 * same executor the in-app global agent calls, reached through
 * `createCortexGlobalAgentTools(context)` — so an external client (Claude Code,
 * Cursor, …) and the dashboard chat cannot drift apart in validation, revision
 * recording, or side effects. What this layer adds is only what MCP needs and the
 * AI SDK path does not:
 *
 *   1. JSON Schema. MCP `tools/list` transmits raw JSON Schema; the registry stores Zod.
 *   2. Scopes. A read-only token must not even *see* the mutating tools.
 *   3. Aliases. The MCP contract names five tools that already exist here under
 *      different names (see CORTEX_MCP_TOOL_ALIASES).
 *   4. MCP result envelopes (`content` / `isError` / `structuredContent`).
 */

// `ToolExecutionContext` is module-private in ai-global-agent-tools.ts, so derive it
// from the factory rather than re-declaring a copy that could silently drift.
export type CortexMcpToolContext = Parameters<typeof createCortexGlobalAgentTools>[0];

/**
 * Read/write classification for every tool in the registry.
 *
 * Exhaustive by construction: `assertCortexMcpToolCoverage` (and a unit test) compares
 * these keys against the live factory output, so adding a tool to the agent without
 * classifying it here is a loud failure rather than a silent security hole. New tools
 * are NOT defaulted to 'read' — an unclassified mutating tool handed to a read-only
 * token is exactly the bug this table exists to prevent.
 */
export const CORTEX_MCP_TOOL_KINDS = {
  create_cms_page: 'write',
  create_cms_post: 'write',
  create_cms_product: 'write',
  create_custom_block: 'write',
  delete_cms_item: 'write',
  delete_custom_block: 'write',
  describe_database_schema: 'read',
  execute_cms_action_plan: 'write',
  execute_database_action_plan: 'write',
  execute_database_mutation: 'write',
  fetch_ecommerce_stats: 'read',
  fetch_url_content: 'read',
  finish_site_build: 'write',
  get_site_overview: 'read',
  insert_content_block: 'write',
  list_custom_blocks: 'read',
  list_media: 'read',
  list_product_categories: 'read',
  list_site_script_revisions: 'read',
  list_site_scripts: 'read',
  list_site_themes: 'read',
  manage_language: 'write',
  manage_product_category: 'write',
  manage_product_variants: 'write',
  manage_site_script: 'write',
  manage_site_theme: 'write',
  prepare_delete_cms_item: 'read',
  publish_content_draft: 'write',
  read_current_cms_item: 'read',
  read_database_records: 'read',
  reset_site_content: 'write',
  revert_site_script: 'write',
  rewrite_page_draft: 'write',
  save_site_brief: 'write',
  search_documentation: 'read',
  search_stock_photos: 'read',
  set_content_images: 'write',
  start_site_build: 'write',
  translate_content_bulk: 'write',
  translate_page: 'write',
  update_cms_item_field: 'write',
  upload_media: 'write',
  update_content_block: 'write',
  update_current_cms_fields: 'write',
  update_custom_block: 'write',
  update_footer: 'write',
  update_global_css: 'write',
  update_navigation_bar: 'write',
  update_section_column_block: 'write',
  update_site_identity: 'write',
} as const satisfies Record<string, CortexAiMcpScope>;

export type CortexMcpCanonicalToolName = keyof typeof CORTEX_MCP_TOOL_KINDS;

/**
 * MCP-contract tool names that map onto existing executors.
 *
 * These are the names the MCP integration promises to external clients. Rather than
 * fork five 7000-line-file executors to rename them, each alias forwards to the
 * canonical tool. The alias is what an external model sees first; the canonical name
 * stays listed too, so nothing is hidden from a client that already knows the
 * in-app vocabulary.
 */
export const CORTEX_MCP_TOOL_ALIASES = {
  generate_jsonb_layout: {
    canonical: 'rewrite_page_draft',
    description:
      'Generate a complete, strictly-validated JSONB block layout and write it into a target page or post. Blocks are normalized and validated against the NextBlock block schema, then staged as a Live Draft on the target record — nothing goes live until an editor publishes the draft, and publishing snapshots a revision so the change is reversible. Use for whole-page builds and redesigns. Alias of `rewrite_page_draft`.',
    title: 'Generate JSONB layout',
  },
  get_database_schema: {
    canonical: 'describe_database_schema',
    description:
      'Return the current CMS database structure: every table Cortex AI may read or mutate, its columns, primary keys, and whether it is read-only. Pair with `list_custom_blocks` for the active data-defined block definitions and with the `cortex://schema/blocks` resource for the built-in block types. Read-only. Alias of `describe_database_schema`.',
    title: 'Get database schema',
  },
  query_site_analytics: {
    canonical: 'fetch_ecommerce_stats',
    description:
      'Query quantitative site analytics: revenue, order counts, order-status breakdowns, and top-selling products over a time range. Read-only. For inventory levels and post/page metrics that this report does not cover, use `read_database_records` against the `products`, `product_variants`, `posts`, or `pages` tables. Alias of `fetch_ecommerce_stats`.',
    title: 'Query site analytics',
  },
  search_stock_media: {
    canonical: 'search_stock_photos',
    description:
      'Search free stock media (Pexels, then Unsplash) for contextually relevant imagery, returning direct image URLs with dimensions, alt text, and photographer attribution. Drop a returned `url` straight into an image block\'s `external_url` or a section background. Read-only and zero cost. Requires a stock provider key in CMS Settings → Cortex AI. Alias of `search_stock_photos`.',
    title: 'Search stock media',
  },
  update_site_navigation: {
    canonical: 'update_navigation_bar',
    description:
      'Alter the public site navigation: header menu items and their nested child hierarchy, per locale. Use mode "append" to add links while preserving the existing menu, "update" to rename or re-point one link, and "replace" only when rebuilding the whole menu. For footer links and copyright use `update_footer`. Alias of `update_navigation_bar`.',
    title: 'Update site navigation',
  },
} as const satisfies Record<
  string,
  { canonical: CortexMcpCanonicalToolName; description: string; title: string }
>;

export type CortexMcpAliasToolName = keyof typeof CORTEX_MCP_TOOL_ALIASES;
export type CortexMcpToolName = CortexMcpAliasToolName | CortexMcpCanonicalToolName;

/** Resolve an alias to the executor that actually runs, or pass a canonical name through. */
export function resolveCortexMcpToolName(name: string): CortexMcpCanonicalToolName | null {
  if (name in CORTEX_MCP_TOOL_ALIASES) {
    return CORTEX_MCP_TOOL_ALIASES[name as CortexMcpAliasToolName].canonical;
  }

  return name in CORTEX_MCP_TOOL_KINDS ? (name as CortexMcpCanonicalToolName) : null;
}

export function getCortexMcpToolKind(name: string): CortexAiMcpScope | null {
  const canonical = resolveCortexMcpToolName(name);

  return canonical ? CORTEX_MCP_TOOL_KINDS[canonical] : null;
}

/** A token holding `write` implicitly holds `read`; there is no write-without-read tool. */
export function cortexMcpScopesAllow(scopes: readonly CortexAiMcpScope[], name: string): boolean {
  const kind = getCortexMcpToolKind(name);

  if (!kind) {
    return false;
  }

  return kind === 'read' ? scopes.length > 0 : scopes.includes('write');
}

function titleFromToolName(name: string): string {
  const words = name.split('_');

  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export type CortexMcpToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  title: string;
};

/**
 * Convert a Zod schema to the JSON Schema object MCP puts on the wire.
 *
 * `io: 'input'` matters: several schemas use `.default()`, and in output mode those
 * fields come back as *required*, which would make a client refuse a perfectly valid
 * call that omits them. `$schema` is stripped because MCP already defines the dialect
 * as draft 2020-12 when the key is absent, and some clients reject the extra key.
 */
function toMcpInputSchema(schema: unknown): Record<string, unknown> {
  const fallback = { additionalProperties: false, type: 'object' as const };

  if (!schema || typeof schema !== 'object') {
    return fallback;
  }

  try {
    const jsonSchema = z.toJSONSchema(schema as z.ZodType, {
      cycles: 'ref',
      io: 'input',
      reused: 'inline',
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as Record<string, unknown>;

    delete jsonSchema['$schema'];

    // MCP: "inputSchema MUST be a valid JSON Schema object" — a non-object schema
    // (which no current tool produces, but a future one might) would break clients.
    return jsonSchema['type'] === 'object' ? jsonSchema : fallback;
  } catch {
    return fallback;
  }
}

type AiSdkToolLike = {
  description?: string;
  execute?: (input: unknown) => unknown;
  inputSchema?: unknown;
};

function getRegistry(context: CortexMcpToolContext): Record<string, AiSdkToolLike> {
  return createCortexGlobalAgentTools(context) as unknown as Record<string, AiSdkToolLike>;
}

/**
 * Guard against the registry and the scope table drifting apart.
 *
 * Returns the tools present in one but not the other. Called by the route on every
 * `tools/list` (cheap — it is a key comparison) so an unclassified tool is dropped
 * from the listing rather than being exposed with an unknown risk profile.
 */
export function assertCortexMcpToolCoverage(context?: CortexMcpToolContext): {
  missingFromRegistry: string[];
  unclassified: string[];
} {
  const registryNames = Object.keys(getRegistry(context));
  const classifiedNames = Object.keys(CORTEX_MCP_TOOL_KINDS);

  return {
    missingFromRegistry: classifiedNames.filter((name) => !registryNames.includes(name)),
    unclassified: registryNames.filter((name) => !classifiedNames.includes(name)),
  };
}

/** Build the `tools/list` payload, filtered to what the caller's scopes permit. */
export function buildCortexMcpToolDefinitions(params: {
  context?: CortexMcpToolContext;
  scopes: readonly CortexAiMcpScope[];
}): CortexMcpToolDefinition[] {
  const registry = getRegistry(params.context);
  const definitions: CortexMcpToolDefinition[] = [];

  for (const [name, entry] of Object.entries(registry)) {
    // Unclassified tools are withheld, not defaulted — see CORTEX_MCP_TOOL_KINDS.
    if (!(name in CORTEX_MCP_TOOL_KINDS) || !cortexMcpScopesAllow(params.scopes, name)) {
      continue;
    }

    definitions.push({
      description: entry.description ?? `Cortex AI ${titleFromToolName(name)} tool.`,
      inputSchema: toMcpInputSchema(entry.inputSchema),
      name,
      title: titleFromToolName(name),
    });
  }

  for (const [alias, config] of Object.entries(CORTEX_MCP_TOOL_ALIASES)) {
    const target = registry[config.canonical];

    if (!target || !cortexMcpScopesAllow(params.scopes, alias)) {
      continue;
    }

    definitions.push({
      description: config.description,
      inputSchema: toMcpInputSchema(target.inputSchema),
      name: alias,
      title: config.title,
    });
  }

  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

export type CortexMcpToolCallResult = {
  content: Array<{ text: string; type: 'text' }>;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

function textResult(text: string, isError: boolean): CortexMcpToolCallResult {
  return { content: [{ text, type: 'text' }], isError };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export class CortexMcpUnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = 'CortexMcpUnknownToolError';
  }
}

export class CortexMcpForbiddenToolError extends Error {
  constructor(name: string) {
    super(
      `Tool "${name}" requires the "write" scope. This MCP token is read-only — mint a read+write token in CMS Settings → Cortex AI.`
    );
    this.name = 'CortexMcpForbiddenToolError';
  }
}

/**
 * Execute one MCP `tools/call`.
 *
 * Throws only for *protocol* faults (unknown tool, forbidden scope), which the caller
 * turns into JSON-RPC error objects. Everything else — validation failures, executor
 * exceptions — comes back as a successful result carrying `isError: true`, because
 * that is the encoding MCP defines for tool execution errors and the only one a model
 * can read and self-correct from.
 */
export async function callCortexMcpTool(params: {
  args: unknown;
  context?: CortexMcpToolContext;
  name: string;
  scopes: readonly CortexAiMcpScope[];
}): Promise<CortexMcpToolCallResult> {
  const canonical = resolveCortexMcpToolName(params.name);

  if (!canonical) {
    throw new CortexMcpUnknownToolError(params.name);
  }

  if (!cortexMcpScopesAllow(params.scopes, params.name)) {
    throw new CortexMcpForbiddenToolError(params.name);
  }

  const registry = getRegistry(params.context);
  const entry = registry[canonical];

  if (!entry || typeof entry.execute !== 'function') {
    throw new CortexMcpUnknownToolError(params.name);
  }

  const rawArgs = params.args && typeof params.args === 'object' ? params.args : {};

  // Validate for a good error message, but hand the executor the RAW input: several
  // schemas carry `.transform()`, and passing already-parsed output back through the
  // executor's own `.parse()` would apply those transforms twice.
  if (entry.inputSchema && typeof (entry.inputSchema as z.ZodType).safeParse === 'function') {
    const parsed = (entry.inputSchema as z.ZodType).safeParse(rawArgs);

    if (!parsed.success) {
      return textResult(
        `Invalid arguments for "${params.name}": ${formatZodIssues(parsed.error)}`,
        true
      );
    }
  }

  try {
    const output = await entry.execute(rawArgs);
    const text = JSON.stringify(output ?? { success: true }, null, 2);

    // Executors report their own failures in-band (`{ success: false, error }`) rather
    // than throwing, so surface that as isError too — otherwise a model reads a failed
    // mutation as having worked.
    const record =
      output && typeof output === 'object' && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : null;
    const isError = record?.['success'] === false;

    return {
      content: [{ text, type: 'text' }],
      isError,
      ...(record ? { structuredContent: record } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return textResult(`Tool "${params.name}" failed: ${message}`, true);
  }
}

/* -------------------------------------------------------------------------- */
/* Resources                                                                   */
/* -------------------------------------------------------------------------- */

export const CORTEX_MCP_RESOURCES = [
  {
    description:
      'The CMS database structure Cortex AI can read and mutate: tables, columns, primary keys, and read-only flags.',
    mimeType: 'application/json',
    name: 'database-schema',
    title: 'NextBlock database schema',
    uri: 'cortex://schema/database',
  },
  {
    description:
      'The built-in NextBlock block types available when composing page, post, and product layouts.',
    mimeType: 'application/json',
    name: 'block-types',
    title: 'NextBlock block types',
    uri: 'cortex://schema/blocks',
  },
  {
    description:
      'Data-defined custom block definitions registered in this workspace, keyed by the slug used as a block instance `block_type`.',
    mimeType: 'application/json',
    name: 'custom-blocks',
    title: 'NextBlock custom block definitions',
    uri: 'cortex://schema/custom-blocks',
  },
] as const;

export async function readCortexMcpResource(params: {
  context?: CortexMcpToolContext;
  uri: string;
}): Promise<{ mimeType: string; text: string; uri: string } | null> {
  const registry = getRegistry(params.context);

  if (params.uri === 'cortex://schema/database') {
    const output = await registry['describe_database_schema']?.execute?.({ includeReadOnly: true });

    return {
      mimeType: 'application/json',
      text: JSON.stringify(output ?? {}, null, 2),
      uri: params.uri,
    };
  }

  if (params.uri === 'cortex://schema/blocks') {
    return {
      mimeType: 'application/json',
      text: JSON.stringify({ blockTypes: availableCortexAiBlockTypes }, null, 2),
      uri: params.uri,
    };
  }

  if (params.uri === 'cortex://schema/custom-blocks') {
    const output = await registry['list_custom_blocks']?.execute?.({});

    return {
      mimeType: 'application/json',
      text: JSON.stringify(output ?? {}, null, 2),
      uri: params.uri,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                     */
/* -------------------------------------------------------------------------- */

export const CORTEX_MCP_PROMPTS = [
  {
    arguments: [
      {
        description:
          'Everything known about the client and the site they want: business, audience, goals, pages (or "one landing page"), languages, brand, contact details. Leave blank to be asked.',
        name: 'brief',
        required: false,
      },
    ],
    description:
      'Build (or rebuild) the whole NextBlock site from a brief: remove the sample content, set the identity and theme, create and publish every page, the menus, the footer, and the translations.',
    name: 'build-site',
    title: 'Build the whole site',
  },
  {
    arguments: [
      { description: 'What the page is for, and any brand or tone notes.', name: 'brief', required: true },
      { description: 'Slug of the page or post to rewrite, e.g. "home".', name: 'slug', required: true },
    ],
    description:
      'Build or redesign a NextBlock page from a brief, following the section-based layout recipe, and stage it as a reviewable Live Draft.',
    name: 'build-page',
    title: 'Build a NextBlock page',
  },
  {
    arguments: [
      { description: 'Source URL to draw structure and copy from.', name: 'url', required: true },
      { description: 'Slug of the page to write the result into.', name: 'slug', required: true },
    ],
    description:
      'Read an external page and rebuild an equivalent NextBlock page from it, reusing its imagery where available.',
    name: 'clone-from-url',
    title: 'Rebuild a page from a URL',
  },
  {
    arguments: [
      { description: 'Target language code, e.g. "fr".', name: 'languageCode', required: true },
      { description: 'Slug of the page or post to translate.', name: 'slug', required: true },
    ],
    description:
      'Translate an existing page or post into another language, preserving its layout and imagery.',
    name: 'translate-content',
    title: 'Translate a page or post',
  },
] as const;

const PROMPT_BODIES: Record<string, (args: Record<string, string>) => string> = {
  'build-site': (args) =>
    [
      'Build the whole NextBlock site for this client.',
      '',
      args['brief']?.trim()
        ? `Brief:\n${args['brief']}`
        : 'A site brief may already be saved (get_site_overview returns it under `brief`): if it is, use it and skip the questions; otherwise ask, in one short numbered list, about the business and what it does, the audience and the one action visitors should take, the site shape (one landing page or which pages), the languages, brand colours and tone, contact details, and whether existing content is kept.',
      '',
      'Process:',
      '1. Call get_site_overview to see what exists, the active languages, and whether the NextBlock demo content is still present. Record what you know with save_site_brief.',
      '2. Present the plan (what is removed, every page with its sections, menus, footer, theme, languages) and call start_site_build with `summary`, `brief`, and `reset` (keepLanguages = the languages wanted) unless existing content is kept. Over MCP the host approves the call; there is no chat confirmation.',
      '3. Build: update_site_identity; manage_language as needed; manage_site_theme with the brand colours; search_stock_media for imagery when available; rewrite the empty "home" page with generate_jsonb_layout then publish_content_draft; create_cms_page (status "published") for every other page; update_site_navigation (mode "replace") and update_footer for every language; translate_content_bulk for each extra language.',
      '4. Call finish_site_build with a summary, then report every page with its URL.',
      'Write real copy from the brief, never placeholders. Every page must exist in every active language.',
    ].join('\n'),
  'build-page': (args) =>
    [
      `Build the NextBlock page with slug "${args['slug'] ?? '<slug>'}" from this brief:`,
      '',
      args['brief'] ?? '<brief>',
      '',
      'Process:',
      '1. Call get_database_schema and read_current_cms_item (or read_database_records on `pages`) to ground yourself in what exists.',
      '2. Compose the page from `section` blocks: one column entry per grid track, the first section a hero, alternating none / theme:"muted" / theme:"primary" backgrounds for rhythm. Use discrete heading blocks rather than <h2> inside text HTML.',
      '3. Call search_stock_media for real photography; copy each photo\'s attribution fields onto the image block.',
      '4. Write the result with generate_jsonb_layout. It stages a Live Draft — tell the user to preview and publish it.',
    ].join('\n'),
  'clone-from-url': (args) =>
    [
      `Rebuild the NextBlock page "${args['slug'] ?? '<slug>'}" based on ${args['url'] ?? '<url>'}.`,
      '',
      'Process:',
      '1. Call fetch_url_content on the URL first. Use its headings, text, and mainImage — never invent an image URL.',
      '2. Map the source structure onto NextBlock `section` blocks; do not copy its markup verbatim.',
      '3. Write the result with generate_jsonb_layout so it lands as a reviewable Live Draft.',
    ].join('\n'),
  'translate-content': (args) =>
    [
      `Translate the page or post "${args['slug'] ?? '<slug>'}" into "${args['languageCode'] ?? '<languageCode>'}".`,
      '',
      'Use the translate_page tool: it copies layout, structure, and imagery automatically and links the copy to the original translation group. Supply only the text translations — every visible string, including headings, paragraph text, button labels, image alt text, and captions. Do not rebuild the layout and do not search for new imagery.',
    ].join('\n'),
};

export function getCortexMcpPrompt(params: {
  args?: Record<string, string>;
  name: string;
}): { description: string; messages: Array<{ content: { text: string; type: 'text' }; role: 'user' }> } | null {
  const definition = CORTEX_MCP_PROMPTS.find((entry) => entry.name === params.name);
  const body = PROMPT_BODIES[params.name];

  if (!definition || !body) {
    return null;
  }

  return {
    description: definition.description,
    messages: [
      { content: { text: body(params.args ?? {}), type: 'text' }, role: 'user' },
    ],
  };
}
