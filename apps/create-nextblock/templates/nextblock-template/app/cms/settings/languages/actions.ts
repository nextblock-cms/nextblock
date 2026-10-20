// app/cms/settings/languages/actions.ts
"use server";

import { createClient, getServiceRoleSupabaseClient } from "@nextblock-cms/db/server";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import type { Database, Json } from "@nextblock-cms/db";
import {
  LANGUAGE_DETECTION_SETTING_KEY,
  LANGUAGE_DETECTION_CACHE_TAG,
  normalizeLanguageDetectionSettings,
  type LanguageDetectionSettings,
} from "../../../../lib/i18n/detection";

type Language = Database["public"]["Tables"]["languages"]["Row"];

// Helper to check admin role
async function verifyAdmin(supabase: ReturnType<typeof createClient>): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return profile?.role === "ADMIN";
}

export async function getLanguages(): Promise<{ data: Language[] | null; error: string | null; }> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("languages")
    .select("id, code, name, is_default, is_active, created_at, updated_at")
    .order("is_default", { ascending: false }) // Default first
    .order("name", { ascending: true });

  if (error) {
    console.error("Error fetching languages:", error);
    return { data: null, error: `Failed to fetch languages: ${error.message}` };
  }
  return { data, error: null };
}
export async function getActiveLanguagesServerSide(): Promise<Language[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("languages")
    .select("id, code, name, is_default, is_active, created_at, updated_at")
    .eq("is_active", true) // Assuming there's an is_active column
    .order("name", { ascending: true });

  if (error) {
    console.error("Error fetching active languages:", error);
    throw new Error("Failed to fetch active languages.");
  }
  
  return data || [];
}
export async function getLanguageByCode(code: string): Promise<{ data: Language | null; error: string | null; }> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("languages")
    .select("id, code, name, is_default, is_active, created_at, updated_at")
    .eq("code", code)
    .single();

  if (error) {
    console.error(`Error fetching language by code ${code}:`, error);
    return { data: null, error: `Failed to fetch language by code ${code}: ${error.message}` };
  }
  return { data, error: null };
}

type UpsertLanguagePayload = {
  code: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
};

export async function createLanguage(formData: FormData) {
  const supabase = createClient();

  if (!(await verifyAdmin(supabase))) {
    return { error: "Unauthorized: Admin role required." };
  }

  const rawFormData = {
    code: formData.get("code") as string,
    name: formData.get("name") as string,
    is_default: formData.get("is_default") === "on", // Checkbox value
    is_active: formData.get("is_active") === "on",
  };

  if (!rawFormData.code || !rawFormData.name) {
    return { error: "Missing required fields: code or name." };
  }
  if (rawFormData.code.length > 10) { // Basic validation
      return { error: "Language code is too long (max 10 characters)." };
  }


  const languageData: UpsertLanguagePayload = {
    ...rawFormData,
  };

  // If setting this language as default, unset any other default language first
  if (languageData.is_default) {
    const { error: unsetError } = await supabase
      .from("languages")
      .update({ is_default: false })
      .eq("is_default", true);
    if (unsetError) {
      console.error("Error unsetting previous default language:", unsetError);
      return { error: `Failed to unset previous default language: ${unsetError.message}` };
    }
  } else {
    // Ensure there's at least one default language if unsetting the current one
    // This logic is complex if done here. The DB unique index on (is_default) WHERE is_default=true handles one default.
    // If unchecking the *only* default, the DB might prevent it or it might allow no default.
    // It's better to handle "setting a new default" as the primary way to change the default.
  }


  const { data, error } = await supabase
    .from("languages")
    .insert(languageData)
    .select()
    .single();

  if (error) {
    console.error("Error creating language:", error);
    if (error.code === '23505') { // Unique violation
        if (error.message.includes('languages_code_key')) {
            return { error: `Language code '${languageData.code}' already exists.` };
        }
        if (error.message.includes('ensure_single_default_language_idx')) {
             return { error: `Cannot set this language as default. Another language is already default, or an error occurred unsetting it.` };
        }
    }
    return { error: `Failed to create language: ${error.message}` };
  }

  revalidatePath("/cms/settings/languages");
  revalidatePath("/"); // Revalidate home page as language switcher might change
  revalidatePath("/cms/settings/extra-translations");
  if (data?.id) {
    redirect(`/cms/settings/extra-translations?language=${encodeURIComponent(data.code)}&success=${encodeURIComponent("Language created successfully. Please fill the extra translations.")}`);
  } else {
    redirect(`/cms/settings/extra-translations?success=${encodeURIComponent("Language created successfully. Please fill the extra translations.")}`);
  }
}

export async function updateLanguage(languageId: number, formData: FormData) {
  const supabase = createClient();

  if (!(await verifyAdmin(supabase))) {
    return { error: "Unauthorized: Admin role required." };
  }

  const rawFormData = {
    code: formData.get("code") as string,
    name: formData.get("name") as string,
    is_default: formData.get("is_default") === "on",
    is_active: formData.get("is_active") === "on",
  };

  if (!rawFormData.code || !rawFormData.name) {
    return { error: "Missing required fields: code or name." };
  }
   if (rawFormData.code.length > 10) {
      return { error: "Language code is too long (max 10 characters)." };
  }

  const languageData: Partial<UpsertLanguagePayload> = {
    ...rawFormData,
  };

  // If setting this language as default, unset any other default language first
  if (languageData.is_default) {
    const { error: unsetError } = await supabase
      .from("languages")
      .update({ is_default: false })
      .eq("is_default", true)
      .neq("id", languageId); // Don't unset self if it was already default
    if (unsetError) {
      console.error("Error unsetting previous default language:", unsetError);
      return { error: `Failed to unset previous default language: ${unsetError.message}` };
    }
  } else {
    // Check if we are trying to uncheck the *only* default language.
    // The DB unique index `ensure_single_default_language_idx` might prevent this if it leads to zero defaults.
    // It's safer to enforce that one language must always be default through UI logic (e.g., disable unchecking if it's the only default).
    const { data: currentLang } = await supabase.from("languages").select("is_default").eq("id", languageId).single();
    if (currentLang?.is_default && !languageData.is_default) {
        const { count } = await supabase.from("languages").select('*', { count: 'exact', head: true }).eq("is_default", true);
        if (count === 1) {
            return { error: "Cannot unset the only default language. Please set another language as default first." };
        }
    }
  }

  const { error } = await supabase
    .from("languages")
    .update(languageData)
    .eq("id", languageId);

  if (error) {
    console.error("Error updating language:", error);
     if (error.code === '23505') {
        if (error.message.includes('languages_code_key')) {
            return { error: `Language code '${languageData.code}' already exists for another language.` };
        }
         if (error.message.includes('ensure_single_default_language_idx')) {
             return { error: `Database constraint: Only one language can be default.` };
        }
    }
    return { error: `Failed to update language: ${error.message}` };
  }

  revalidatePath("/cms/settings/languages");
  revalidatePath("/");
  redirect(`/cms/settings/languages/${languageId}/edit?success=Language updated successfully`);
}

export async function deleteLanguage(languageId: number) {
  const supabase = createClient();

  if (!(await verifyAdmin(supabase))) {
    return { error: "Unauthorized: Admin role required." };
  }

  // Critical check: Prevent deleting the default language if it's the only one or default.
  const { data: langToDelete, error: langFetchError } = await supabase
    .from("languages")
    .select("is_default, code")
    .eq("id", languageId)
    .single();

  if (langFetchError || !langToDelete) {
    return { error: "Language not found or error fetching details." };
  }

  if (langToDelete.is_default) {
    const { count } = await supabase.from("languages").select('*', { count: 'exact', head: true });
    if (count === 1) {
        return { error: "Cannot delete the only language, especially if it's default." };
    }
    return { error: "Cannot delete the default language. Set another language as default first." };
  }

  // WARNING: Deleting a language will cascade delete all associated content
  // (pages, posts, blocks, navigation_items) due to foreign key constraints with ON DELETE CASCADE.
  // This is a very destructive operation. A confirmation step in the UI is crucial.

  const { error } = await supabase
    .from("languages")
    .delete()
    .eq("id", languageId);

  if (error) {
    console.error("Error deleting language:", error);
    return { error: `Failed to delete language: ${error.message}. Check if content is still linked.` };
  }

  revalidatePath("/cms/settings/languages");
  revalidatePath("/");
  redirect("/cms/settings/languages?success=Language deleted successfully. All associated content has also been removed.");
}

// --- Language detection settings (site_settings.language_detection_settings) ---

export async function getLanguageDetectionSettings(): Promise<LanguageDetectionSettings> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", LANGUAGE_DETECTION_SETTING_KEY)
    .maybeSingle();

  if (error) {
    console.error("Error fetching language detection settings:", error);
  }
  // Absent row or error = defaults (browser detection, remembered choice).
  return normalizeLanguageDetectionSettings(error ? null : data?.value);
}

export async function updateLanguageDetectionSettings(
  input: LanguageDetectionSettings,
): Promise<{ success?: string; error?: string }> {
  const supabase = createClient();

  if (!(await verifyAdmin(supabase))) {
    return { error: "Unauthorized: Admin role required." };
  }

  // Never trust the client payload shape — coerce to a valid settings object.
  const settings = normalizeLanguageDetectionSettings(input);

  // ADMIN verified above; written with the service role because the key is in the
  // ADMIN-only write tier that migration 02023 gates behind is_admin_mfa(), which an admin
  // on an aal1 "remember this device" session cannot satisfy through the cookie client.
  const { error } = await getServiceRoleSupabaseClient()
    .from("site_settings")
    .upsert({ key: LANGUAGE_DETECTION_SETTING_KEY, value: settings as unknown as Json });

  if (error) {
    console.error("Error saving language detection settings:", error);
    return { error: `Failed to save detection settings: ${error.message}` };
  }

  updateTag(LANGUAGE_DETECTION_CACHE_TAG);
  revalidatePath("/cms/settings/languages");
  revalidatePath("/", "layout");
  // The proxy caches detection config in-memory for up to a minute per worker,
  // so the change isn't instant for new visitors — set that expectation here.
  return { success: "Language detection settings saved. Changes reach new visitors within about a minute." };
}
