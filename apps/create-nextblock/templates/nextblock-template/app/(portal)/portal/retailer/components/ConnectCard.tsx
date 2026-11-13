'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { Button, Label } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { AFFILIATE_PORTAL_PAYOUTS_PATH } from '@nextblock-cms/affiliates';

import { openStripeExpressDashboard, refreshStripeConnectStatus, startStripeConnectOnboarding } from '../actions';
import { PORTAL_ACTION_ERROR_KEYS } from './portal-messages';
import { usePortalCopy } from './use-portal-copy';

/** `unavailable`: the store has no Stripe account set up yet, so there is nothing to connect. */
export type ConnectCardState = 'not_connected' | 'incomplete' | 'ready' | 'unavailable';

export interface ConnectCardProps {
  state: ConnectCardState;
  sandbox: boolean;
  suspended: boolean;
  /** Countries the platform onboards, with names already localized on the server. */
  countries: ReadonlyArray<{ code: string; name: string }>;
  defaultCountry: string | null;
  detailsSubmitted: boolean;
  /** `?connected=1`: Stripe sent the partner back; re-read the account from Stripe (never trust the URL). */
  refreshOnMount: boolean;
  /** `?connect_error=1`: the refresh link could not be created. */
  connectError: boolean;
  /**
   * Stripe pays only some of the partner's commissions; the store sends the others by hand (02036,
   * `affiliates_settings.payoutMethods`; the "How you get paid" card says which). The card then
   * speaks of "the commissions we pay through Stripe".
   */
  partial?: boolean;
}

type Busy = 'connect' | 'refresh' | 'dashboard' | null;
type Message = { tone: 'info' | 'error'; text: string } | null;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Stripe Connect Express onboarding for automated payouts, and the partner's connection status. */
export function ConnectCard(props: ConnectCardProps) {
  const { t } = usePortalCopy();
  const router = useRouter();
  const id = useId();
  const [country, setCountry] = useState(props.defaultCountry ?? props.countries[0]?.code ?? '');
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message>(
    props.connectError ? { tone: 'error', text: t('affiliates.portal.connect_error_return') } : null,
  );
  const refreshed = useRef(false);
  const disabled = props.sandbox || props.suspended || props.state === 'unavailable';

  useEffect(() => {
    if (!props.refreshOnMount || refreshed.current || disabled) return;
    refreshed.current = true;
    setBusy('refresh');
    setMessage({ tone: 'info', text: t('affiliates.portal.connect_checking') });
    void refreshStripeConnectStatus()
      .then((result) => {
        if (result.ok) {
          setMessage({
            tone: 'info',
            text: result.ready ? t('affiliates.portal.connect_ready_message') : t('affiliates.portal.connect_incomplete_message'),
          });
        } else {
          setMessage({ tone: 'error', text: t(PORTAL_ACTION_ERROR_KEYS[result.error]) });
        }
      })
      .catch(() => setMessage({ tone: 'error', text: t('affiliates.common.error_network') }))
      .finally(() => {
        setBusy(null);
        // Drop ?connected=1 so a reload does not ask Stripe again; the server render has the new status.
        router.replace(AFFILIATE_PORTAL_PAYOUTS_PATH, { scroll: false });
      });
  }, [props.refreshOnMount, disabled, router, t]);

  const go = async (kind: 'connect' | 'continue' | 'dashboard') => {
    if (busy || disabled) return;
    setBusy(kind === 'dashboard' ? 'dashboard' : 'connect');
    setMessage(null);
    try {
      const result =
        kind === 'dashboard'
          ? await openStripeExpressDashboard()
          : // Continuing an existing setup: the account's country is already fixed at Stripe.
            await startStripeConnectOnboarding(kind === 'connect' ? { country } : {});
      if (result.ok && isHttpsUrl(result.url)) {
        // A full navigation to Stripe (the CSP's form-action 'self' rules out a form post).
        window.location.assign(result.url);
        return;
      }
      setMessage({ tone: 'error', text: t(result.ok ? 'affiliates.portal.error_connect_unavailable' : PORTAL_ACTION_ERROR_KEYS[result.error]) });
    } catch {
      setMessage({ tone: 'error', text: t('affiliates.common.error_network') });
    }
    setBusy(null);
  };

  const refresh = async () => {
    if (busy || disabled) return;
    setBusy('refresh');
    setMessage(null);
    try {
      const result = await refreshStripeConnectStatus();
      if (result.ok) {
        setMessage({
          tone: 'info',
          text: result.ready ? t('affiliates.portal.connect_ready_message') : t('affiliates.portal.connect_incomplete_message'),
        });
        router.refresh();
      } else {
        setMessage({ tone: 'error', text: t(PORTAL_ACTION_ERROR_KEYS[result.error]) });
      }
    } catch {
      setMessage({ tone: 'error', text: t('affiliates.common.error_network') });
    }
    setBusy(null);
  };

  const headingId = `${id}-heading`;

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('affiliates.portal.connect_title')}
      </h2>

      {props.sandbox ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('affiliates.portal.connect_sandbox')}</p>
      ) : props.state === 'unavailable' ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('affiliates.portal.connect_not_configured')}</p>
      ) : props.state === 'ready' ? (
        <div className="mt-3 space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-primary" />
            {t('affiliates.portal.connect_ready')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(props.partial ? 'affiliates.portal.connect_ready_body_partial' : 'affiliates.portal.connect_ready_body')}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" disabled={disabled || busy !== null} onClick={() => void go('dashboard')}>
              {busy === 'dashboard' ? t('affiliates.portal.connect_opening') : t('affiliates.portal.connect_dashboard')}
            </Button>
          </div>
        </div>
      ) : props.state === 'incomplete' ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-foreground">
            {props.detailsSubmitted ? t('affiliates.portal.connect_review') : t('affiliates.portal.connect_incomplete')}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" disabled={disabled || busy !== null} onClick={() => void go('continue')}>
              {busy === 'connect' ? t('affiliates.portal.connect_opening') : t('affiliates.portal.connect_continue')}
            </Button>
            <Button type="button" variant="outline" disabled={disabled || busy !== null} onClick={() => void refresh()}>
              {busy === 'refresh' ? t('affiliates.portal.connect_checking') : t('affiliates.portal.connect_check_status')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="mt-3 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void go('connect');
          }}
        >
          <p className="text-sm text-muted-foreground">
            {t(props.partial ? 'affiliates.portal.connect_intro_partial' : 'affiliates.portal.connect_intro')}
          </p>
          {props.countries.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-country`}>{t('affiliates.portal.connect_country')}</Label>
              <select
                id={`${id}-country`}
                value={country}
                disabled={disabled || busy !== null}
                onChange={(event) => setCountry(event.target.value)}
                aria-describedby={`${id}-country-hint`}
                className="flex h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {props.countries.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name}
                  </option>
                ))}
              </select>
              <p id={`${id}-country-hint`} className="text-xs text-muted-foreground">
                {t('affiliates.portal.connect_country_hint')}
              </p>
            </div>
          ) : null}
          <Button type="submit" disabled={disabled || busy !== null || !country}>
            {busy === 'connect' ? t('affiliates.portal.connect_opening') : t('affiliates.portal.connect_button')}
          </Button>
        </form>
      )}

      <p
        role="status"
        aria-live="polite"
        className={cn('mt-3 min-h-5 text-sm', message?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {message?.text ?? ''}
      </p>
    </section>
  );
}
