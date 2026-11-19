/* eslint-disable @nx/enforce-module-boundaries */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { toJSONSchema } from 'zod';
import {
  editorBlockDocumentSchema,
  editorGeneratedBlockDocumentSchema,
  getEditorBlocksJsonSchema,
} from '../../libs/utils/src/lib/editor-blocks';

dotenv.config({ path: '.env.local' });

const seededProductDescriptionSample = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Studio uniform for shipping days' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The NextBlock Studio Tee is cut from premium heavyweight cotton.',
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Heavyweight cotton feel.' }],
            },
          ],
        },
      ],
    },
  ],
};

async function readDatabaseSample() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from('products')
    .select('id, slug, description_json')
    .not('description_json', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read product description_json sample: ${error.message}`);
  }

  return data;
}

async function main() {
  if (process.argv.includes('--generated-schema-diagnostics')) {
    const jsonSchema = toJSONSchema(editorGeneratedBlockDocumentSchema, {
      cycles: 'ref',
      reused: 'ref',
      target: 'draft-07',
    });
    const schemaText = JSON.stringify(jsonSchema);
    console.log(`Generated schema propertyNames occurrences=${schemaText.match(/propertyNames/g)?.length || 0}`);
    console.log(`Generated schema size=${schemaText.length}`);
    const propertyNamesIndex = schemaText.indexOf('propertyNames');
    if (propertyNamesIndex >= 0) {
      console.log(schemaText.slice(Math.max(0, propertyNamesIndex - 240), propertyNamesIndex + 240));
    }
    return;
  }

  const databaseSample = await readDatabaseSample();
  const sample = databaseSample?.description_json || seededProductDescriptionSample;
  const parsed = editorBlockDocumentSchema.parse(sample);
  const jsonSchema = getEditorBlocksJsonSchema();

  console.log('Editor block schema validation succeeded.');
  console.log(
    databaseSample
      ? `Sample source=products.description_json slug=${databaseSample.slug}`
      : 'Sample source=seeded product description fallback'
  );
  console.log(`Root type=${parsed.type}`);
  console.log(`Top-level blocks=${parsed.content?.length || 0}`);
  console.log(`JSON Schema keys=${Object.keys(jsonSchema as Record<string, unknown>).join(',')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
