'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { unstable_rethrow } from 'next/navigation';
import { Alert, AlertDescription, Button, Input, Label, Spinner } from '@nextblock-cms/ui';
import { resendEmailCode, verifyEmailCode, verifyTotpChallenge } from '../actions';
import { useLabel } from '../../../../lib/i18n/use-label';

/** Matches the security panel: relays queue, so parking the button beats spamming it. */
const RESEND_COOLDOWN_SECONDS = 30;

interface TwoFactorFormProps {
  type: 'totp' | 'email';
  email: string;
  redirectTo: string;
  pendingEmailCode: boolean;
}

export default function TwoFactorForm({
  type,
  email,
  redirectTo,
  pendingEmailCode,
}: TwoFactorFormProps) {
  const label = useLabel();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(
    type === 'email' && pendingEmailCode
      ? label('two_factor.code_sent_to', 'Enter the code we sent to {email}.', 'Entrez le code envoyé à {email}.', { email })
      : null,
  );
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const submit = (codeToSubmit: string = code) => {
    // The button stays enabled, so an incomplete code gets an explanation instead of a
    // dead control (a disabled submit cannot say why it is disabled).
    if (codeToSubmit.length !== 6) {
      setError(label('two_factor.code_incomplete', 'Enter the 6-digit code.', 'Entrez le code à 6 chiffres.'));
      inputRef.current?.focus();
      return;
    }
    setError(null);
    const formData = new FormData();
    formData.append('code', codeToSubmit);
    formData.append('redirect_to', redirectTo);
    startTransition(async () => {
      try {
        const action = type === 'totp' ? verifyTotpChallenge : verifyEmailCode;
        const result = await action(formData);
        // A successful action redirects server-side; only failures return here.
        if (result?.error) setError(result.error);
      } catch (err) {
        // A successful verify ends in redirect(), which Next signals by throwing a
        // NEXT_REDIRECT control-flow error. Let Next handle it (perform the navigation)
        // instead of surfacing it as a red error flash; only real errors fall through.
        unstable_rethrow(err);
        setError(
          err instanceof Error
            ? err.message
            : label('two_factor.verification_failed', 'Verification failed.', 'La vérification a échoué.')
        );
      }
    });
  };

  const resend = () => {
    if (cooldown > 0) return;
    setError(null);
    setInfo(null);
    startTransition(async () => {
      try {
        const result = await resendEmailCode();
        if (result?.error) setError(result.error);
        else if (result?.message) {
          setInfo(result.message);
          setCooldown(RESEND_COOLDOWN_SECONDS);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : label('two_factor.send_failed', 'Could not send a code.', "Impossible d'envoyer un code.")
        );
      }
    });
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold">
        {label('two_factor.title', 'Two-step verification', 'Vérification en deux étapes')}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {type === 'totp'
          ? label(
              'two_factor.totp_help',
              'Enter the 6-digit code from your authenticator app to finish signing in.',
              "Entrez le code à 6 chiffres de votre application d'authentification pour terminer la connexion."
            )
          : label(
              'two_factor.email_help',
              'For your security, enter the 6-digit code sent to {email}.',
              'Pour votre sécurité, entrez le code à 6 chiffres envoyé à {email}.',
              { email: email || label('two_factor.your_email', 'your email', 'votre adresse courriel') }
            )}
      </p>

      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="code">{label('two_factor.code_label', 'Verification code', 'Code de vérification')}</Label>
          <Input
            ref={inputRef}
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(next);
              // Auto-submit the moment a full 6-digit code is entered (typed, pasted,
              // or filled by the OS one-time-code autofill) — no button press needed.
              if (next.length === 6 && !isPending) submit(next);
            }}
            placeholder="000000"
            className="tracking-[0.5em] text-center text-lg"
          />
        </div>

        {error && (
          <Alert variant="destructive" className="py-2 px-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {info && !error && (
          <Alert variant="success" className="py-2 px-4">
            <AlertDescription>{info}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? <Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
          {label('two_factor.submit', 'Verify & continue', 'Vérifier et continuer')}
        </Button>
      </form>

      {type === 'email' && (
        <>
          <button
            type="button"
            onClick={resend}
            disabled={isPending || cooldown > 0}
            className="mt-4 w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-50"
          >
            {cooldown > 0
              ? label('two_factor.resend_in', 'Resend available in {seconds}s', 'Renvoi possible dans {seconds} s', { seconds: cooldown })
              : pendingEmailCode
                ? label('two_factor.resend', 'Resend code', 'Renvoyer le code')
                : label('two_factor.send', 'Send me a code', 'Envoyez-moi un code')}
          </button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {label(
              'two_factor.delivery_help',
              'Codes can take a minute to arrive. If you request another, the earlier one still works: enter whichever reaches you first.',
              'Les codes peuvent prendre une minute à arriver. Si vous en demandez un autre, le précédent reste valide : entrez celui qui vous parvient en premier.'
            )}
          </p>
        </>
      )}
    </div>
  );
}
