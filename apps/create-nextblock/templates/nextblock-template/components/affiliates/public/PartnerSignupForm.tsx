'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Info, LoaderCircle } from 'lucide-react';
import { Button, Input, Label } from '@nextblock-cms/ui';
import {
  AFFILIATES_PARTNERS_SIGNUP_COPY,
  AFFILIATES_SANDBOX_COPY,
  AFFILIATE_HANDLE_MAX_LENGTH,
  AFFILIATE_HANDLE_MIN_LENGTH,
  isReservedAffiliateHandle,
  normalizeAffiliateHandle,
  splitAffiliatesCopyAtPlaceholder,
  suggestAffiliateHandle,
  useAffiliatesCopy,
} from '@nextblock-cms/affiliates';
import { AuthBotProtection } from '../../auth/AuthBotProtection';
import { SandboxCredentialsAlert } from '../../SandboxCredentialsAlert';
import type {
  PartnerHandleCheckResult,
  PartnerSignupField,
  PartnerSignupState,
} from '../../../app/(public)/partners/actions';
import type { PartnerSignupViewer } from '../../../lib/affiliates/signup';
import { PARTNERS_PRIMARY_LINK_CLASS, PARTNERS_TEXT_LINK_CLASS } from './link-button-classes';
import { PartnerTermsLink } from './PartnerTermsLink';

export interface PartnerSignupFormProps {
  /** Who is visiting (their own session, resolved on the server). */
  viewer: PartnerSignupViewer;
  /** `submitPartnerSignup` (server action). */
  signupAction: (state: PartnerSignupState, formData: FormData) => Promise<PartnerSignupState>;
  /** `checkPartnerHandleAvailability` (server action). */
  checkHandleAction: (input: { handle: string }) => Promise<PartnerHandleCheckResult>;
  /** `example.com/partners/`: shown before the handle. */
  storefrontPrefix: string;
  botProtection: { provider: 'none' | 'turnstile' | 'recaptcha'; siteKey: string };
  scriptNonce?: string;
  /** False when no tier has a free spot. */
  signupOpen: boolean;
  signInHref: string;
  twoFactorHref: string;
  portalHref: string;
  /**
   * The partner terms the checkbox accepts: the operator's own page for the page's language, else
   * the built-in terms address of that language (computed on the server, `partnersTermsHref`).
   */
  termsHref: string;
}

export const PARTNER_SIGNUP_INITIAL_STATE: PartnerSignupState = { ok: null, attempt: 0 };

type HandleStatus = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'unknown';

/** Wait this long after the last keystroke before asking the server (rate-limited per address). */
const HANDLE_CHECK_DELAY_MS = 450;

/** The island's strings: the signup area, plus the public sandbox's demo notice and result panel. */
const PARTNER_SIGNUP_FORM_COPY = { ...AFFILIATES_PARTNERS_SIGNUP_COPY, ...AFFILIATES_SANDBOX_COPY };

const PANEL_CLASS = 'rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm';
const FIELD_HINT_CLASS = 'text-sm text-muted-foreground';
const FIELD_ERROR_CLASS = 'text-sm font-medium text-destructive';
/** The sandbox's demo-mode notice, first in the form, in the colours of the sandbox credentials banner. */
const SANDBOX_NOTICE_CLASS =
  'flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100';

/** Lowercase as the visitor types and turn spaces into hyphens; everything else is validated, not rewritten. */
function shapeHandleInput(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-').slice(0, 64);
}

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const list = ids.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return list.length > 0 ? list.join(' ') : undefined;
}

/**
 * The `/partners` signup island. Anonymous visitors get the full form (display name, handle, email,
 * password, terms); a signed-in customer gets the upgrade form (no email or password); a partner, a
 * staff account or a session that still owes its second factor get a short panel instead. The
 * server action decides everything again: this component only shapes the experience.
 *
 * React 19 resets an uncontrolled form after its action settles, so a refusal echoes the typed
 * values back (`state.values`) and the fields re-mount with them; the bot-protection widget is
 * keyed on the attempt so every retry gets a fresh single-use token.
 *
 * On the public sandbox the form says it runs in demo mode, and a signup that passed every check
 * ends on the demo panel (the service created nothing) with the demo partner's sign-in.
 */
export function PartnerSignupForm(props: PartnerSignupFormProps) {
  const { t } = useAffiliatesCopy(PARTNER_SIGNUP_FORM_COPY);
  const [state, formAction, pending] = useActionState(props.signupAction, PARTNER_SIGNUP_INITIAL_STATE);
  const id = useId();
  const confirmationRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // Inlined at build, like SandboxCredentialsAlert: the server and the browser render the same.
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  const viewer = props.viewer;
  const echo = state.ok === false ? state.values : null;
  const customer = viewer.kind === 'customer' ? viewer : null;
  const isCustomer = customer !== null;
  const initialDisplayName = echo?.displayName ?? customer?.fullName ?? '';

  // A confirmed signup comes back with the handle it chose: keep it rather than suggest one from
  // the name (a prefill only; the server validates the submitted handle again).
  const initialHandle = echo?.handle ?? customer?.pendingHandle ?? null;

  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [handle, setHandle] = useState(() => initialHandle ?? (initialDisplayName ? suggestAffiliateHandle(initialDisplayName) : ''));
  const handleEdited = useRef(Boolean(initialHandle));
  const [handleStatus, setHandleStatus] = useState<HandleStatus>('idle');
  const checkHandle = props.checkHandleAction;

  // Live availability: local shape checks first, the server only for a well-formed handle.
  useEffect(() => {
    const trimmed = handle.trim();
    if (trimmed.length < AFFILIATE_HANDLE_MIN_LENGTH) {
      setHandleStatus('idle');
      return undefined;
    }
    const normalized = normalizeAffiliateHandle(trimmed);
    if (!normalized) {
      setHandleStatus(isReservedAffiliateHandle(trimmed) ? 'reserved' : 'invalid');
      return undefined;
    }
    let cancelled = false;
    setHandleStatus('checking');
    const timer = setTimeout(() => {
      checkHandle({ handle: normalized })
        .then((result) => {
          if (!cancelled) setHandleStatus(result.ok ? result.status : 'unknown');
        })
        .catch(() => {
          if (!cancelled) setHandleStatus('unknown');
        });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle, checkHandle]);

  // A confirmation replaces the form: move focus to it. A refusal: focus the field it names, else the alert.
  useEffect(() => {
    if (state.ok === true) {
      confirmationRef.current?.focus();
    } else if (state.ok === false) {
      const field = state.field ? document.getElementById(`${id}-${state.field}`) : null;
      (field ?? errorRef.current)?.focus();
    }
  }, [state, id]);

  if (viewer.kind === 'partner') {
    return (
      <div className={PANEL_CLASS}>
        <h3 className="text-xl font-semibold text-foreground">{t('affiliates.partners.signup_partner_title')}</h3>
        <p className="mt-2 text-muted-foreground">{t('affiliates.partners.signup_partner_body')}</p>
        <Link href={props.portalHref} className={`mt-6 ${PARTNERS_PRIMARY_LINK_CLASS}`}>
          {t('affiliates.partners.signup_open_portal')}
        </Link>
      </div>
    );
  }

  if (viewer.kind === 'staff') {
    return (
      <div className={PANEL_CLASS}>
        <h3 className="text-xl font-semibold text-foreground">{t('affiliates.partners.signup_staff_title')}</h3>
        <p className="mt-2 text-muted-foreground">{t('affiliates.partners.signup_staff_body')}</p>
      </div>
    );
  }

  if (viewer.kind === 'factor_pending') {
    return (
      <div className={PANEL_CLASS}>
        <p className="text-foreground">{t('affiliates.partners.signup_error_factor_pending')}</p>
        <Link href={props.twoFactorHref} className={`mt-6 ${PARTNERS_PRIMARY_LINK_CLASS}`}>
          {t('affiliates.partners.signup_sign_in')}
        </Link>
      </div>
    );
  }

  if (state.ok === true && state.status === 'sandbox_demo') {
    return (
      <div className={PANEL_CLASS}>
        <div ref={confirmationRef} tabIndex={-1} role="status" className="flex items-start gap-3 outline-hidden">
          <CircleCheck aria-hidden="true" className="mt-1 h-6 w-6 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <div className="min-w-0">
            <h3 className="text-xl font-semibold text-foreground">{t('affiliates.sandbox.signup_done_title')}</h3>
            <p className="mt-2 break-words text-muted-foreground">
              {t('affiliates.sandbox.signup_done_body', { url: `${props.storefrontPrefix}${state.handle}` })}
            </p>
          </div>
        </div>
        {/* Nothing was created: the seeded demo partner is how the visitor sees the portal. */}
        <SandboxCredentialsAlert showDemoPartner />
      </div>
    );
  }

  if (state.ok === true) {
    const ready = state.status === 'sign_in';
    return (
      <div ref={confirmationRef} tabIndex={-1} role="status" className={`${PANEL_CLASS} outline-hidden`}>
        <div className="flex items-start gap-3">
          <CircleCheck aria-hidden="true" className="mt-1 h-6 w-6 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <div>
            <h3 className="text-xl font-semibold text-foreground">
              {ready ? t('affiliates.partners.signup_ready_title') : t('affiliates.partners.signup_check_email_title')}
            </h3>
            <p className="mt-2 text-muted-foreground">
              {ready ? t('affiliates.partners.signup_ready_body') : t('affiliates.partners.signup_check_email_body')}
            </p>
            {ready ? (
              <Link href={props.signInHref} className={`mt-6 ${PARTNERS_PRIMARY_LINK_CLASS}`}>
                {t('affiliates.partners.signup_sign_in')}
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!props.signupOpen) {
    return (
      <div className={PANEL_CLASS}>
        <p className="text-foreground">{t('affiliates.partners.signup_closed')}</p>
      </div>
    );
  }

  const errorField: PartnerSignupField | null = state.ok === false ? state.field : null;
  const fieldId = (field: PartnerSignupField) => `${id}-${field}`;
  const formErrorId = `${id}-form-error`;
  const handleHintId = `${id}-handle-hint`;
  const handleStatusId = `${id}-handle-status`;
  const handlePreviewId = `${id}-handle-preview`;
  const sandboxNoticeId = `${id}-sandbox-notice`;
  const normalizedHandle = normalizeAffiliateHandle(handle);
  const previewHandle = normalizedHandle ?? (handle.trim() || '…');
  // "I accept the {terms}. …": the terms link goes where {terms} is (after the text when an
  // override dropped it). Copy stays plain text; React builds the link.
  const termsLabel = splitAffiliatesCopyAtPlaceholder(t('affiliates.partners.signup_terms_accept'), 'terms');

  const handleStatusText =
    handleStatus === 'checking'
      ? t('affiliates.partners.signup_handle_checking')
      : handleStatus === 'available'
        ? t('affiliates.partners.signup_handle_available')
        : handleStatus === 'taken'
          ? t('affiliates.partners.signup_handle_taken')
          : handleStatus === 'reserved'
            ? t('affiliates.partners.signup_handle_reserved')
            : handleStatus === 'invalid'
              ? t('affiliates.partners.signup_handle_invalid')
              : handleStatus === 'unknown'
                ? t('affiliates.partners.signup_handle_unknown')
                : '';
  const handleStatusClass =
    handleStatus === 'available'
      ? 'text-sm font-medium text-emerald-700 dark:text-emerald-400'
      : handleStatus === 'taken' || handleStatus === 'reserved' || handleStatus === 'invalid'
        ? FIELD_ERROR_CLASS
        : FIELD_HINT_CLASS;

  return (
    <form action={formAction} className={`${PANEL_CLASS} space-y-6`}>
      {sandbox ? (
        <div id={sandboxNoticeId} className={SANDBOX_NOTICE_CLASS}>
          <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <p>{t('affiliates.sandbox.signup_notice')}</p>
        </div>
      ) : null}

      {isCustomer ? (
        <div className="space-y-1">
          {customer?.email ? (
            <p className="text-foreground">{t('affiliates.partners.signup_signed_in_as', { email: customer.email })}</p>
          ) : null}
          <p className="text-muted-foreground">{t('affiliates.partners.signup_upgrade_intro')}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('affiliates.partners.signup_have_account')}{' '}
          <Link href={props.signInHref} className={PARTNERS_TEXT_LINK_CLASS}>
            {t('affiliates.partners.signup_sign_in_first')}
          </Link>
        </p>
      )}

      {state.ok === false ? (
        <div
          ref={errorRef}
          id={formErrorId}
          tabIndex={-1}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-background p-4 text-sm font-medium text-destructive outline-hidden"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{state.message}</p>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={fieldId('displayName')}>{t('affiliates.partners.signup_name_label')}</Label>
        <Input
          id={fieldId('displayName')}
          name="displayName"
          type="text"
          autoComplete="name"
          required
          maxLength={80}
          value={displayName}
          aria-invalid={errorField === 'displayName' || undefined}
          aria-describedby={describedBy(`${id}-name-hint`, errorField === 'displayName' && formErrorId)}
          onChange={(event) => {
            const next = event.target.value;
            setDisplayName(next);
            if (!handleEdited.current) setHandle(next.trim() ? suggestAffiliateHandle(next) : '');
          }}
        />
        <p id={`${id}-name-hint`} className={FIELD_HINT_CLASS}>
          {t('affiliates.partners.signup_name_hint')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={fieldId('handle')}>{t('affiliates.partners.signup_handle_label')}</Label>
        <div className="flex rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
          <span
            aria-hidden="true"
            className="hidden items-center whitespace-nowrap rounded-l-md border-r border-input bg-muted px-3 text-sm text-foreground sm:flex"
          >
            {props.storefrontPrefix}
          </span>
          <input
            id={fieldId('handle')}
            name="handle"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={AFFILIATE_HANDLE_MIN_LENGTH}
            maxLength={AFFILIATE_HANDLE_MAX_LENGTH}
            value={handle}
            aria-invalid={errorField === 'handle' || handleStatus === 'taken' || handleStatus === 'reserved' || handleStatus === 'invalid' || undefined}
            aria-describedby={describedBy(handleHintId, handlePreviewId, handleStatusId, errorField === 'handle' && formErrorId)}
            onChange={(event) => {
              handleEdited.current = true;
              setHandle(shapeHandleInput(event.target.value));
            }}
            className="h-10 min-w-0 flex-1 rounded-md bg-transparent px-3 py-2 text-sm text-foreground outline-hidden placeholder:text-muted-foreground sm:rounded-l-none"
          />
        </div>
        <p id={handleHintId} className={FIELD_HINT_CLASS}>
          {t('affiliates.partners.signup_handle_hint')}
        </p>
        <p id={handlePreviewId} className="break-all text-sm text-foreground">
          {t('affiliates.partners.signup_handle_preview', { url: `${props.storefrontPrefix}${previewHandle}` })}
        </p>
        <p id={handleStatusId} aria-live="polite" className={`flex min-h-5 items-center gap-2 ${handleStatusClass}`}>
          {handleStatus === 'checking' ? (
            <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 motion-safe:animate-spin" />
          ) : null}
          {handleStatusText}
        </p>
      </div>

      {!isCustomer ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={fieldId('email')}>{t('affiliates.partners.signup_email_label')}</Label>
            <Input
              key={`email-${state.attempt}`}
              id={fieldId('email')}
              name="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              required
              maxLength={254}
              defaultValue={echo?.email ?? ''}
              aria-invalid={errorField === 'email' || undefined}
              aria-describedby={describedBy(errorField === 'email' && formErrorId)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId('password')}>{t('affiliates.partners.signup_password_label')}</Label>
            <Input
              id={fieldId('password')}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={72}
              aria-invalid={errorField === 'password' || undefined}
              aria-describedby={describedBy(`${id}-password-hint`, errorField === 'password' && formErrorId)}
            />
            <p id={`${id}-password-hint`} className={FIELD_HINT_CLASS}>
              {t('affiliates.partners.signup_password_hint')}
            </p>
          </div>
        </>
      ) : null}

      <div className="flex items-start gap-3">
        <input
          key={`terms-${state.attempt}`}
          id={fieldId('terms')}
          name="terms"
          type="checkbox"
          required
          defaultChecked={echo?.terms ?? false}
          aria-invalid={errorField === 'terms' || undefined}
          aria-describedby={describedBy(errorField === 'terms' && formErrorId)}
          className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded border-input accent-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
        />
        <label htmlFor={fieldId('terms')} className="text-sm leading-6 text-foreground">
          {termsLabel.before}
          {termsLabel.found ? null : ' '}
          <PartnerTermsLink
            href={props.termsHref}
            newTabLabel={t('affiliates.partners.signup_terms_new_tab')}
            className={PARTNERS_TEXT_LINK_CLASS}
          >
            {t('affiliates.partners.signup_terms_link')}
          </PartnerTermsLink>
          {termsLabel.after}
        </label>
      </div>

      <AuthBotProtection
        key={`bot-${state.attempt}`}
        provider={props.botProtection.provider}
        siteKey={props.botProtection.siteKey}
        scriptNonce={props.scriptNonce}
      />

      {/* On the sandbox the demo notice describes the button: it creates no account. */}
      <Button
        type="submit"
        size="full"
        disabled={pending}
        aria-disabled={pending || undefined}
        aria-describedby={sandbox ? sandboxNoticeId : undefined}
      >
        {pending ? (
          <>
            <LoaderCircle aria-hidden="true" className="mr-2 h-4 w-4 motion-safe:animate-spin" />
            {t('affiliates.partners.signup_submitting')}
          </>
        ) : isCustomer ? (
          t('affiliates.partners.signup_upgrade_submit')
        ) : (
          t('affiliates.partners.signup_submit')
        )}
      </Button>
    </form>
  );
}
