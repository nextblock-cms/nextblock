// Imported statically, not with a lazy require(): Vite 8 (Rolldown) emits a lazy
// require('next/cache') in the published ESM as a __require shim that bundlers cannot
// analyse, so it never resolved in scaffolds and revalidation silently did nothing.
// Importing next/cache is safe outside a request scope; only calling it needs one. Every
// caller runs inside a route handler, and tests inject their own revalidatePath.
import { revalidatePath as nextRevalidatePath, revalidateTag as nextRevalidateTag } from 'next/cache';
import { tool } from 'ai';

import { z } from './zod-config';

// The widget-builder pipeline (and its heavier zod/AI deps) is imported lazily
// inside the execute functions so that merely importing this tools module stays
// light — important because the custom-block schema helpers are only needed when
// a custom block mutation actually runs.

// Custom block definitions are GLOBAL (a reusable block library), not scoped to a
// page/post/product. These tools let Cortex AI create/edit/delete them directly,
// reusing the constrained-decoding widget builder so the agent never has to
// hand-author a recursive layout tree.

type CustomBlockToolContext = {
  actorUserId?: string | null;
  cortexAiApiKey?: string | null;
  cortexAiModelSelection?: unknown;
  latestUserMessage?: string | null;
  skipConfirmation?: boolean;
  supabase?: { from: (table: string) => any };
};

const CUSTOM_BLOCK_SELECT = 'id, slug, name, description, fields, layout_schema, is_original';

export const createCustomBlockInputSchema = z.strictObject({
  context: z
    .string()
    .trim()
    .max(3000)
    .optional()
    .describe('Optional extra constraints or brand/style guidance for the generated block.'),
  prompt: z
    .string()
    .trim()
    .min(3)
    .max(4000)
    .describe(
      'Natural-language description of the custom block, including the fields it needs and the visual style. Example: "A product card with a title, image, price, and a button that links to the product page."'
    ),
});

export const updateCustomBlockInputSchema = z.strictObject({
  prompt: z
    .string()
    .trim()
    .min(3)
    .max(4000)
    .describe('Description of the changes to apply. The block is regenerated using its existing definition as context.'),
  slug: z.string().trim().min(1).max(120).describe('Slug of the existing custom block to edit.'),
});

export const deleteCustomBlockInputSchema = z.strictObject({
  slug: z.string().trim().min(1).max(120).describe('Slug of the custom block definition to delete.'),
});

export const listCustomBlocksInputSchema = z.strictObject({
  query: z.string().trim().max(120).optional().describe('Optional text filter on name or slug.'),
});

function requireSupabase(context?: CustomBlockToolContext) {
  if (!context?.supabase) {
    throw new Error('A Supabase service client is required to manage custom block definitions.');
  }
  return context.supabase;
}

function requireActor(context?: CustomBlockToolContext) {
  if (!context?.actorUserId) {
    throw new Error('Managing custom block definitions requires an authenticated admin actor.');
  }
  return context.actorUserId;
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function summarizeDefinition(definition: any) {
  const fields = Array.isArray(definition?.fields) ? definition.fields : [];
  return {
    fieldCount: fields.length,
    fields: fields.map((field: any) => ({ key: field?.key, label: field?.label, type: field?.type })),
    id: definition?.id,
    name: definition?.name,
    slug: definition?.slug,
  };
}

/** Keep the regeneration context inside `cortexWidgetBuildRequestSchema`'s bound. */
const MAX_EXISTING_DEFINITION_CONTEXT = 24000;

/**
 * Describe the block being edited to the generator.
 *
 * The layout schema is the bulky part, and it is also the part the model can
 * reconstruct from the field list and the edit prompt. So when the full definition
 * would overflow the context bound, drop the layout and keep the fields — a
 * regenerated layout is a far better outcome than a hard validation failure, which
 * is what an oversized definition used to produce.
 */
function buildExistingDefinitionContext(existing: {
  fields?: unknown;
  layout_schema?: unknown;
  name?: string | null;
}): string {
  const preamble = `You are editing an existing custom block named "${existing.name ?? 'Untitled'}". Keep its overall purpose and only apply the requested changes.`;
  const full = `${preamble} Existing definition: ${JSON.stringify({
    fields: existing.fields,
    layout_schema: existing.layout_schema,
    name: existing.name,
  })}`;

  if (full.length <= MAX_EXISTING_DEFINITION_CONTEXT) {
    return full;
  }

  const withoutLayout = `${preamble} Existing fields: ${JSON.stringify({
    fields: existing.fields,
    name: existing.name,
  })} (The existing layout was too large to include — rebuild a layout that renders these fields.)`;

  return withoutLayout.slice(0, MAX_EXISTING_DEFINITION_CONTEXT);
}

function buildWidgetGenerationParams(input: { prompt: string; context?: string }, context?: CustomBlockToolContext) {
  const apiKey = context?.cortexAiApiKey || undefined;
  return {
    apiKey,
    context: input.context,
    modelSelection: apiKey && context?.cortexAiModelSelection ? (context.cortexAiModelSelection as any) : undefined,
    prompt: input.prompt,
  };
}

function revalidateCustomBlockCaches(definition?: { id?: string; slug?: string } | null) {
  try {
    const revalidatePath = nextRevalidatePath;
    const revalidateTag = nextRevalidateTag;
    revalidateTag('custom-block-definitions', 'max');
    if (definition?.id) revalidateTag(`custom-block-definitions:${definition.id}`, 'max');
    if (definition?.slug) revalidateTag(`custom-block-definitions:${definition.slug}`, 'max');
    revalidateTag('dynamic-layout-engine', 'max');
    revalidatePath('/cms/custom-blocks');
    revalidatePath('/cms/blocks');
  } catch {
    // Revalidation is best-effort; the 60s definition cache still refreshes.
  }
}

function normalizeConfirmation(value: string | null | undefined) {
  return (value || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function buildDeleteConfirmationPhrase(slug: string) {
  return `CONFIRM DELETE CUSTOM BLOCK ${slug.toUpperCase()}`;
}

function isDeleteConfirmed(context: CustomBlockToolContext | undefined, phrase: string) {
  if (context?.skipConfirmation) {
    return true;
  }
  return normalizeConfirmation(context?.latestUserMessage).includes(normalizeConfirmation(phrase));
}

function serializeError(error: unknown) {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: string; message?: string };
    if (candidate.code === '23505') {
      return 'A custom block with that slug already exists. Choose a different name or edit the existing one.';
    }
    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error.';
}

export async function executeCreateCustomBlock(
  input: z.infer<typeof createCustomBlockInputSchema>,
  context?: CustomBlockToolContext
) {
  try {
    const supabase = requireSupabase(context);
    requireActor(context);

    const [{ generateCortexWidgetDefinition }, { insertCortexWidgetDefinition }] = await Promise.all([
      import('./ai-cortex-widget-builder'),
      import('./cortex-widget-registry'),
    ]);

    const generation = await generateCortexWidgetDefinition(buildWidgetGenerationParams(input, context));
    const definition = await insertCortexWidgetDefinition(supabase as any, generation.definition);

    revalidateCustomBlockCaches(definition);

    return {
      definition: summarizeDefinition(definition),
      editUrl: `/cms/custom-blocks/${definition.id}/edit`,
      mutationExecuted: true,
      success: true,
    };
  } catch (error) {
    return { mutationExecuted: false, message: serializeError(error), success: false };
  }
}

export async function executeUpdateCustomBlock(
  input: z.infer<typeof updateCustomBlockInputSchema>,
  context?: CustomBlockToolContext
) {
  try {
    const supabase = requireSupabase(context);
    requireActor(context);

    const { data: existing } = await supabase
      .from('custom_block_definitions')
      .select(CUSTOM_BLOCK_SELECT)
      .eq('slug', input.slug)
      .maybeSingle();

    if (!existing) {
      return { mutationExecuted: false, message: `No custom block found with slug "${input.slug}".`, success: false };
    }

    const [{ generateCortexWidgetDefinition }, { customBlockDefinitionCreateSchema }] = await Promise.all([
      import('./ai-cortex-widget-builder'),
      import('@nextblock-cms/utils/custom-blocks'),
    ]);

    const generation = await generateCortexWidgetDefinition(
      buildWidgetGenerationParams(
        {
          context: buildExistingDefinitionContext(existing),
          prompt: input.prompt,
        },
        context
      )
    );

    // Preserve the existing slug + provenance so placed instances keep resolving.
    const parsed = customBlockDefinitionCreateSchema.parse({
      ...generation.definition,
      is_original: existing.is_original,
      slug: existing.slug,
    });

    const { data, error } = await supabase
      .from('custom_block_definitions')
      .update({
        description: parsed.description,
        fields: toJson(parsed.fields),
        layout_schema: toJson(parsed.layout_schema),
        name: parsed.name,
      })
      .eq('id', existing.id)
      .select(CUSTOM_BLOCK_SELECT)
      .single();

    if (error || !data) {
      return { mutationExecuted: false, message: error?.message ?? 'Failed to update custom block.', success: false };
    }

    revalidateCustomBlockCaches(data);

    return {
      definition: summarizeDefinition(data),
      editUrl: `/cms/custom-blocks/${existing.id}/edit`,
      mutationExecuted: true,
      success: true,
    };
  } catch (error) {
    return { mutationExecuted: false, message: serializeError(error), success: false };
  }
}

export async function executeDeleteCustomBlock(
  input: z.infer<typeof deleteCustomBlockInputSchema>,
  context?: CustomBlockToolContext
) {
  try {
    const supabase = requireSupabase(context);
    requireActor(context);

    const { data: existing } = await supabase
      .from('custom_block_definitions')
      .select('id, slug, name')
      .eq('slug', input.slug)
      .maybeSingle();

    if (!existing) {
      return { mutationExecuted: false, message: `No custom block found with slug "${input.slug}".`, success: false };
    }

    const confirmationPhrase = buildDeleteConfirmationPhrase(existing.slug);

    if (!isDeleteConfirmed(context, confirmationPhrase)) {
      return {
        confirmationPhrase,
        mutationExecuted: false,
        preview: {
          summary: `Delete the custom block "${existing.name}" (${existing.slug}). Pages still using it will stop rendering it until replaced. This cannot be undone.`,
        },
        requiresConfirmation: true,
        success: true,
      };
    }

    const { error } = await supabase.from('custom_block_definitions').delete().eq('id', existing.id);

    if (error) {
      return { mutationExecuted: false, message: `Failed to delete custom block: ${error.message}`, success: false };
    }

    revalidateCustomBlockCaches(existing);

    return {
      deleted: { name: existing.name, slug: existing.slug },
      mutationExecuted: true,
      success: true,
    };
  } catch (error) {
    return { mutationExecuted: false, message: serializeError(error), success: false };
  }
}

export async function executeListCustomBlocks(
  input: z.infer<typeof listCustomBlocksInputSchema>,
  context?: CustomBlockToolContext
) {
  try {
    const supabase = requireSupabase(context);

    const { data, error } = await supabase
      .from('custom_block_definitions')
      .select('id, slug, name, description, fields, is_original')
      .order('name', { ascending: true });

    if (error) {
      return { message: error.message, success: false };
    }

    let blocks = Array.isArray(data) ? data : [];
    if (input.query) {
      const needle = input.query.toLowerCase();
      blocks = blocks.filter(
        (definition: any) =>
          String(definition.name || '').toLowerCase().includes(needle) ||
          String(definition.slug || '').toLowerCase().includes(needle)
      );
    }

    return {
      blocks: blocks.map((definition: any) => summarizeDefinition(definition)),
      count: blocks.length,
      success: true,
    };
  } catch (error) {
    return { message: serializeError(error), success: false };
  }
}

export function createCortexCustomBlockTools(context?: CustomBlockToolContext) {
  return {
    create_custom_block: tool({
      description:
        'Create a brand-new reusable custom block definition from a natural-language description (for example "a product card with title, image, price, and a button linking to the product page"). This is a GLOBAL block-library builder and does NOT require an open page, post, or product. It generates the field schema and Tailwind layout and saves it so the block can be added to any page afterward. Additive and reversible; executes immediately without a confirmation phrase.',
      execute: (input) => executeCreateCustomBlock(input, context),
      inputSchema: createCustomBlockInputSchema,
      strict: true,
    }),
    delete_custom_block: tool({
      description:
        'Delete a custom block definition by slug. Mutating: first returns a confirmation phrase; only executes after the user replies with the exact phrase. Use list_custom_blocks first if you are unsure of the slug.',
      execute: (input) => executeDeleteCustomBlock(input, context),
      inputSchema: deleteCustomBlockInputSchema,
      strict: true,
    }),
    list_custom_blocks: tool({
      description:
        'List the existing custom block definitions (slug, name, and fields). Read-only and does not require page context. Use it to find the slug of a block to edit or delete.',
      execute: (input) => executeListCustomBlocks(input, context),
      inputSchema: listCustomBlocksInputSchema,
      strict: true,
    }),
    update_custom_block: tool({
      description:
        'Edit an existing custom block definition (identified by slug) from a new natural-language description. The block is regenerated with its current definition as context and keeps its slug so existing placements keep working. Executes immediately.',
      execute: (input) => executeUpdateCustomBlock(input, context),
      inputSchema: updateCustomBlockInputSchema,
      strict: true,
    }),
  };
}
