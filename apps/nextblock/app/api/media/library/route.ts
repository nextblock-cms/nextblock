import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@nextblock-cms/db/server';
import type { Database } from '@nextblock-cms/db';

const MAX_MEDIA_LIBRARY_ITEMS = 100;
const DEFAULT_MEDIA_LIBRARY_ITEMS = 50;
export const dynamic = 'force-dynamic';

function getMediaLibrarySupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables for media library API');
  }

  return createSupabaseClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    // CMS-only picker endpoint. Without this gate it served the entire media table (object keys,
    // folder layout, and each upload's uploader_id) to anyone, with an attacker-driven search
    // filter and no rate limit. Require a staff session.
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { data: profile } = await authClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role !== 'ADMIN' && profile?.role !== 'WRITER') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim() ?? '';
    const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, MAX_MEDIA_LIBRARY_ITEMS)
        : DEFAULT_MEDIA_LIBRARY_ITEMS;

    const supabase = getMediaLibrarySupabaseClient();

    let mediaQuery = supabase
      .from('media')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (query) {
      mediaQuery = mediaQuery.ilike('file_name', `%${query}%`);
    }

    const { data, error } = await mediaQuery;

    if (error) {
      console.error('[Media Library API] Failed to load media:', error);
      return NextResponse.json(
        { error: 'Failed to load media library.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ items: data ?? [] }, { status: 200 });
  } catch (error) {
    console.error('[Media Library API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Unexpected media library error.' },
      { status: 500 }
    );
  }
}
