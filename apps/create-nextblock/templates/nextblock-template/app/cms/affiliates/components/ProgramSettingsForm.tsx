'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Button, Checkbox, Input, Label, Textarea } from '@nextblock-cms/ui';
import { PARTNERS_TERMS_BUILTIN_PARAM, PARTNERS_TERMS_PATH } from '../../../../lib/affiliates/partners-paths';
import { saveAffiliatesProgramSettings } from '../actions';
import { AFFILIATE_PAYOUT_METHOD_LABEL } from './labels';
import { useAffiliateAdminAction } from './use-admin-action';

type PayoutMethodChoice = 'stripe_connect' | 'paypal' | 'manual';

export interface ProgramSettingsFormProps {
  notificationEmails: string[];
  minPayoutCents: number;
  autoPayoutsEnabled: boolean;
  /** How the commissions of each sale gateway are paid (02036, PayPal 02037; default Stripe Connect for both). */
  payoutMethods: { stripeSales: PayoutMethodChoice; freemiusSales: PayoutMethodChoice };
  /** The operator's own partner terms page in English (`''` = the built-in terms). */
  termsUrlEn: string;
  /** The same in French (`''` = the English page, else the built-in terms). */
  termsUrlFr: string;
  /**
   * True when Settings → Privacy & Consent gives the built-in terms no contact address (no support
   * email, or only the `privacy@example.com` placeholder), so their Contact section is left out.
   */
  termsContactMissing?: boolean;
  /** Store base currency (commissions are recorded and paid in it). */
  currency: string;
  /** Minor units per major unit of `currency` (100, or 1 for zero-decimal currencies). */
  currencyFactor: number;
  minAllowedCents: number;
  maxAllowedCents: number;
}

/** The action's sandbox refusal, word for word (actions.ts). */
const TERMS_LOCKED_NOTE =
  "Partner terms links can't be changed in the sandbox: every visitor, and the partner sign-up form, would be sent there.";

/**
 * The built-in terms even while a page of the operator's own replaces them: the route honours the
 * parameter for a signed-in ADMIN only (and marks that view noindex); everyone else is redirected.
 */
const BUILT_IN_TERMS_PREVIEW_HREF = `${PARTNERS_TERMS_PATH}?${PARTNERS_TERMS_BUILTIN_PARAM}=1`;

/** Where the built-in terms take the operator's legal name and contact address from. */
const PRIVACY_SETTINGS_HREF = '/cms/settings/privacy';

/** Underlined at rest: inside a sentence a link must not differ from the text by colour alone. */
const PREVIEW_LINK_CLASS =
  'inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const TEXT_LINK_CLASS =
  'rounded-sm font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Same classes as the CMS's native selects (Payouts screen filters). */
const SELECT_CLASS =
  'flex h-10 w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

const PAYOUT_METHOD_CHOICES: readonly PayoutMethodChoice[] = ['stripe_connect', 'paypal', 'manual'];

function toMajor(minor: number, factor: number): string {
  const value = minor / factor;
  return factor === 1 ? String(Math.round(value)) : value.toFixed(2);
}

function toPayoutMethod(value: string): PayoutMethodChoice {
  return value === 'manual' ? 'manual' : value === 'paypal' ? 'paypal' : 'stripe_connect';
}

/** Notification recipients, minimum payout, the daily payout switch, how partners are paid and the partner terms pages. */
export function ProgramSettingsForm(props: ProgramSettingsFormProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const [emails, setEmails] = useState(props.notificationEmails.join('\n'));
  const [minPayout, setMinPayout] = useState(toMajor(props.minPayoutCents, props.currencyFactor));
  const [autoPayouts, setAutoPayouts] = useState(props.autoPayoutsEnabled);
  const [stripeSales, setStripeSales] = useState<PayoutMethodChoice>(toPayoutMethod(props.payoutMethods?.stripeSales ?? ''));
  const [freemiusSales, setFreemiusSales] = useState<PayoutMethodChoice>(toPayoutMethod(props.payoutMethods?.freemiusSales ?? ''));
  // Normalized strings from getAffiliatesSettings(); `?? ''` keeps the inputs controlled whatever the row held.
  const [termsEn, setTermsEn] = useState(props.termsUrlEn ?? '');
  const [termsFr, setTermsFr] = useState(props.termsUrlFr ?? '');
  const emailsId = useId();
  const minPayoutId = useId();
  const autoId = useId();
  const termsEnId = useId();
  const termsFrId = useId();
  const termsHelpId = useId();
  const stripeSalesId = useId();
  const freemiusSalesId = useId();
  const payoutMethodsHelpId = useId();

  // The public sandbox sends no email (lib/affiliates/notify.ts). Inlined at build, like SandboxCredentialsAlert reads it.
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const step = props.currencyFactor === 1 ? '1' : '0.01';
  const minMajor = toMajor(props.minAllowedCents, props.currencyFactor);
  const maxMajor = toMajor(props.maxAllowedCents, props.currencyFactor);

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const minPayoutCents = Math.round(Number(minPayout) * props.currencyFactor);
        run(() =>
          saveAffiliatesProgramSettings({
            notificationEmails: emails,
            minPayoutCents: Number.isFinite(minPayoutCents) ? minPayoutCents : 0,
            autoPayoutsEnabled: autoPayouts,
            // The sandbox refuses a terms link (the fields are locked there): send none.
            termsUrlEn: sandbox ? '' : termsEn.trim(),
            termsUrlFr: sandbox ? '' : termsFr.trim(),
            payoutMethods: { stripeSales, freemiusSales },
          })
        );
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={emailsId}>Notification emails</Label>
        <Textarea
          id={emailsId}
          value={emails}
          rows={3}
          maxLength={3000}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${emailsId}-help`}
          onChange={(event) => setEmails(event.target.value)}
          placeholder="partners@example.com"
        />
        <p id={`${emailsId}-help`} className="text-xs text-muted-foreground">
          Signups, completed profiles, submitted storefronts and payout problems are emailed here (up to 10 addresses, one per
          line). Leave it empty to use the store contact address.{sandbox ? ' The sandbox sends no email.' : null}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={minPayoutId}>Minimum payout ({props.currency})</Label>
        <Input
          id={minPayoutId}
          type="number"
          inputMode="decimal"
          step={step}
          min={minMajor}
          max={maxMajor}
          required
          value={minPayout}
          aria-describedby={`${minPayoutId}-help`}
          onChange={(event) => setMinPayout(event.target.value)}
          className="max-w-48"
        />
        <p id={`${minPayoutId}-help`} className="text-xs text-muted-foreground">
          Stripe transfers and automatic PayPal payouts start once a partner&rsquo;s cleared balance reaches this amount ({minMajor}{' '}
          to {maxMajor} {props.currency}). For commissions paid manually it decides who is ready under Pay manually and whom
          &ldquo;Prepare PayPal payouts&rdquo; includes.
        </p>
      </div>

      <div className="flex items-start gap-3">
        <Checkbox
          id={autoId}
          checked={autoPayouts}
          onCheckedChange={(checked) => setAutoPayouts(checked === true)}
          aria-describedby={`${autoId}-help`}
          className="mt-0.5"
        />
        <div className="space-y-1">
          <Label htmlFor={autoId}>Send Stripe transfers and PayPal payouts automatically every day</Label>
          <p id={`${autoId}-help`} className="text-xs text-muted-foreground">
            The daily run clears commissions past their hold, including those you pay manually, and checks the PayPal payouts
            already sent, whether this is on or off. When off, it sends no Stripe transfer and no new PayPal payout: cleared
            commissions paid through Stripe or PayPal wait until you press &ldquo;Run payouts now&rdquo; on the Payouts screen.
          </p>
        </div>
      </div>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium text-foreground">How partners are paid</legend>
        <div className="space-y-2">
          <Label htmlFor={stripeSalesId}>Commissions on Stripe sales</Label>
          <select
            id={stripeSalesId}
            value={stripeSales}
            aria-describedby={payoutMethodsHelpId}
            onChange={(event) => setStripeSales(toPayoutMethod(event.target.value))}
            className={SELECT_CLASS}
          >
            {PAYOUT_METHOD_CHOICES.map((method) => (
              <option key={method} value={method}>
                {AFFILIATE_PAYOUT_METHOD_LABEL[method]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={freemiusSalesId}>Commissions on Freemius sales</Label>
          <select
            id={freemiusSalesId}
            value={freemiusSales}
            aria-describedby={payoutMethodsHelpId}
            onChange={(event) => setFreemiusSales(toPayoutMethod(event.target.value))}
            className={SELECT_CLASS}
          >
            {PAYOUT_METHOD_CHOICES.map((method) => (
              <option key={method} value={method}>
                {AFFILIATE_PAYOUT_METHOD_LABEL[method]}
              </option>
            ))}
          </select>
        </div>
        <div id={payoutMethodsHelpId} className="space-y-1 text-xs text-muted-foreground">
          <p>
            Freemius pays you, not your partners: choose PayPal or Manually for Freemius sales unless you keep enough money in
            Stripe. Freemius pays you on the 10th of the second month after a sale.
          </p>
          <p>
            PayPal sends each partner&rsquo;s cleared balance from your PayPal balance to their PayPal payout email, with the daily
            run. It needs a PayPal Business account with Payouts enabled and your PayPal app&rsquo;s credentials: set them up
            under Affiliates → PayPal payouts. Partners whose payout email is for Interac e-Transfer are paid under Pay manually.
          </p>
          <p>
            Commissions paid manually are left out of the Stripe transfers and PayPal payouts: prepare each payout under Payouts →
            Pay manually, send it yourself, then record it.
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium text-foreground">Partner terms</legend>
        <div className="space-y-2">
          <Label htmlFor={termsEnId}>Partner terms page (English)</Label>
          <Input
            id={termsEnId}
            type="text"
            inputMode="url"
            value={sandbox ? '' : termsEn}
            maxLength={2048}
            spellCheck={false}
            autoComplete="off"
            disabled={sandbox}
            aria-describedby={termsHelpId}
            placeholder="/legal/partner-terms or https://…"
            onChange={(event) => setTermsEn(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={termsFrId}>Partner terms page (French)</Label>
          <Input
            id={termsFrId}
            type="text"
            inputMode="url"
            value={sandbox ? '' : termsFr}
            maxLength={2048}
            spellCheck={false}
            autoComplete="off"
            disabled={sandbox}
            aria-describedby={`${termsFrId}-help ${termsHelpId}`}
            placeholder="/legal/conditions-partenaires or https://…"
            onChange={(event) => setTermsFr(event.target.value)}
          />
          <p id={`${termsFrId}-help`} className="text-xs text-muted-foreground">
            Empty: French visitors get the English page above when one is set.
          </p>
        </div>
        <div id={termsHelpId} className="space-y-1 text-xs text-muted-foreground">
          <p>
            Leave empty to use the built-in terms. The built-in terms are a starting template, not legal advice: have them
            reviewed, or link your own page.
          </p>
          <p>
            The built-in terms use the legal name and the support email from{' '}
            <Link href={PRIVACY_SETTINGS_HREF} className={TEXT_LINK_CLASS}>
              Settings → Privacy &amp; Consent
            </Link>
            .
            {props.termsContactMissing ? ' No support email is set there yet, so they show partners no contact address.' : null}
          </p>
          <p>
            <a href={BUILT_IN_TERMS_PREVIEW_HREF} target="_blank" rel="noopener noreferrer" className={PREVIEW_LINK_CLASS}>
              Preview built-in terms
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
          {sandbox ? <p>{TERMS_LOCKED_NOTE}</p> : null}
        </div>
      </fieldset>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Saving…' : 'Save settings'}
      </Button>
    </form>
  );
}
