// app/api/revalidate/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { resolveRevalidateSecret } from '../../../lib/app-secrets';
import { revalidatePublicContent } from '../../../lib/public-content-cache';

// Define the expected structure of the Supabase webhook payload
interface SupabaseWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record?: { slug?: string; [key: string]: unknown }; // Record for INSERT/UPDATE
  old_record?: { slug?: string; [key: string]: unknown }; // Old record for DELETE
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-revalidate-secret');
  // Explicit REVALIDATE_SECRET_TOKEN wins; otherwise derived from the service-role
  // key. Empty only when Supabase is unconfigured — reject in that case rather than
  // allowing an empty-header match.
  const expectedSecret = resolveRevalidateSecret();

  if (!expectedSecret || secret !== expectedSecret) {
    console.warn("Revalidation attempt with invalid secret token.");
    return NextResponse.json({ message: 'Invalid secret token' }, { status: 401 });
  }

  let payload: SupabaseWebhookPayload;
  try {
    payload = await request.json();
    console.log("Received Supabase webhook payload for revalidation:", JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("Failed to parse revalidation request JSON:", e);
    return NextResponse.json({ message: 'Bad Request: Could not parse JSON payload.' }, { status: 400 });
  }

  const { type, table, record, old_record } = payload;
  const relevantRecord = type === 'DELETE' ? old_record : record;

  if (!relevantRecord || typeof relevantRecord.slug !== 'string') {
    console.warn("Revalidation payload missing relevant record or slug.", { table, type });
    return NextResponse.json({ message: 'Payload missing slug information.' }, { status: 400 });
  }

  let pathToRevalidate: string | null = null;

  if (table === 'pages') {
    pathToRevalidate = `/${relevantRecord.slug}`;
  } else if (table === 'posts') {
    pathToRevalidate = `/article/${relevantRecord.slug}`;
  } else {
    console.log(`Revalidation not configured for table: ${table}`);
    return NextResponse.json({ message: `Revalidation not configured for table: ${table}` }, { status: 200 }); // Acknowledge but don't process
  }

  if (pathToRevalidate) {
    try {
      // Ensure path starts with a slash (it should based on construction above)
      const normalizedPath = pathToRevalidate.startsWith('/') ? pathToRevalidate : `/${pathToRevalidate}`;
      
      // Revalidate the specific path.
      // Using 'page' type for revalidation as we are revalidating individual content pages.
      await revalidatePath(normalizedPath, 'page');
      // The public reads behind that path are cached by tag as well; a row changed
      // directly in the database (which is what this webhook reports) must evict them.
      revalidatePublicContent(table === 'pages' ? 'pages' : 'posts');
      console.log(`Successfully revalidated path: ${normalizedPath}`);
      
      // Additionally, if it's an article, you might want to revalidate the main listing page.
      if (table === 'posts') {
        // Assuming your main articles listing page is at '/articles' or similar.
        // This path needs to be known and consistent.
        // If your listing is at the root of the language segment (e.g. /en/articles),
        // and you are NOT using [lang] in URL, then the path is just '/articles'.
        // However, if your LanguageContext means /articles shows different content per lang,
        // revalidating just '/articles' will rebuild its default language version.
        // Client-side fetches would still get latest for other languages.
        // For now, let's revalidate a generic /articles path if it exists.
        // await revalidatePath('/articles', 'page'); // Example: revalidate main listing
        // console.log("Also attempted to revalidate /articles listing page.");
      }

      return NextResponse.json({ revalidated: true, revalidatedPath: normalizedPath, now: Date.now() });
    } catch (err: unknown) {
      console.error("Error during revalidation process:", err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      return NextResponse.json({ message: `Error revalidating: ${errorMessage}` }, { status: 500 });
    }
  } else {
    // This case should ideally not be reached if table and slug checks are done.
    return NextResponse.json({ message: 'Could not determine path to revalidate.' }, { status: 400 });
  }
}
