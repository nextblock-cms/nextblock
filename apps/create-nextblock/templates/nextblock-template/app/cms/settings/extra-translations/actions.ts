'use server';

import { createClient } from '@nextblock-cms/db/server';
import { revalidatePath, updateTag } from 'next/cache';
import { z } from '../../../../lib/zod-config';
import { readAllTranslationRows } from '../../../../lib/i18n/translation-pages';

import {
  getOrderedTranslationLanguageCodes,
  prepareTranslationCsvImport,
  type TranslationWorkspaceItem,
} from '@nextblock-cms/utils';

const translationSchema = z.object({
  key: z.string().min(1, 'Key is required.'),
  en: z.string().min(1, 'English translation is required.'),
});

const EXTRA_TRANSLATIONS_PATH = '/cms/settings/extra-translations';
const PUBLIC_TRANSLATIONS_CACHE_TAG = 'public-layout-translations';

type TranslationMutationState = {
  success?: boolean;
  translation?: TranslationWorkspaceItem;
  error?: string;
  errors?: Record<string, string[] | undefined>;
};

async function verifyAdmin(supabase: ReturnType<typeof createClient>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return false;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  return profile?.role === 'ADMIN';
}

async function getConfiguredLanguageCodes() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('languages')
    .select('code, name')
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch languages: ${error.message}`);
  }

  return getOrderedTranslationLanguageCodes(data ?? []);
}

function revalidateTranslationViews() {
  revalidatePath(EXTRA_TRANSLATIONS_PATH);
  updateTag(PUBLIC_TRANSLATIONS_CACHE_TAG);
}

export async function createTranslation(
  prevState: TranslationMutationState | null,
  formData: FormData
): Promise<TranslationMutationState> {
  void prevState;

  const supabase = createClient();

  if (!(await verifyAdmin(supabase))) {
    return { error: 'Unauthorized: Admin role required.' };
  }

  const data = {
    key: formData.get('key') as string,
    en: formData.get('en') as string,
  };

  const validatedFields = translationSchema.safeParse(data);

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
    };
  }

  const { data: insertedTranslation, error } = await supabase
    .from('translations')
    .insert({
      key: validatedFields.data.key,
      translations: { en: validatedFields.data.en },
    })
    .select('key, translations, created_at, updated_at')
    .single();

  if (error || !insertedTranslation) {
    return {
      error: error?.message ?? 'Failed to create translation.',
    };
  }

  revalidateTranslationViews();

  return {
    success: true,
    translation: insertedTranslation as TranslationWorkspaceItem,
  };
}

/**
 * Every row of the table, page by page: PostgREST returns at most 1000 rows per request and the
 * table is past that since 02031, so a single read hid the last keys from this screen and made a
 * CSV import treat them as new rows. All or nothing (lib/i18n/translation-pages.ts).
 */
async function readAllTranslations(supabase: ReturnType<typeof createClient>) {
  return readAllTranslationRows((from, to) =>
    supabase
      .from('translations')
      .select('key, translations, created_at, updated_at')
      .order('key')
      .range(from, to)
  );
}

export async function getTranslations() {
  const supabase = createClient();
  const { data, error } = await readAllTranslations(supabase);

  if (error) {
    console.error('Error fetching translations:', error);
    return [];
  }

  return data as TranslationWorkspaceItem[];
}

export async function updateTranslation(
  prevState: TranslationMutationState | null,
  formData: FormData
): Promise<TranslationMutationState> {
  void prevState;

  const supabase = createClient();

  if (!(await verifyAdmin(supabase))) {
    return { error: 'Unauthorized: Admin role required.' };
  }

  const data = Object.fromEntries(formData.entries());
  const key = data.key as string;

  if (!key) {
    return {
      error: 'Translation key is required.',
    };
  }

  const languageEntries = Object.entries(data).filter(
    ([fieldKey]) => fieldKey !== 'key'
  );

  if (languageEntries.length === 0) {
    return {
      error: 'No translation values were provided.',
    };
  }

  const { data: existingData, error: fetchError } = await supabase
    .from('translations')
    .select('key, translations, created_at, updated_at')
    .eq('key', key)
    .single();

  if (fetchError || !existingData) {
    return {
      error: fetchError
        ? `Failed to fetch existing translation: ${fetchError.message}`
        : `Translation with key "${key}" was not found.`,
    };
  }

  const nextTranslations = {
    ...((existingData.translations as Record<string, string>) ?? {}),
  };

  for (const [languageCode, value] of languageEntries) {
    nextTranslations[languageCode] = value as string;
  }

  const { data: updatedTranslation, error } = await supabase
    .from('translations')
    .update({ translations: nextTranslations })
    .eq('key', key)
    .select('key, translations, created_at, updated_at')
    .single();

  if (error || !updatedTranslation) {
    return {
      error:
        error?.message ??
        `Translation with key "${key}" could not be updated.`,
    };
  }

  revalidateTranslationViews();

  return {
    success: true,
    translation: updatedTranslation as TranslationWorkspaceItem,
  };
}

export async function importTranslationsCsvAction(csvText: string) {
  try {
    const supabase = createClient();

    if (!(await verifyAdmin(supabase))) {
      return {
        success: false as const,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        error: 'Unauthorized: Admin role required.',
      };
    }

    const [existingTranslations, languageCodes] = await Promise.all([
      readAllTranslations(supabase),
      getConfiguredLanguageCodes(),
    ]);

    // The merge needs the whole table: a key the read missed would be imported as a new row,
    // and its upsert would replace that row's other languages.
    if (existingTranslations.error) {
      return {
        success: false as const,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        error: `Failed to read the existing translations: ${existingTranslations.error.message}`,
      };
    }

    const importResult = prepareTranslationCsvImport({
      csvText,
      existingItems: existingTranslations.data as TranslationWorkspaceItem[],
      languageCodes,
    });

    if (!importResult.success) {
      return importResult;
    }

    const rowsToUpsert = [
      ...importResult.createdRows,
      ...importResult.updatedRows,
    ].map((row) => ({
      key: row.key,
      translations: row.translations,
    }));

    if (rowsToUpsert.length > 0) {
      const { error } = await supabase
        .from('translations')
        .upsert(rowsToUpsert, { onConflict: 'key' });

      if (error) {
        return {
          success: false as const,
          createdCount: 0,
          updatedCount: 0,
          skippedCount: importResult.skippedCount,
          error: error.message,
        };
      }
    }

    revalidateTranslationViews();

    return {
      success: true as const,
      createdCount: importResult.createdCount,
      updatedCount: importResult.updatedCount,
      skippedCount: importResult.skippedCount,
      translations: await getTranslations(),
    };
  } catch (error) {
    return {
      success: false as const,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      error:
        error instanceof Error ? error.message : 'Failed to import translation CSV.',
    };
  }
}
