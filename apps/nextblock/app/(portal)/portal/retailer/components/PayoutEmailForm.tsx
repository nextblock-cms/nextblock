'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import {
  AFFILIATE_PAYOUT_EMAIL_KINDS,
  AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH,
  AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH,
  type AffiliatePayoutEmailKind,
} from '@nextblock-cms/affiliates';

import { saveRetailerPayoutEmail } from '../actions';
import type { PortalCopyKey } from './portal-copy';
import { PORTAL_ACTION_ERROR_KEYS } from './portal-messages';
import { usePortalCopy } from './use-portal-copy';

export interface PayoutEmailFormProps {
  /** The address saved now (`affiliate_profiles.payout_email`), or null. */
  initialEmail: string | null;
  /** What the saved address is for (`affiliate_profiles.payout_email_kind`, 02037; `paypal` by default). */
  initialKind: AffiliatePayoutEmailKind;
  /** The public sandbox: the demo partner is shared, so nothing is saved there. */
  sandbox: boolean;
  /** A suspended partner reads the page but changes nothing (the action refuses them too). */
  suspended: boolean;
  /** The site title: who sends Interac e-Transfers. */
  siteName: string;
  /**
   * Some kind of order is paid with PayPal Payouts (02037): PayPal payouts go out automatically, so
   * Interac e-Transfers, sent by hand, usually come less often. Otherwise the store sends both by hand.
   */
  paypalPayouts: boolean;
  /**
   * PayPal returned the last payout sent to the saved PayPal email, and the partner has not saved it
   * since (02037): the run stops sending there. "I checked it: try PayPal again" saves the same
   * address again, which lets the next payout try PayPal (`payout_email_saved_at`).
   */
  paypalReturned?: boolean;
}

type Message = { tone: 'info' | 'error'; text: string } | null;

const KIND_LABEL_KEYS: Readonly<Record<AffiliatePayoutEmailKind, PortalCopyKey>> = {
  paypal: 'affiliates.portal.payout_kind_paypal',
  interac: 'affiliates.portal.payout_kind_interac',
};

/** Trimmed and lowercased, as the action stores it. */
function normalized(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Where the partner's payouts outside Stripe go (02036, 02037): PayPal or Interac e-Transfer first
 * (`payout_email_kind`), then the email. A PayPal email that is new for PayPal (a new address, or one
 * saved for Interac before) is typed twice: a mistyped one waits 30 days at PayPal before it comes
 * back. A line under the email says so while the confirmation field shows, and a missing or different
 * confirmation moves the focus to that field with its own message. The PayPal choice warns about the
 * 30 days; the Interac one says the store sends it by hand. Save, and Remove once an address is saved
 * (saving an empty field removes it too); after PayPal returned a payout from the saved address,
 * "I checked it: try PayPal again" saves it again. The server action (`saveRetailerPayoutEmail`)
 * validates and normalizes the address again (a refusal moves the focus to the email); after a save the
 * page re-renders, so the payout figures and the onboarding step follow. The fields skip the browser's
 * own validation so the partner reads the portal's message in their language.
 */
export function PayoutEmailForm({
  initialEmail,
  initialKind,
  sandbox,
  suspended,
  siteName,
  paypalPayouts,
  paypalReturned = false,
}: PayoutEmailFormProps) {
  const { t } = usePortalCopy();
  const router = useRouter();
  const id = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<string | null>(initialEmail);
  const [savedKind, setSavedKind] = useState<AffiliatePayoutEmailKind>(initialKind);
  const [kind, setKind] = useState<AffiliatePayoutEmailKind>(initialKind);
  const [value, setValue] = useState(initialEmail ?? '');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | 'retry' | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [invalid, setInvalid] = useState<'email' | 'confirmation' | null>(null);
  const [retried, setRetried] = useState(false);
  // The field to fix gets the focus once the form is enabled again (a disabled input cannot take it).
  const [focusRequest, setFocusRequest] = useState<{ target: 'email' | 'confirmation'; count: number } | null>(null);
  const disabled = sandbox || suspended;
  const requestFocus = (target: 'email' | 'confirmation') =>
    setFocusRequest((previous) => ({ target, count: (previous?.count ?? 0) + 1 }));

  useEffect(() => {
    if (!focusRequest) return;
    (focusRequest.target === 'email' ? emailRef : confirmationRef).current?.focus();
  }, [focusRequest]);
  // The confirmation is asked for a PayPal email PayPal has not been given for this partner yet.
  const needsConfirmation = kind === 'paypal' && normalized(value) !== '' && !(savedKind === 'paypal' && normalized(value) === (saved ?? ''));

  const submit = async (payoutEmail: string, action: 'save' | 'remove' | 'retry') => {
    if (busy || disabled) return;
    setMessage(null);
    setInvalid(null);
    if (action === 'save' && needsConfirmation && normalized(confirmation) !== normalized(payoutEmail)) {
      setInvalid('confirmation');
      setMessage({
        tone: 'error',
        text: t(normalized(confirmation) === '' ? 'affiliates.portal.error_payout_email_confirm_empty' : 'affiliates.portal.error_payout_email_mismatch'),
      });
      requestFocus('confirmation');
      return;
    }
    setBusy(action);
    try {
      const result = await saveRetailerPayoutEmail({ payoutEmail, payoutEmailKind: action === 'retry' ? 'paypal' : kind });
      if (result.ok) {
        setSaved(result.payoutEmail);
        setSavedKind(result.payoutEmailKind);
        setKind(result.payoutEmailKind);
        setValue(result.payoutEmail ?? '');
        setConfirmation('');
        if (action === 'retry') setRetried(true);
        setMessage({
          tone: 'info',
          text: t(
            action === 'retry'
              ? 'affiliates.portal.payout_email_retry_saved'
              : result.payoutEmail
                ? 'affiliates.portal.payout_email_saved'
                : 'affiliates.portal.payout_email_removed'
          ),
        });
        router.refresh();
      } else {
        const emailRefused = result.error === 'invalid_payout_email' || result.error === 'invalid_input';
        setInvalid(emailRefused ? 'email' : null);
        setMessage({ tone: 'error', text: t(PORTAL_ACTION_ERROR_KEYS[result.error]) });
        if (emailRefused) requestFocus('email');
      }
    } catch {
      setMessage({ tone: 'error', text: t('affiliates.common.error_network') });
    }
    setBusy(null);
  };

  const legendId = `${id}-kind`;
  const inputId = `${id}-email`;
  const confirmationId = `${id}-confirmation`;
  const helpId = `${id}-help`;
  const confirmHintId = `${id}-confirm-hint`;
  const statusId = `${id}-status`;
  const unchanged = normalized(value) === (saved ?? '') && kind === savedKind;
  // PayPal returned a payout from the saved PayPal email: the partner can ask for PayPal there again.
  const canRetryPayPal = paypalReturned && !retried && unchanged && savedKind === 'paypal' && Boolean(saved);
  const help =
    kind === 'paypal'
      ? t('affiliates.portal.payout_email_help')
      : paypalPayouts
        ? t('affiliates.portal.payout_email_interac_help', { site: siteName })
        : t('affiliates.portal.payout_email_interac_help_manual', { site: siteName });

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(value, value.trim() ? 'save' : 'remove');
      }}
    >
      {sandbox ? <p className="text-sm text-muted-foreground">{t('affiliates.portal.error_sandbox')}</p> : null}
      <fieldset className="space-y-2" aria-labelledby={legendId} disabled={disabled || busy !== null}>
        <legend id={legendId} className="text-sm font-medium text-foreground">
          {t('affiliates.portal.payout_email_label')}
        </legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {AFFILIATE_PAYOUT_EMAIL_KINDS.map((option) => (
            <label key={option} className="inline-flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name={`${id}-payout-kind`}
                value={option}
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                  setInvalid(null);
                  setMessage(null);
                }}
                className="h-4 w-4 accent-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              {t(KIND_LABEL_KEYS[option])}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>
          {kind === 'paypal' ? t('affiliates.portal.payout_email_paypal_label') : t('affiliates.portal.payout_email_interac_label')}
        </Label>
        <Input
          ref={emailRef}
          id={inputId}
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          maxLength={kind === 'paypal' ? AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH : AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH}
          value={value}
          disabled={disabled || busy !== null}
          aria-describedby={needsConfirmation ? `${helpId} ${confirmHintId} ${statusId}` : `${helpId} ${statusId}`}
          aria-invalid={invalid === 'email' || undefined}
          onChange={(event) => setValue(event.target.value)}
          className="max-w-md"
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
        {needsConfirmation ? (
          <p id={confirmHintId} className="text-xs text-muted-foreground">
            {t('affiliates.portal.payout_email_paypal_confirm_hint')}
          </p>
        ) : null}
      </div>
      {needsConfirmation ? (
        <div className="space-y-1.5">
          <Label htmlFor={confirmationId}>{t('affiliates.portal.payout_email_paypal_confirm_label')}</Label>
          <Input
            ref={confirmationRef}
            id={confirmationId}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            maxLength={AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH}
            value={confirmation}
            disabled={disabled || busy !== null}
            aria-describedby={statusId}
            aria-invalid={invalid === 'confirmation' || undefined}
            onChange={(event) => setConfirmation(event.target.value)}
            className="max-w-md"
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={disabled || busy !== null || unchanged}>
          {busy === 'save' ? t('affiliates.common.saving') : t('affiliates.common.save')}
        </Button>
        {canRetryPayPal ? (
          <Button type="button" variant="outline" disabled={disabled || busy !== null} onClick={() => void submit(saved ?? '', 'retry')}>
            {busy === 'retry' ? t('affiliates.common.saving') : t('affiliates.portal.payout_email_retry_paypal')}
          </Button>
        ) : null}
        {saved ? (
          <Button type="button" variant="outline" disabled={disabled || busy !== null} onClick={() => void submit('', 'remove')}>
            {busy === 'remove' ? t('affiliates.common.saving') : t('affiliates.portal.payout_email_remove')}
          </Button>
        ) : null}
      </div>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn('min-h-5 text-sm', message?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {message?.text ?? ''}
      </p>
    </form>
  );
}
