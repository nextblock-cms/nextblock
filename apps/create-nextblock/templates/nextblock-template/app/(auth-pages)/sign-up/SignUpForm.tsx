'use client';

import { signUpAction } from "../../actions";
import { FormMessage, Message } from "../../../components/form-message";
import { SubmitButton } from "../../../components/submit-button";
import { Alert, AlertDescription, Button, Input, Label } from "@nextblock-cms/ui";
import Link from "next/link";
import { useTranslations } from "@nextblock-cms/utils";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CheckCircle2, Mail } from "lucide-react";

import { SandboxCredentialsAlert } from "../../../components/SandboxCredentialsAlert";
import { AuthBotProtection } from "../../../components/auth/AuthBotProtection";
import { useLabel } from "../../../lib/i18n/use-label";

type BotProtectionProvider = 'none' | 'turnstile' | 'recaptcha';

/** signUpAction's answer on the sandbox, which creates no accounts (a global key, seeded by 02031). */
const SANDBOX_SIGNUP_DISABLED = 'sandbox_signup_disabled';
const SANDBOX_NOTICE_ID = 'sandbox-signup-disabled';

interface SignUpFormProps {
  botProtection: { provider: BotProtectionProvider; siteKey: string };
  scriptNonce?: string;
  /** The sandbox banner lists the demo partner (resolved on the server by page.tsx). */
  showDemoPartner?: boolean;
}

function getMessage(searchParams: URLSearchParams): Message | undefined {
    if (searchParams.has('error')) {
        const error = searchParams.get('error');
        if (error) return { error };
    }
    if (searchParams.has('success')) {
        const success = searchParams.get('success');
        if (success) return { success };
    }
    if (searchParams.has('message')) {
        const message = searchParams.get('message');
        if (message) return { message };
    }
    return undefined;
}

export default function SignUpForm({ botProtection, scriptNonce, showDemoPartner = false }: SignUpFormProps) {
  const { t } = useTranslations();
  const label = useLabel();
  const searchParams = useSearchParams();
  // The public sandbox creates no accounts (signUpAction refuses there): the form stays on screen
  // with its button disabled under a notice that points at the demo accounts.
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const requestedMessage = getMessage(searchParams);
  // That refusal comes back as ?error=sandbox_signup_disabled. The notice already says it, so the
  // form neither repeats it nor shows the bare key on an install that has not seeded it yet.
  const formMessage =
    isSandbox && requestedMessage && 'error' in requestedMessage && requestedMessage.error === SANDBOX_SIGNUP_DISABLED
      ? undefined
      : requestedMessage;
  const successKey = searchParams.get('success');

  if (successKey) {
    return (
      <div className="flex-1 flex flex-col w-full max-w-160 mx-auto">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t('auth.signup_success_badge')}
        </p>
        <h1 className="mt-3 text-2xl font-medium">{t('auth.signup_success_title')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(successKey)}
        </p>

        <div className="mt-8 rounded-lg border p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-muted p-2 text-muted-foreground">
              <Mail className="h-4 w-4" />
            </div>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>{t('auth.signup_success_step_confirm')}</p>
              <p>{t('auth.signup_success_step_profile')}</p>
              <p>{t('auth.signup_success_step_spam')}</p>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button asChild>
            <Link href="/sign-in">
              {t('auth.back_to_sign_in')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/sign-up">{t('auth.signup_use_different_email')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col w-full max-w-160 mx-auto">
      <form className="flex flex-col">
        {isSandbox ? (
          <Alert id={SANDBOX_NOTICE_ID} variant="warning" role="note" className="mt-6">
            <AlertDescription>
              {label(
                SANDBOX_SIGNUP_DISABLED,
                'Sign-up is turned off in this demo. Sign in with a demo account below instead.',
                "L'inscription est désactivée dans cette démo. Connectez-vous plutôt avec un compte de démonstration ci-dessous."
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        <SandboxCredentialsAlert showDemoPartner={showDemoPartner} />
        <h1 className="text-2xl font-medium">{t('sign_up')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('auth.signup_form_description')}
        </p>
        <p className="text-sm text-foreground">
          {t('already_have_account')}{" "}
          <Link className="text-foreground font-medium underline transition-colors hover:text-primary" href="/sign-in">
            {t('sign_in')}
          </Link>
        </p>

        <div className="mt-8 flex flex-col gap-2">
          <div className="flex flex-col gap-2 [&>input]:mb-3">
            <Label htmlFor="email">{t('email')}</Label>
            <Input
              id="email"
              type="email"
              name="email"
              autoComplete="email"
              spellCheck={false}
              placeholder={t('you_at_example_com')}
              required
            />
            <Label htmlFor="password">{t('password')}</Label>
            <Input
              id="password"
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder={t('your_password')}
              minLength={6}
              required
            />
            <AuthBotProtection
              provider={botProtection.provider}
              siteKey={botProtection.siteKey}
              scriptNonce={scriptNonce}
            />
            <SubmitButton
              formAction={signUpAction}
              pendingText={t('signing_up_pending')}
              disabled={isSandbox}
              aria-describedby={isSandbox ? SANDBOX_NOTICE_ID : undefined}
            >
              {t('sign_up')}
            </SubmitButton>
            <FormMessage message={formMessage} />
          </div>
        </div>
      </form>
    </div>
  );
}
