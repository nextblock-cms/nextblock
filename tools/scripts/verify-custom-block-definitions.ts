/* eslint-disable @nx/enforce-module-boundaries */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

import type { Database, Json } from '@nextblock-cms/db';
import {
  buildCustomBlockCopySlug,
  customBlockDefinitionCreateSchema,
  customBlockDefinitionRowSchema,
  type CustomBlockDefinition,
} from '../../schemas/custom-blocks';

dotenv.config({ path: '.env.local' });

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

const testimonialCardInput = {
  description:
    'Intricate customer testimonial card with quote copy, R2 portrait media, author metadata, and a live customer relation.',
  fields: [
    {
      key: 'quote',
      label: 'Quote',
      required: true,
      type: 'rich-text',
    },
    {
      key: 'portrait',
      label: 'Portrait',
      required: true,
      type: 'image_r2',
    },
    {
      key: 'author_name',
      label: 'Author Name',
      required: true,
      type: 'text',
    },
    {
      display_column: 'full_name',
      key: 'customer',
      label: 'Customer',
      table: 'profiles',
      type: 'db_relation',
      value_column: 'id',
    },
  ],
  layout_schema: {
    children: [
      {
        as: 'figure',
        children: [
          {
            as: 'blockquote',
            className: 'text-lg font-medium leading-8 text-slate-900',
            field_key: 'quote',
            type: 'field_render',
          },
          {
            as: 'div',
            children: [
              {
                as: 'img',
                className: 'h-14 w-14 rounded-full object-cover',
                field_key: 'portrait',
                type: 'field_render',
              },
              {
                as: 'p',
                className: 'text-sm font-semibold text-slate-950',
                field_key: 'author_name',
                type: 'field_render',
              },
              {
                as: 'span',
                className: 'text-xs text-slate-500',
                field_key: 'customer',
                type: 'field_render',
              },
            ],
            className: 'mt-6 flex items-center gap-4',
            type: 'container',
          },
        ],
        className: 'rounded-lg border border-slate-200 bg-white p-6 shadow-sm',
        type: 'container',
      },
    ],
    className: 'mx-auto max-w-xl',
    type: 'container',
  },
  name: 'Intricate Testimonial Card',
  slug: 'intricate-testimonial-card',
};

function createMockRecord(id: string, input: unknown): CustomBlockDefinition {
  const { id: _ignoredId, ...definitionInput } =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : { id: undefined };

  void _ignoredId;

  return customBlockDefinitionRowSchema.parse({
    ...customBlockDefinitionCreateSchema.parse(definitionInput),
    id,
  });
}

async function runDryRun() {
  const inserted = createMockRecord('11111111-1111-4111-8111-111111111111', testimonialCardInput);
  const duplicateSlug = buildCustomBlockCopySlug(inserted.slug, [inserted.slug]);
  const duplicated = createMockRecord('22222222-2222-4222-8222-222222222222', {
    ...inserted,
    is_original: false,
    name: `${inserted.name} Copy`,
    slug: duplicateSlug,
  });

  console.log('Custom block definition verification dry run succeeded.');
  console.log(JSON.stringify({ duplicated, inserted, mode: 'dry-run' }, null, 2));
}

async function runLive() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --live.');
  }

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const input = customBlockDefinitionCreateSchema.parse({
    ...testimonialCardInput,
    slug: `${testimonialCardInput.slug}-${suffix}`,
  });

  const { data: inserted, error: insertError } = await supabase
    .from('custom_block_definitions')
    .insert({
      description: input.description,
      fields: toJson(input.fields),
      is_original: input.is_original,
      layout_schema: toJson(input.layout_schema),
      name: input.name,
      slug: input.slug,
    })
    .select('id, slug, name, description, fields, layout_schema, is_original')
    .single();

  if (insertError || !inserted) {
    throw new Error(`Insert failed: ${insertError?.message ?? 'No row returned.'}`);
  }

  const { data: duplicated, error: duplicateError } = await supabase.rpc('duplicate_block_definition', {
    target_id: inserted.id,
  });

  if (duplicateError || !duplicated) {
    throw new Error(`Duplicate failed: ${duplicateError?.message ?? 'No row returned.'}`);
  }

  console.log('Custom block definition live verification succeeded.');
  console.log(
    JSON.stringify(
      {
        duplicated: customBlockDefinitionRowSchema.parse(duplicated),
        inserted: customBlockDefinitionRowSchema.parse(inserted),
        mode: 'live',
      },
      null,
      2
    )
  );
}

const live = process.argv.includes('--live');

(live ? runLive() : runDryRun()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
