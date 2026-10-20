import { createClient, getProfileWithRoleServerSide } from "@nextblock-cms/db/server";
import { NextResponse } from "next/server";
import { resolvePostAuthRedirect } from "../../../lib/auth-redirects";

// Site-relative-path guard for the `redirect_to` query parameter, so the callback cannot be used
// as an open redirect (`?redirect_to=//evil.com`, `/\evil.com`, `https://evil.com`, …). Matches
// isSafeInternalPath in lib/auth-redirects.ts.
function safeRelative(path?: string | null): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null; // control chars (CR/LF/NUL), DEL, whitespace
  }
  if (/^\/%2f/i.test(path)) return null;
  return path;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const origin = requestUrl.origin;
  const initialRedirectTo = safeRelative(requestUrl.searchParams.get("redirect_to")?.toString());

  if (code) {
    const supabase = await createClient();
    const { data: { user } , error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

    if (exchangeError) {
      console.error("Auth callback: Error exchanging code for session:", exchangeError.message);
      return NextResponse.redirect(`${origin}${initialRedirectTo || '/'}`);
    }

    if (user) {
      const profile = await getProfileWithRoleServerSide(user.id);
      const targetPath = resolvePostAuthRedirect(profile, initialRedirectTo);
      return NextResponse.redirect(`${origin}${targetPath}`);
    }

    console.warn("Auth callback: User object is null after code exchange.");
    return NextResponse.redirect(`${origin}/`);
  }

  return NextResponse.redirect(`${origin}${initialRedirectTo || '/'}`);
}
