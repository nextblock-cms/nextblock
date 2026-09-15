import { Suspense } from "react";
import { headers } from "next/headers";
import { createClient } from "@nextblock-cms/db/server";
import SignUpForm from "./SignUpForm";

type BotProtectionProvider = 'none' | 'turnstile' | 'recaptcha';

// Per-request render: the form needs the CSP nonce the proxy attaches to every request
// (Turnstile / reCAPTCHA scripts are nonce-gated), so this page can never be prerendered.
// Without this, `next build` tries to render it statically, headers() bails out by
// throwing DYNAMIC_SERVER_USAGE, and the page is logged as an error with no nonce.
export const dynamic = 'force-dynamic';

// Server wrapper: resolves the site-wide bot-protection provider + site key
// (CMS → Settings → Bot Protection) and the CSP nonce, then hands them to the
// interactive client form. Mirrors the read in components/BlockRenderer.tsx.
export default async function SignUpPage() {
  const scriptNonce = (await headers()).get('x-nonce') || '';

  let botProtection: { provider: BotProtectionProvider; siteKey: string } = {
    provider: 'none',
    siteKey: '',
  };
  try {
    const supabase = createClient();
    const { data: publicSetting } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'bot_protection_public')
      .maybeSingle();
    if (publicSetting?.value) {
      const publicVal = publicSetting.value as Record<string, any>;
      botProtection = {
        provider: publicVal.provider || 'none',
        siteKey: publicVal.siteKey || '',
      };
    }
  } catch (e) {
    console.error('[Bot Protection] Error loading settings on sign-up page:', e);
  }

  return (
    <Suspense fallback={null}>
      <SignUpForm botProtection={botProtection} scriptNonce={scriptNonce} />
    </Suspense>
  );
}
