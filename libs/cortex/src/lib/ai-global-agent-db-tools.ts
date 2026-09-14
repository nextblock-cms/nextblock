import { tool } from 'ai';

import {
  isValidBlockType,
  loadCustomBlockDefinitions,
  validateCortexBlockContent,
  validateCustomBlockInstanceContent,
  type BlockContentValidator,
  type CustomBlockDefinitionLike,
} from './block-content-schemas';
import { cortexSiteBriefSchema } from './site-brief';
import { z } from './zod-config';

type SupabaseLike = {
  from: (table: string) => any;
};

type ToolExecutionContext = {
  actorUserId?: string | null;
  latestUserMessage?: string | null;
  skipAudit?: boolean;
  skipConfirmation?: boolean;
  supabase?: SupabaseLike;
  /**
   * The app's block schema validator (apps/nextblock/lib/blocks/blockRegistry.ts),
   * injected by both routes. When absent the mirrored schemas in
   * block-content-schemas.ts apply, so `blocks.content` is never written unchecked.
   */
  validateBlockContent?: BlockContentValidator;
};

type TableConfig = {
  columns: readonly string[];
  description: string;
  primaryKey: readonly string[];
  readOnly?: boolean;
};

const MAX_READ_LIMIT = 100;
const DEFAULT_READ_LIMIT = 20;
const MAX_MUTATION_TARGETS = 100;
const MAX_MUTATION_ROWS = 20;
const REDACTED = '[REDACTED]';
const PROTECTED_CORTEX_KEY = 'cortex_ai_openrouter_api_key';

/**
 * `site_settings` rows that must never reach a model, by exact key.
 *
 * `isSensitiveKey` catches sensitively *named columns*, but a site_settings row is
 * shaped `{ key, value }` — neither property name trips the heuristic, so the secret
 * rides through in `value`. These rows hold encrypted envelopes rather than plaintext,
 * but they are still credential material and there is no reason for a tool to read
 * them. This matters more now that `read_database_records` is reachable from external
 * MCP clients and not only from the in-dashboard agent.
 */
const PROTECTED_SITE_SETTING_KEYS: ReadonlySet<string> = new Set([
  PROTECTED_CORTEX_KEY,
  'bot_protection_secret',
  'cortex_ai_pexels_api_key',
  'cortex_ai_unsplash_access_key',
  'email_secret',
  'payment_secret',
]);

/**
 * `site_settings` rows a model may read but must never write through the generic
 * tool. None is secret; each one is a control the agent could otherwise use to
 * change its own authority or the install's provisioning state:
 *
 *   cortex_ai_build_session      written only by start_site_build after a human
 *                                confirmed a plan — a forged row would let a
 *                                prompt-injected model skip every confirmation
 *   is_admin_created             provisioning flag read by /setup
 *   migration_baseline_generation schema generation marker
 *   security_settings            2FA enforcement and similar
 */
const WRITE_PROTECTED_SITE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'cortex_ai_build_session',
  'is_admin_created',
  'migration_baseline_generation',
  'security_settings',
]);

/**
 * Shapes for the `site_settings` values Cortex is most likely to touch. The bag is
 * open-ended (unknown keys stay allowed), but a known key must carry the shape the
 * app reads, or the header, footer, or SEO metadata silently breaks.
 */
const SITE_SETTING_VALUE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  active_logo_id: z.string().uuid().nullable(),
  cortex_ai_site_brief: cortexSiteBriefSchema,
  footer_copyright: z.record(z.string().trim().min(2).max(12), z.string().max(500)),
  footer_show_attribution: z.boolean(),
  global_css: z.string().max(200000),
  onboarding_state: z.record(z.string(), z.unknown()),
  site_description: z.string().max(1000),
  site_keywords: z.string().max(1000),
  site_title: z.string().max(200),
};

function formatIssues(issues: Array<{ message: string; path: PropertyKey[] }>) {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function assertValidSiteSettingValue(key: string, value: unknown) {
  if (WRITE_PROTECTED_SITE_SETTING_KEYS.has(key)) {
    throw new Error(`The "${key}" site setting cannot be written through Cortex AI database tools.`);
  }

  const schema = SITE_SETTING_VALUE_SCHEMAS[key];

  if (!schema) {
    return;
  }

  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(`Invalid value for site setting "${key}": ${formatIssues(result.error.issues)}`);
  }
}

/**
 * Validate a `blocks.content` payload for its `block_type`: built-in types through
 * the injected app validator (or the mirrored schemas), custom slugs through their
 * definition's fields. Definitions are loaded once per call and only when needed.
 */
async function assertValidBlockRowContent(params: {
  blockType: unknown;
  content: unknown;
  context?: ToolExecutionContext;
  definitions: () => Promise<CustomBlockDefinitionLike[]>;
  label: string;
}) {
  const blockType = typeof params.blockType === 'string' ? params.blockType : '';

  if (!blockType) {
    throw new Error(`${params.label}: block_type is required.`);
  }

  if (!params.content || typeof params.content !== 'object' || Array.isArray(params.content)) {
    throw new Error(`${params.label}: content must be a JSON object.`);
  }

  const content = params.content as Record<string, unknown>;

  if (isValidBlockType(blockType)) {
    const result = validateCortexBlockContent(blockType, content, params.context);

    if (!result.isValid) {
      throw new Error(`${params.label}: content is invalid for block type "${blockType}": ${result.errors.join('; ')}`);
    }

    return;
  }

  const definition = (await params.definitions()).find((candidate) => candidate.slug === blockType);

  if (!definition) {
    throw new Error(
      `${params.label}: "${blockType}" is neither a built-in block type nor a custom block slug. Use list_custom_blocks to see the custom block definitions.`
    );
  }

  const result = validateCustomBlockInstanceContent(definition, content);

  if (!result.isValid) {
    throw new Error(`${params.label}: content is invalid for custom block "${blockType}": ${result.errors.join('; ')}`);
  }
}

/**
 * Content-aware checks that `validateMutationInput` cannot do synchronously:
 * `blocks.content` against its block type and known `site_settings` values against
 * their shape. Runs before the confirmation preview so a bad payload never earns a
 * confirmation phrase.
 */
async function validateMutationPayloads(
  input: z.infer<typeof executeDatabaseMutationInputSchema>,
  table: TableName,
  context?: ToolExecutionContext
) {
  if (table === 'site_settings') {
    for (const row of input.rows ?? []) {
      if (typeof row.key === 'string') {
        assertValidSiteSettingValue(row.key, row.value);
      }
    }

    if (input.operation === 'update' && input.values) {
      const keyFromValues = typeof input.values.key === 'string' ? input.values.key : null;
      const keyFromFilter = (input.filters ?? []).find(
        (filter) => filter.column === 'key' && filter.operator === 'eq' && typeof filter.value === 'string'
      );
      const key = keyFromValues ?? (keyFromFilter ? String(keyFromFilter.value) : null);

      if (key) {
        if ('value' in input.values) {
          assertValidSiteSettingValue(key, input.values.value);
        } else if (WRITE_PROTECTED_SITE_SETTING_KEYS.has(key)) {
          assertValidSiteSettingValue(key, undefined);
        }
      }
    }

    return;
  }

  if (table !== 'blocks') {
    return;
  }

  let cachedDefinitions: Promise<CustomBlockDefinitionLike[]> | null = null;
  const definitions = () => (cachedDefinitions ??= loadCustomBlockDefinitions(getSupabase(context)));

  if (input.operation === 'insert' || input.operation === 'upsert') {
    for (const [index, row] of (input.rows ?? []).entries()) {
      await assertValidBlockRowContent({
        blockType: row.block_type,
        content: row.content ?? {},
        context,
        definitions,
        label: `rows[${index}]`,
      });
    }

    return;
  }

  if (input.operation === 'update' && input.values) {
    const changesContent = 'content' in input.values;
    const changesType = 'block_type' in input.values;

    if (!changesContent && !changesType) {
      return;
    }

    if (changesType && !changesContent) {
      throw new Error('Changing block_type requires the new content for that type in the same update.');
    }

    // The new content must fit the type each target row will have after the update.
    const blockTypes = new Set<string>();

    if (changesType) {
      blockTypes.add(String(input.values.block_type));
    } else {
      let query = getSupabase(context).from('blocks').select('id, block_type').limit(MAX_MUTATION_TARGETS + 1);
      query = applyFilters(table, query, input.filters ?? []);
      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to read the blocks to update: ${serializeError(error)}`);
      }

      for (const row of (Array.isArray(data) ? data : []) as Array<{ block_type?: unknown }>) {
        blockTypes.add(String(row.block_type ?? ''));
      }
    }

    for (const blockType of blockTypes) {
      await assertValidBlockRowContent({
        blockType,
        content: input.values.content,
        context,
        definitions,
        label: `values (block_type "${blockType}")`,
      });
    }
  }
}

const tableConfigs = {
  blocks: {
    columns: ['id', 'page_id', 'post_id', 'language_id', 'block_type', 'content', 'order', 'created_at', 'updated_at'],
    description: 'CMS page/post content blocks.',
    primaryKey: ['id'],
  },
  coupon_freemius_mappings: {
    columns: [
      'id',
      'coupon_id',
      'product_id',
      'freemius_product_id',
      'freemius_coupon_id',
      'freemius_coupon_code',
      'sync_status',
      'sync_error',
      'remote_payload',
      'last_synced_at',
      'created_at',
      'updated_at',
    ],
    description: 'Freemius coupon sync mappings.',
    primaryKey: ['id'],
  },
  coupon_products: {
    columns: ['coupon_id', 'product_id', 'created_at'],
    description: 'Coupon product allow-list rows.',
    primaryKey: ['coupon_id', 'product_id'],
  },
  coupon_redemptions: {
    columns: [
      'id',
      'coupon_id',
      'order_id',
      'coupon_code',
      'provider',
      'discount_total',
      'user_id',
      'customer_email',
      'metadata',
      'redeemed_at',
    ],
    description: 'Coupon redemption records.',
    primaryKey: ['id'],
  },
  coupons: {
    columns: [
      'id',
      'code',
      'name',
      'internal_note',
      'provider_scope',
      'discount_type',
      'discount_amount',
      'is_active',
      'starts_at',
      'ends_at',
      'redemption_limit',
      'redemptions_count',
      'freemius_sync_status',
      'freemius_sync_error',
      'created_at',
      'updated_at',
    ],
    description: 'Commerce coupons.',
    primaryKey: ['id'],
  },
  cortex_ai_db_mutation_audit: {
    columns: [
      'id',
      'actor_user_id',
      'tool_name',
      'action_name',
      'target_tables',
      'operation_summary',
      'payload_hash',
      'payload',
      'preview',
      'status',
      'error_message',
      'created_at',
    ],
    description: 'Read-only Cortex AI database mutation audit trail.',
    primaryKey: ['id'],
    readOnly: true,
  },
  currencies: {
    columns: [
      'id',
      'code',
      'symbol',
      'exchange_rate',
      'is_default',
      'is_active',
      'rounding_mode',
      'rounding_increment',
      'rounding_charm_amount',
      'auto_update_exchange_rate',
      'exchange_rate_updated_at',
      'exchange_rate_source',
      'auto_sync_product_prices',
      'created_at',
      'updated_at',
    ],
    description: 'Storefront currencies and FX settings.',
    primaryKey: ['id'],
  },
  freemius_plans: {
    columns: ['id', 'product_id', 'name', 'title', 'created_at', 'updated_at'],
    description: 'Freemius plan metadata.',
    primaryKey: ['id'],
  },
  freemius_pricing: {
    columns: [
      'id',
      'plan_id',
      'api_monthly_price',
      'api_annual_price',
      'api_lifetime_price',
      'override_monthly_price',
      'override_annual_price',
      'override_lifetime_price',
      'license_quota',
      'is_active',
      'created_at',
      'updated_at',
    ],
    description: 'Freemius pricing metadata.',
    primaryKey: ['id'],
  },
  inventory_items: {
    columns: ['sku', 'quantity', 'created_at', 'updated_at'],
    description: 'Source-of-truth inventory by SKU.',
    primaryKey: ['sku'],
  },
  languages: {
    columns: ['id', 'code', 'name', 'is_default', 'is_active', 'created_at', 'updated_at'],
    description: 'CMS languages/locales.',
    primaryKey: ['id'],
  },
  logos: {
    columns: ['id', 'name', 'media_id', 'created_at'],
    description: 'Brand logos.',
    primaryKey: ['id'],
  },
  media: {
    columns: [
      'id',
      'uploader_id',
      'file_name',
      'object_key',
      'file_type',
      'size_bytes',
      'description',
      'width',
      'height',
      'blur_data_url',
      'variants',
      'file_path',
      'folder',
      'created_at',
      'updated_at',
    ],
    description: 'Media metadata for uploaded assets.',
    primaryKey: ['id'],
  },
  navigation_items: {
    columns: [
      'id',
      'language_id',
      'menu_key',
      'label',
      'url',
      'parent_id',
      'order',
      'page_id',
      'translation_group_id',
      'created_at',
      'updated_at',
    ],
    description: 'CMS navigation tree items.',
    primaryKey: ['id'],
  },
  order_items: {
    columns: ['id', 'order_id', 'product_id', 'variant_id', 'quantity', 'price_at_purchase'],
    description: 'Commerce order line items.',
    primaryKey: ['id'],
  },
  orders: {
    columns: [
      'id',
      'user_id',
      'status',
      'total',
      'stripe_session_id',
      'payment_intent_id',
      'customer_details',
      'provider',
      'freemius_product_id',
      'freemius_plan_id',
      'freemius_license_id',
      'freemius_subscription_id',
      'freemius_trial_id',
      'freemius_user_id',
      'freemius_trial_ends_at',
      'freemius_last_event_type',
      'freemius_last_synced_at',
      'currency',
      'subtotal',
      'shipping_total',
      'tax_total',
      'tax_details',
      'exchange_rate_at_purchase',
      'inventory_deducted_at',
      'invoice_number',
      'paid_at',
      'created_at',
      'coupon_id',
      'coupon_code',
      'discount_total',
      'discount_details',
    ],
    description: 'Commerce orders.',
    primaryKey: ['id'],
  },
  package_activations: {
    columns: ['id', 'license_key', 'instance_name', 'package_id', 'status', 'meta', 'last_validated_at', 'created_at'],
    description: 'NextBlock package activations.',
    primaryKey: ['id'],
  },
  page_revisions: {
    columns: ['id', 'page_id', 'author_id', 'version', 'revision_type', 'content', 'created_at'],
    description: 'Page revision history.',
    primaryKey: ['id'],
    // Revision history is an audit trail. The agent may read it, but letting it rewrite or
    // delete rows would let it erase the record of its own edits — and hand-written rows
    // would corrupt the snapshot/diff chain the restore path replays.
    readOnly: true,
  },
  pages: {
    columns: [
      'id',
      'language_id',
      'author_id',
      'title',
      'slug',
      'status',
      'meta_title',
      'meta_description',
      'feature_image_id',
      'version',
      'translation_group_id',
      'created_at',
      'updated_at',
    ],
    description: 'CMS pages.',
    primaryKey: ['id'],
  },
  post_revisions: {
    columns: ['id', 'post_id', 'author_id', 'version', 'revision_type', 'content', 'created_at'],
    description: 'Post revision history.',
    primaryKey: ['id'],
    // See page_revisions.
    readOnly: true,
  },
  product_revisions: {
    columns: ['id', 'product_id', 'author_id', 'version', 'revision_type', 'content', 'created_at'],
    description: 'Product revision history.',
    primaryKey: ['id'],
    // See page_revisions.
    readOnly: true,
  },
  posts: {
    columns: [
      'id',
      'language_id',
      'author_id',
      'title',
      'slug',
      'label',
      'excerpt',
      'subtitle',
      'status',
      'published_at',
      'meta_title',
      'meta_description',
      'feature_image_id',
      'version',
      'translation_group_id',
      'created_at',
      'updated_at',
    ],
    description: 'CMS posts/articles.',
    primaryKey: ['id'],
  },
  product_attribute_terms: {
    columns: ['id', 'attribute_id', 'value', 'slug', 'sort_order', 'value_translations', 'created_at', 'updated_at'],
    description: 'Product attribute terms.',
    primaryKey: ['id'],
  },
  product_attributes: {
    columns: ['id', 'name', 'slug', 'name_translations', 'created_at', 'updated_at'],
    description: 'Product attribute definitions.',
    primaryKey: ['id'],
  },
  product_media: {
    columns: ['product_id', 'media_id', 'sort_order'],
    description: 'Product media join rows.',
    primaryKey: ['product_id', 'media_id'],
  },
  product_variants: {
    columns: [
      'id',
      'product_id',
      'sku',
      'price_adjustment',
      'price',
      'prices',
      'sale_price',
      'sale_prices',
      'stock_quantity',
      'upc',
      'main_media_id',
      'created_at',
      'updated_at',
    ],
    description: 'Sellable product variants.',
    primaryKey: ['id'],
  },
  products: {
    columns: [
      'id',
      'language_id',
      'translation_group_id',
      'sku',
      'title',
      'slug',
      'product_type',
      'payment_provider',
      'price',
      'prices',
      'sale_price',
      'sale_prices',
      'stock',
      'status',
      'meta_title',
      'meta_description',
      'short_description',
      'description_json',
      'metadata',
      'freemius_plan_id',
      'freemius_product_id',
      'trial_period_days',
      'trial_requires_payment_method',
      'upc',
      'is_taxable',
      'created_at',
      'updated_at',
    ],
    description: 'Product catalog records.',
    primaryKey: ['id'],
  },
  profiles: {
    columns: ['id', 'updated_at', 'full_name', 'avatar_url', 'website', 'phone', 'role'],
    description: 'Read-only user profiles. Never mutate through Cortex AI.',
    primaryKey: ['id'],
    readOnly: true,
  },
  shipping_zone_locations: {
    columns: ['id', 'zone_id', 'country_code', 'state_code', 'postal_code', 'created_at'],
    description: 'Shipping zone location match rules.',
    primaryKey: ['id'],
  },
  shipping_zone_methods: {
    columns: [
      'id',
      'zone_id',
      'method_type',
      'cost_amount',
      'cost_currency',
      'min_order_amount',
      'name',
      'name_translations',
      'currency_pricing_mode',
      'cost_amounts',
      'min_order_amounts',
      'created_at',
      'updated_at',
    ],
    description: 'Shipping methods/rates.',
    primaryKey: ['id'],
  },
  shipping_zones: {
    columns: ['id', 'name', 'priority_order', 'created_at', 'updated_at'],
    description: 'Shipping zones.',
    primaryKey: ['id'],
  },
  site_settings: {
    columns: ['key', 'value'],
    description: 'Global site settings. Cortex AI API-key setting row is protected.',
    primaryKey: ['key'],
  },
  tax_rates: {
    columns: ['id', 'country_code', 'state_code', 'tax_name', 'tax_rate', 'created_at', 'updated_at'],
    description: 'Manual tax rates.',
    primaryKey: ['id'],
  },
  translations: {
    columns: ['key', 'translations', 'created_at', 'updated_at'],
    description: 'Shared translation strings.',
    primaryKey: ['key'],
  },
  user_addresses: {
    columns: [
      'id',
      'user_id',
      'address_type',
      'is_default',
      'recipient_name',
      'company_name',
      'line1',
      'line2',
      'city',
      'state',
      'postal_code',
      'country_code',
      'created_at',
      'updated_at',
    ],
    description: 'Read-only user addresses. Never mutate through Cortex AI.',
    primaryKey: ['id'],
    readOnly: true,
  },
  variant_attribute_mapping: {
    columns: ['variant_id', 'attribute_term_id'],
    description: 'Variant to attribute-term join rows.',
    primaryKey: ['variant_id', 'attribute_term_id'],
  },
} as const satisfies Record<string, TableConfig>;

type TableName = keyof typeof tableConfigs;
type DatabaseMutationOperation = 'delete' | 'insert' | 'update' | 'upsert';
type AuditWriteResult = {
  auditError?: string;
  auditLogged: boolean;
};

const filterOperatorSchema = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'in', 'is']);

const databaseFilterSchema = z.strictObject({
  column: z.string().trim().min(1).max(120),
  operator: filterOperatorSchema.default('eq'),
  value: z.unknown(),
});

const databaseOrderSchema = z.strictObject({
  ascending: z.boolean().default(true),
  column: z.string().trim().min(1).max(120),
});

export const describeDatabaseSchemaInputSchema = z.strictObject({
  includeReadOnly: z.boolean().default(true),
  table: z.string().trim().min(1).max(120).optional(),
});

export const readDatabaseRecordsInputSchema = z.strictObject({
  columns: z.array(z.string().trim().min(1).max(120)).min(1).max(40).optional(),
  filters: z.array(databaseFilterSchema).max(12).default([]),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).default(DEFAULT_READ_LIMIT),
  offset: z.number().int().min(0).max(10000).default(0),
  orderBy: databaseOrderSchema.optional(),
  table: z.string().trim().min(1).max(120),
});

export const executeDatabaseMutationInputSchema = z.strictObject({
  filters: z.array(databaseFilterSchema).max(12).optional(),
  operation: z.enum(['delete', 'insert', 'update', 'upsert']),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_MUTATION_ROWS).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  table: z.string().trim().min(1).max(120),
  values: z.record(z.string(), z.unknown()).optional(),
});

export const executeDatabaseActionPlanInputSchema = z.strictObject({
  actions: z.array(executeDatabaseMutationInputSchema).min(1).max(8),
  summary: z.string().trim().min(1).max(500).optional(),
});

export type ExecuteDatabaseMutationInput = z.input<typeof executeDatabaseMutationInputSchema>;
export type ExecuteDatabaseActionPlanInput = z.input<typeof executeDatabaseActionPlanInputSchema>;

function getSupabase(context?: ToolExecutionContext) {
  if (!context?.supabase) {
    throw new Error('Cortex AI database tools require a Supabase client.');
  }

  return context.supabase;
}

function serializeError(error: unknown) {
  if (!error) {
    return 'Unknown database error.';
  }

  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || 'Unknown database error.');
  }

  return String(error);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function hashPayload(value: unknown) {
  let hash = 0x811c9dc5;
  const serialized = stableStringify(value);

  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeConfirmationToken(value: string) {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

function buildConfirmationPhrase(action: string, subject: string, payload: unknown) {
  return `${normalizeConfirmationToken(`CONFIRM ${action} ${subject}`)} #${hashPayload(payload)}`;
}

function buildConfirmationPreview(params: {
  action: string;
  payload: unknown;
  preview: Record<string, unknown>;
  subject: string;
}) {
  return {
    confirmationPhrase: buildConfirmationPhrase(params.action, params.subject, params.payload),
    mutationExecuted: false,
    preview: params.preview,
    requiresConfirmation: true,
    success: true,
  };
}

function getConfirmationPreview(params: {
  action: string;
  context?: ToolExecutionContext;
  payload: unknown;
  preview: Record<string, unknown>;
  subject: string;
}) {
  if (params.context?.skipConfirmation) {
    return null;
  }

  const preview = buildConfirmationPreview(params);
  const latestUserMessage = normalizeConfirmationToken(params.context?.latestUserMessage || '');
  const expectedPhrase = normalizeConfirmationToken(preview.confirmationPhrase);

  if (latestUserMessage && !latestUserMessage.includes(expectedPhrase)) {
    return {
      ...preview,
      message: 'The database target changed or the confirmation did not match. Please review and confirm again.',
    };
  }

  return latestUserMessage.includes(expectedPhrase) ? null : preview;
}

function isTableName(value: string): value is TableName {
  return Object.prototype.hasOwnProperty.call(tableConfigs, value);
}

function normalizeTableName(value: string): TableName {
  const table = value.trim();

  if (table.includes('.') || table.toLowerCase().startsWith('auth')) {
    throw new Error('Cortex AI cannot access auth schema tables.');
  }

  if (!isTableName(table)) {
    throw new Error(`Table "${table}" is not available to Cortex AI database tools.`);
  }

  return table;
}

function getTableConfig(table: TableName): TableConfig {
  return tableConfigs[table];
}

function isSensitiveKey(key: string) {
  return /(?:password|token|secret|api[_-]?key|private[_-]?key|credential)/i.test(key);
}

function assertSafeColumn(table: TableName, column: string) {
  const config = getTableConfig(table);

  if (!(config.columns as readonly string[]).includes(column)) {
    throw new Error(`Column "${column}" is not available on table "${table}".`);
  }

  if (isSensitiveKey(column)) {
    throw new Error(`Column "${column}" is protected and cannot be used through Cortex AI.`);
  }
}

function assertNoSensitivePayload(value: unknown, path = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitivePayload(item, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      throw new Error(`Protected field "${path}.${key}" cannot be written through Cortex AI.`);
    }

    assertNoSensitivePayload(nestedValue, `${path}.${key}`);
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactValue(nestedValue);
  }

  return output;
}

function redactRows(rows: unknown[]) {
  return rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const key = (row as Record<string, unknown>).key;

      // Belt and braces: `applyFilters` already excludes the OpenRouter key at the
      // query level, but this catches every protected key regardless of how the row
      // was fetched.
      if (typeof key === 'string' && PROTECTED_SITE_SETTING_KEYS.has(key)) {
        return { key, value: REDACTED };
      }
    }

    return redactValue(row);
  });
}

function assertNoProtectedSiteSetting(table: TableName, input: unknown) {
  if (table !== 'site_settings') {
    return;
  }

  const serialized = JSON.stringify(input).toLowerCase();

  for (const protectedKey of PROTECTED_SITE_SETTING_KEYS) {
    if (serialized.includes(protectedKey)) {
      throw new Error(`The "${protectedKey}" site setting is protected.`);
    }
  }
}

function applyFilter(query: any, filter: z.infer<typeof databaseFilterSchema>) {
  switch (filter.operator) {
    case 'eq':
      return query.eq(filter.column, filter.value);
    case 'neq':
      return query.neq(filter.column, filter.value);
    case 'gt':
      return query.gt(filter.column, filter.value);
    case 'gte':
      return query.gte(filter.column, filter.value);
    case 'lt':
      return query.lt(filter.column, filter.value);
    case 'lte':
      return query.lte(filter.column, filter.value);
    case 'ilike':
      if (typeof filter.value !== 'string') {
        throw new Error(`Filter "${filter.column}" with ilike requires a string value.`);
      }
      return query.ilike(filter.column, filter.value);
    case 'in':
      if (!Array.isArray(filter.value)) {
        throw new Error(`Filter "${filter.column}" with in requires an array value.`);
      }
      return query.in(filter.column, filter.value);
    case 'is':
      return query.is(filter.column, filter.value);
  }
}

function applyFilters(table: TableName, query: any, filters: Array<z.infer<typeof databaseFilterSchema>>) {
  let nextQuery = query;

  for (const filter of filters) {
    assertSafeColumn(table, filter.column);
    nextQuery = applyFilter(nextQuery, filter);
  }

  if (table === 'site_settings') {
    nextQuery = nextQuery.neq('key', PROTECTED_CORTEX_KEY);
  }

  return nextQuery;
}

function selectColumns(table: TableName, columns?: string[]) {
  const config = getTableConfig(table);
  const selected = columns?.length ? columns : config.columns.filter((column) => !isSensitiveKey(column));

  selected.forEach((column) => assertSafeColumn(table, column));

  return selected.join(',');
}

function getTargetId(row: Record<string, unknown>, primaryKey: readonly string[]) {
  return primaryKey.map((column) => `${column}=${String(row[column] ?? '')}`).join('|');
}

async function fetchMutationTargets(
  supabase: SupabaseLike,
  table: TableName,
  filters: Array<z.infer<typeof databaseFilterSchema>>
) {
  const config = getTableConfig(table);
  let query = supabase
    .from(table)
    .select(config.primaryKey.join(','))
    .limit(MAX_MUTATION_TARGETS + 1);

  query = applyFilters(table, query, filters);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to preview database mutation: ${serializeError(error)}`);
  }

  const rows = Array.isArray(data) ? data : [];

  if (rows.length > MAX_MUTATION_TARGETS) {
    throw new Error(`Refusing to mutate more than ${MAX_MUTATION_TARGETS} rows.`);
  }

  return rows as Array<Record<string, unknown>>;
}

function validateMutationInput(input: z.infer<typeof executeDatabaseMutationInputSchema>) {
  const table = normalizeTableName(input.table);
  const config = getTableConfig(table);
  const operation = input.operation as DatabaseMutationOperation;

  if (config.readOnly) {
    throw new Error(`Table "${table}" is read-only for Cortex AI.`);
  }

  assertNoProtectedSiteSetting(table, input);

  if ((operation === 'update' || operation === 'delete') && (!input.filters || input.filters.length === 0)) {
    throw new Error(`${operation} operations require at least one filter.`);
  }

  if ((operation === 'insert' || operation === 'upsert') && (!input.rows || input.rows.length === 0)) {
    throw new Error(`${operation} operations require rows.`);
  }

  if (operation === 'update' && (!input.values || Object.keys(input.values).length === 0)) {
    throw new Error('update operations require values.');
  }

  if (input.rows && input.rows.length > MAX_MUTATION_ROWS) {
    throw new Error(`Refusing to mutate more than ${MAX_MUTATION_ROWS} input rows.`);
  }

  const payloads = input.rows ?? (input.values ? [input.values] : []);

  for (const payload of payloads) {
    assertNoSensitivePayload(payload);
    for (const column of Object.keys(payload)) {
      assertSafeColumn(table, column);
    }
  }

  for (const filter of input.filters ?? []) {
    assertSafeColumn(table, filter.column);
  }

  return table;
}

function buildMutationPreview(params: {
  input: z.infer<typeof executeDatabaseMutationInputSchema>;
  table: TableName;
  targetRows: Array<Record<string, unknown>>;
}) {
  const { input, table, targetRows } = params;
  const config = getTableConfig(table);
  const targetIds = targetRows.map((row) => getTargetId(row, config.primaryKey)).sort();
  const inputRowCount = input.rows?.length ?? 0;
  const affectedCount =
    input.operation === 'insert' || input.operation === 'upsert' ? inputRowCount : targetRows.length;
  const summary =
    input.summary ||
    `${input.operation} ${affectedCount} ${affectedCount === 1 ? 'row' : 'rows'} in ${table}.`;

  return {
    affectedCount,
    operation: input.operation,
    sampleTargetIds: targetIds.slice(0, 10),
    summary,
    table,
    targetIds,
  };
}

async function writeAudit(params: {
  context?: ToolExecutionContext;
  errorMessage?: string | null;
  input: unknown;
  preview: Record<string, unknown>;
  status: 'failure' | 'success';
  summary: string;
  targetTables: string[];
  toolName: string;
}): Promise<AuditWriteResult> {
  const actorUserId = params.context?.actorUserId;

  if (!actorUserId) {
    return { auditError: 'Missing actor user id.', auditLogged: false };
  }

  try {
    const { error } = await getSupabase(params.context)
      .from('cortex_ai_db_mutation_audit')
      .insert({
        action_name: params.toolName,
        actor_user_id: actorUserId,
        error_message: params.errorMessage ?? null,
        operation_summary: params.summary,
        payload: redactValue(params.input),
        payload_hash: hashPayload(params.input),
        preview: redactValue(params.preview),
        status: params.status,
        target_tables: params.targetTables,
        tool_name: params.toolName,
      });

    if (error) {
      return { auditError: serializeError(error), auditLogged: false };
    }

    return { auditLogged: true };
  } catch (error) {
    return { auditError: serializeError(error), auditLogged: false };
  }
}

async function executePreparedMutation(
  input: z.infer<typeof executeDatabaseMutationInputSchema>,
  table: TableName,
  supabase: SupabaseLike
) {
  const config = getTableConfig(table);
  const select = config.primaryKey.join(',');
  let query: any;

  if (input.operation === 'insert') {
    query = supabase.from(table).insert(input.rows).select(select);
  } else if (input.operation === 'upsert') {
    query = supabase.from(table).upsert(input.rows).select(select);
  } else if (input.operation === 'update') {
    query = supabase.from(table).update(input.values);
    query = applyFilters(table, query, input.filters ?? []);
    query = query.select(select);
  } else {
    query = supabase.from(table).delete();
    query = applyFilters(table, query, input.filters ?? []);
    query = query.select(select);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(serializeError(error));
  }

  return Array.isArray(data) ? data : [];
}

export async function executeDescribeDatabaseSchema(
  input: z.input<typeof describeDatabaseSchemaInputSchema>
) {
  const parsed = describeDatabaseSchemaInputSchema.parse(input);
  const tableNames = parsed.table ? [normalizeTableName(parsed.table)] : (Object.keys(tableConfigs) as TableName[]);
  const tables = tableNames
    .filter((table) => parsed.includeReadOnly || !getTableConfig(table).readOnly)
    .map((table) => {
      const config = getTableConfig(table);
      return {
        columns: config.columns.filter((column) => !isSensitiveKey(column)),
        description: config.description,
        primaryKey: config.primaryKey,
        readOnly: Boolean(config.readOnly),
        table,
      };
    });

  return {
    safetyNotes: [
      'Use read_database_records for reads and execute_database_mutation/action_plan for writes.',
      'No auth schema access, no arbitrary SQL, no password/secret/API-key fields.',
      'profiles, user_addresses, and cortex_ai_db_mutation_audit are read-only.',
      `Protected site_settings keys (never readable or writable): ${[...PROTECTED_SITE_SETTING_KEYS].sort().join(', ')}.`,
      `Write-protected site_settings keys (readable, never writable here): ${[...WRITE_PROTECTED_SITE_SETTING_KEYS].sort().join(', ')}.`,
      'blocks.content is validated against its block_type (built-in schema or custom block definition) before any insert, upsert, or update; prefer the typed content tools, which also normalize and record revisions.',
    ],
    success: true,
    tables,
  };
}

export async function executeReadDatabaseRecords(
  input: z.input<typeof readDatabaseRecordsInputSchema>,
  context?: ToolExecutionContext
) {
  const parsed = readDatabaseRecordsInputSchema.parse(input);
  const table = normalizeTableName(parsed.table);
  const columns = selectColumns(table, parsed.columns);
  let query = getSupabase(context)
    .from(table)
    .select(columns)
    .range(parsed.offset, parsed.offset + parsed.limit - 1);

  query = applyFilters(table, query, parsed.filters);

  if (parsed.orderBy) {
    assertSafeColumn(table, parsed.orderBy.column);
    query = query.order(parsed.orderBy.column, { ascending: parsed.orderBy.ascending });
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to read database records: ${serializeError(error)}`);
  }

  const rows = Array.isArray(data) ? data : [];

  return {
    columns: columns.split(','),
    limit: parsed.limit,
    offset: parsed.offset,
    rows: redactRows(rows),
    success: true,
    table,
  };
}

export async function executeDatabaseMutation(
  input: ExecuteDatabaseMutationInput,
  context?: ToolExecutionContext
) {
  const parsed = executeDatabaseMutationInputSchema.parse(input);
  const table = validateMutationInput(parsed);
  const supabase = getSupabase(context);
  await validateMutationPayloads(parsed, table, context);
  const targetRows =
    parsed.operation === 'update' || parsed.operation === 'delete'
      ? await fetchMutationTargets(supabase, table, parsed.filters ?? [])
      : [];
  const preview = buildMutationPreview({ input: parsed, table, targetRows });
  const confirmationPayload = {
    input: parsed,
    targetIds: preview.targetIds,
  };
  const confirmation = getConfirmationPreview({
    action: `DATABASE ${parsed.operation}`,
    context,
    payload: confirmationPayload,
    preview,
    subject: table,
  });

  if (confirmation) {
    return confirmation;
  }

  try {
    const rows = await executePreparedMutation(parsed, table, supabase);
    const audit: AuditWriteResult = context?.skipAudit
      ? { auditLogged: false }
      : await writeAudit({
          context,
          input: confirmationPayload,
          preview,
          status: 'success',
          summary: String(preview.summary),
          targetTables: [table],
          toolName: 'execute_database_mutation',
        });

    return {
      affectedCount: rows.length || preview.affectedCount,
      auditLogged: audit.auditLogged,
      ...(audit.auditError ? { auditError: audit.auditError } : {}),
      mutationExecuted: true,
      operation: parsed.operation,
      sampleTargetIds: rows
        .map((row: Record<string, unknown>) => getTargetId(row, getTableConfig(table).primaryKey))
        .slice(0, 10),
      success: true,
      summary: preview.summary,
      table,
    };
  } catch (error) {
    const message = serializeError(error);
    const audit: AuditWriteResult = context?.skipAudit
      ? { auditLogged: false }
      : await writeAudit({
          context,
          errorMessage: message,
          input: confirmationPayload,
          preview,
          status: 'failure',
          summary: String(preview.summary),
          targetTables: [table],
          toolName: 'execute_database_mutation',
        });

    return {
      auditLogged: audit.auditLogged,
      ...(audit.auditError ? { auditError: audit.auditError } : {}),
      message: `Database mutation failed: ${message}`,
      mutationExecuted: false,
      operation: parsed.operation,
      success: false,
      table,
    };
  }
}

export async function executeDatabaseActionPlan(
  input: ExecuteDatabaseActionPlanInput,
  context?: ToolExecutionContext
) {
  const parsed = executeDatabaseActionPlanInputSchema.parse(input);
  const prepared: Array<{
    input: z.infer<typeof executeDatabaseMutationInputSchema>;
    preview: ReturnType<typeof buildMutationPreview>;
    table: TableName;
  }> = [];

  for (const action of parsed.actions) {
    const table = validateMutationInput(action);
    await validateMutationPayloads(action, table, context);
    const targetRows =
      action.operation === 'update' || action.operation === 'delete'
        ? await fetchMutationTargets(getSupabase(context), table, action.filters ?? [])
        : [];
    prepared.push({
      input: action,
      preview: buildMutationPreview({ input: action, table, targetRows }),
      table,
    });
  }

  const actionSummaries = prepared.map(({ preview }) => String(preview.summary));
  const preview = {
    actionCount: prepared.length,
    actionSummaries,
    summary: parsed.summary || `Run ${prepared.length} confirmed database actions.`,
    tables: Array.from(new Set(prepared.map((action) => action.table))),
  };
  const confirmationPayload = prepared.map(({ input, preview: actionPreview, table }) => ({
    input,
    table,
    targetIds: actionPreview.targetIds,
  }));
  const confirmation = getConfirmationPreview({
    action: 'DATABASE ACTION PLAN',
    context,
    payload: confirmationPayload,
    preview,
    subject: `${prepared.length} actions`,
  });

  if (confirmation) {
    return confirmation;
  }

  const results: unknown[] = [];
  let mutationExecuted = false;

  for (const [index, action] of prepared.entries()) {
    const result = await executeDatabaseMutation(action.input, {
      ...context,
      skipAudit: true,
      skipConfirmation: true,
    });

    results.push(result);

    if (result && typeof result === 'object' && (result as any).mutationExecuted === true) {
      mutationExecuted = true;
    }

    if (!result || typeof result !== 'object' || (result as any).success === false) {
      const audit = await writeAudit({
        context,
        errorMessage:
          result && typeof result === 'object' && typeof (result as any).message === 'string'
            ? (result as any).message
            : `Database action ${index + 1} failed.`,
        input: confirmationPayload,
        preview,
        status: 'failure',
        summary: String(preview.summary),
        targetTables: preview.tables,
        toolName: 'execute_database_action_plan',
      });

      return {
        actionCount: prepared.length,
        auditLogged: audit.auditLogged,
        ...(audit.auditError ? { auditError: audit.auditError } : {}),
        failedActionIndex: index,
        message:
          result && typeof result === 'object' && typeof (result as any).message === 'string'
            ? (result as any).message
            : `Database action ${index + 1} failed.`,
        mutationExecuted,
        results,
        success: false,
      };
    }
  }

  const audit = await writeAudit({
    context,
    input: confirmationPayload,
    preview,
    status: 'success',
    summary: String(preview.summary),
    targetTables: preview.tables,
    toolName: 'execute_database_action_plan',
  });

  return {
    actionCount: prepared.length,
    auditLogged: audit.auditLogged,
    ...(audit.auditError ? { auditError: audit.auditError } : {}),
    mutationExecuted,
    results,
    success: true,
    summary: parsed.summary ?? null,
  };
}

export function createCortexDatabaseAgentTools(context?: ToolExecutionContext) {
  return {
    describe_database_schema: tool({
      description:
        'Describe the public database tables Cortex AI can read or mutate, including read-only tables, primary keys, and writable columns. Use before broad database tasks when unsure about schema.',
      execute: (input) => executeDescribeDatabaseSchema(input),
      inputSchema: describeDatabaseSchemaInputSchema,
      strict: true,
    }),
    execute_database_action_plan: tool({
      description:
        'Execute up to 8 typed database mutations as one confirmed plan. Mutating: first returns one combined confirmation preview and Confirm button; after confirmation, runs each action in order and stops on the first failure.',
      execute: (input) => executeDatabaseActionPlan(input, context),
      inputSchema: executeDatabaseActionPlanInputSchema,
      strict: true,
    }),
    execute_database_mutation: tool({
      description:
        'Run one typed insert, update, upsert, or delete against an allowed public database table. Mutating: always previews affected rows and requires exact user confirmation before execution. Does not support arbitrary SQL.',
      execute: (input) => executeDatabaseMutation(input, context),
      inputSchema: executeDatabaseMutationInputSchema,
      strict: true,
    }),
    read_database_records: tool({
      description:
        'Read records from an allowed public database table with validated columns, filters, ordering, limit, and offset. Read-only and redacts protected secret-like values.',
      execute: (input) => executeReadDatabaseRecords(input, context),
      inputSchema: readDatabaseRecordsInputSchema,
      strict: true,
    }),
  };
}
