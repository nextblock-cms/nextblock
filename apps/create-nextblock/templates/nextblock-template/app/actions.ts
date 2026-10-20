"use server";

import { encodedRedirect } from "@nextblock-cms/utils/server";
import { createClient, getServiceRoleSupabaseClient } from "@nextblock-cms/db/server";
import { headers } from "next/headers";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { resolvePostAuthRedirect } from "../lib/auth-redirects";
import { createEmailChallenge, evaluateTwoFactor } from "../lib/auth/twoFactor";
import { REMEMBER_INTENT_COOKIE, TWO_FACTOR_COOKIE, clearCookie, setSecureCookie } from "../lib/auth/cookies";
import { sendTwoFactorCodeEmail } from "./actions/twoFactorEmail";
import { getSystemConfiguration } from "../lib/setup/system-config";
import { verifyBotProtection } from "../lib/botProtection/verify";

export const signUpAction = async (formData: FormData) => {
  const email = formData.get("email")?.toString();
  const password = formData.get("password")?.toString();
  const supabase = await createClient();
  const origin = (await headers()).get("origin");
  const nextPublicUrl = process.env.NEXT_PUBLIC_URL;
  const redirectBase = nextPublicUrl
    ? nextPublicUrl.startsWith("http")
      ? nextPublicUrl
      : `https://${nextPublicUrl}`
    : origin;

  if (!email || !password) {
    return encodedRedirect(
      "error",
      "/sign-up",
      "Email and password are required",
    );
  }

  // Bot protection: the same honeypot + Turnstile/reCAPTCHA check the public
  // contact forms use, run BEFORE any account is created. On a honeypot hit we
  // mimic a normal "check your email" success so the bot learns nothing; a failed
  // captcha surfaces the reason. (The site-wide provider from CMS → Settings →
  // Bot Protection applies; when it's "none", only the honeypot gates signup.)
  const botCheck = await verifyBotProtection(formData);
  if (!botCheck.ok) {
    if (botCheck.reason === "honeypot") {
      return encodedRedirect("success", "/sign-up", "auth.signup_check_email_profile");
    }
    return encodedRedirect("error", "/sign-up", botCheck.message);
  }

  // Auto-accept mode (system_configuration.auto_accept_signups): create an already-
  // confirmed account via the service role so the user is active immediately, with no
  // outbound verification email — regardless of SMTP / project email-confirmation
  // settings. Falls through to the standard signUp flow if the service role isn't
  // available. NOTE: keep supabase.auth calls outside any try/catch so the redirect
  // they (and encodedRedirect) throw internally is never swallowed.
  const { auto_accept_signups: autoAcceptSignups } = await getSystemConfiguration();
  if (autoAcceptSignups) {
    let admin: ReturnType<typeof getServiceRoleSupabaseClient> | null = null;
    try {
      admin = getServiceRoleSupabaseClient();
    } catch {
      admin = null; // service role missing — use the standard flow below
    }

    if (admin) {
      const { error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (createError) {
        if (createError.message.toLowerCase().includes("already")) {
          return encodedRedirect("error", "/sign-up", "auth.signup_existing_account_hint");
        }
        return encodedRedirect("error", "/sign-up", createError.message);
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        return encodedRedirect("error", "/sign-in", signInError.message);
      }

      return redirect("/post-sign-in");
    }
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${redirectBase}/auth/callback?redirect_to=/profile`,
    },
  });

  if (error) {
    console.error(error.code + " " + error.message);

    if (error.message.toLowerCase().includes("rate limit")) {
      return encodedRedirect(
        "error",
        "/sign-up",
        "auth.signup_rate_limit"
      );
    }

    if (error.message.toLowerCase().includes("already")) {
      return encodedRedirect(
        "error",
        "/sign-up",
        "auth.signup_existing_account_hint"
      );
    }

    return encodedRedirect("error", "/sign-up", error.message);
  }

  // When sign-up returns a session, the account is already confirmed — self-hosted GoTrue with
  // autoconfirm (no SMTP), or any project without email confirmation. The user is already signed
  // in, so send them into the app instead of telling them to check an email that was never sent.
  // (The first account becomes ADMIN and lands in the dashboard; everyone else routes normally.)
  if (data.session) {
    return redirect("/post-sign-in");
  }

  return encodedRedirect(
    "success",
    "/sign-up",
    "auth.signup_check_email_profile",
  );
};

export const signInAction = async (formData: FormData) => {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const requestedRedirect = formData.get("redirect")?.toString();
  const rememberDevice =
    formData.get("remember_device") === "on" ||
    formData.get("remember_device") === "true";
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return encodedRedirect("error", "/sign-in", error.message);
  }

  if (data.user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', data.user.id)
      .single();

    const nextPath = resolvePostAuthRedirect(profile ?? null, requestedRedirect);

    // Decide whether a second factor is still owed. A live trusted device, or
    // an account without MFA, resolves to "satisfied" and skips the challenge.
    const evaluation = await evaluateTwoFactor();
    if (evaluation.status === "satisfied" || evaluation.status === "not_required") {
      return redirect(`/post-sign-in?redirect_to=${encodeURIComponent(nextPath)}`);
    }

    // Carry the "remember this device" intent through the 2FA challenge.
    if (rememberDevice) {
      await setSecureCookie(REMEMBER_INTENT_COOKIE, "1", 15 * 60);
    }

    // Email factor: mint the first code now so the challenge page has one waiting. The
    // challenge row is created synchronously because the page reads it to decide between
    // "Resend code" and "Send me a code"; only the SMTP conversation is deferred, so the
    // redirect isn't held behind a relay handshake that can take seconds. Delivery failure
    // was already swallowed here — the user resends from the challenge page — so moving it
    // off the response path costs no error reporting.
    if (evaluation.status === "email_required" && data.user.email) {
      const recipient = data.user.email;
      try {
        const code = await createEmailChallenge(data.user.id);
        after(async () => {
          try {
            await sendTwoFactorCodeEmail(recipient, code);
          } catch (sendError) {
            console.error("Failed to send 2FA email code:", sendError);
          }
        });
      } catch (challengeError) {
        console.error("Failed to create 2FA email challenge:", challengeError);
      }
    }

    return redirect(`/two-factor?redirect_to=${encodeURIComponent(nextPath)}`);
  }

  return redirect("/post-sign-in");
};

export const forgotPasswordAction = async (formData: FormData) => {
  const email = formData.get("email")?.toString();
  const supabase = await createClient();
  const origin = (await headers()).get("origin");
  const nextPublicUrl = process.env.NEXT_PUBLIC_URL;
  const redirectBase = nextPublicUrl
    ? nextPublicUrl.startsWith("http")
      ? nextPublicUrl
      : `https://${nextPublicUrl}`
    : origin;
  const callbackUrl = formData.get("callbackUrl")?.toString();

  if (!email) {
    return encodedRedirect("error", "/forgot-password", "Email is required");
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${redirectBase}/auth/callback?redirect_to=/profile/password`,
  });

  if (error) {
    console.error(error.message);
    return encodedRedirect(
      "error",
      "/forgot-password",
      "Could not reset password",
    );
  }

  if (callbackUrl) {
    return redirect(callbackUrl);
  }

  return encodedRedirect(
    "success",
    "/forgot-password",
    "Check your email for a link to reset your password.",
  );
};

export const resetPasswordAction = async (formData: FormData) => {
  const supabase = await createClient();

  const password = formData.get("password") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!password || !confirmPassword) {
    encodedRedirect(
      "error",
      "/profile/password",
      "Password and confirm password are required",
    );
  }

  if (password !== confirmPassword) {
    encodedRedirect(
      "error",
      "/profile/password",
      "Passwords do not match",
    );
  }

  const { error } = await supabase.auth.updateUser({
    password: password,
  });

  if (error) {
    encodedRedirect(
      "error",
      "/profile/password",
      "Password update failed",
    );
  }

  encodedRedirect("success", "/profile/password", "Password updated");
};

export const signOutAction = async () => {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Drop the second-factor "satisfied" marker (userId-bound, 12h) and the remember-intent flag so
  // a later sign-in on a shared device re-presents 2FA instead of inheriting this session's. The
  // long-lived trusted-device cookie is left intentionally (that is the "remember this device"
  // feature; it is revocable from the security settings page).
  await clearCookie(TWO_FACTOR_COOKIE);
  await clearCookie(REMEMBER_INTENT_COOKIE);
  return redirect("/");
};
