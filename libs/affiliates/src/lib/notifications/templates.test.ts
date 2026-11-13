/* eslint-disable no-script-url -- javascript:/data: URLs are the vectors the templates must never link */
import { describe, expect, it } from 'vitest';

import type { AffiliateEmailData, AffiliateLifecycleEvent, AffiliateLocale } from '../core/types';
import { AFFILIATE_EMAIL_SUBJECT_MAX_LENGTH } from './escape';
import {
  AFFILIATE_EMAIL_BRAND_HEADER_TOKEN,
  buildAffiliateEmail,
  buildAffiliateShareLinks,
  formatAffiliateEmailRate,
} from './templates';

const NBSP = String.fromCharCode(0xa0);

const ALL_EVENTS: AffiliateLifecycleEvent[] = [
  'SIGNED_UP',
  'PROFILE_COMPLETED',
  'PAYOUT_CONFIGURED',
  'PAGE_SUBMITTED',
  'PAGE_PUBLISHED',
  'CHANGES_REQUESTED',
  'COMMISSION_EARNED',
  'PAYOUT_SENT',
  'PAYOUT_FAILED',
  'REFUND_AFTER_PAYOUT',
  'PARTNER_SUSPENDED',
  'PARTNER_REACTIVATED',
  'TIER_CHANGED',
  'PAYPAL_UNCLAIMED',
  'PAYPAL_PAYOUT_FAILED',
];
const ADMIN_EVENTS =['SIGNED_UP', 'PROFILE_COMPLETED', 'PAYOUT_CONFIGURED', 'PAGE_SUBMITTED', 'PAYOUT_FAILED', 'REFUND_AFTER_PAYOUT'] as const;

const ALLOWED_TAGS = new Set(['div', 'table', 'tr', 'td', 'h1', 'p', 'a', 'br']);
const ALLOWED_ATTRIBUTES = new Set([
  'lang',
  'dir',
  'style',
  'role',
  'width',
  'cellpadding',
  'cellspacing',
  'border',
  'align',
  'bgcolor',
  'href',
  'target',
  'rel',
]);

function data(overrides: Partial<AffiliateEmailData> = {}): AffiliateEmailData {
  return {
    locale: 'en',
    siteName: 'Maple Shop',
    siteUrl: 'https://maple.shop',
    recipientName: 'Jane Doe',
    handle: 'jane-doe',
    displayName: 'Jane Doe',
    storefrontUrl: 'https://maple.shop/partners/jane-doe',
    portalUrl: 'https://maple.shop/portal/retailer',
    cmsUrl: 'https://maple.shop/cms/affiliates',
    tierName: 'Founding Ambassador',
    spotsRemaining: 12,
    feedbackNote: 'Please add a disclosure.\nAnd a photo.',
    amountLabel: '$25.00',
    ratePercent: 50,
    clearsAtLabel: 'November 26, 2026',
    transferId: 'tr_123',
    reason: 'balance_insufficient',
    orderId: 'ord-123',
    ...overrides,
  };
}

/** Every tag and attribute of the HTML, checked against the email allowlist. */
function expectSafeMarkup(html: string): void {
  for (const match of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g)) {
    const tag = (match[1] ?? '').toLowerCase();
    expect(ALLOWED_TAGS.has(tag), `tag <${tag}>`).toBe(true);
    for (const attribute of (match[2] ?? '').matchAll(/\s([a-zA-Z-]+)=/g)) {
      expect(ALLOWED_ATTRIBUTES.has((attribute[1] ?? '').toLowerCase()), `attribute ${attribute[1]} on <${tag}>`).toBe(true);
    }
  }
  // A "<" that does not start an allowed tag never appears.
  expect(html.replace(/<\/?(div|table|tr|td|h1|p|a|br)\b[^<>]*>/g, '')).not.toContain('<');
}

function plain(text: string): string {
  return text.split(NBSP).join(' ');
}

describe('buildAffiliateEmail: every event', () => {
  for (const event of ALL_EVENTS) {
    for (const locale of ['en', 'fr'] as AffiliateLocale[]) {
      it(`builds ${event} in ${locale}`, () => {
        const message = buildAffiliateEmail(event, data({ locale }));
        expect(message.subject.trim()).not.toBe('');
        expect(message.subject).not.toMatch(/[\r\n]/);
        expect(message.subject.length).toBeLessThanOrEqual(AFFILIATE_EMAIL_SUBJECT_MAX_LENGTH);
        expect(message.text.trim().length).toBeGreaterThan(40);
        expect(message.html.split(AFFILIATE_EMAIL_BRAND_HEADER_TOKEN)).toHaveLength(2);
        expect(message.html).toContain('<table role="presentation"');
        expect(message.html).not.toMatch(/<style|\sclass=|<script/i);
        expectSafeMarkup(message.html);
        // The token sits at the top of the card, before the heading.
        expect(message.html.indexOf(AFFILIATE_EMAIL_BRAND_HEADER_TOKEN)).toBeLessThan(message.html.indexOf('<h1'));
      });
    }
  }

  it('builds with only the required fields (no amounts, notes, names or tiers)', () => {
    for (const event of ALL_EVENTS) {
      const message = buildAffiliateEmail(event, {
        locale: 'en',
        siteName: '',
        siteUrl: 'https://maple.shop',
        recipientName: null,
        handle: null,
        displayName: null,
        storefrontUrl: null,
        portalUrl: 'https://maple.shop/portal/retailer',
        cmsUrl: 'https://maple.shop/cms/affiliates',
      });
      expect(message.subject, event).not.toBe('');
      expect(message.html).not.toContain('undefined');
      expect(message.text).not.toContain('undefined');
      expect(message.text).not.toContain('null');
      expectSafeMarkup(message.html);
    }
  });

  it('throws for an unknown event', () => {
    expect(() => buildAffiliateEmail('NOPE' as AffiliateLifecycleEvent, data())).toThrow(TypeError);
  });
});

describe('buildAffiliateEmail: escaping', () => {
  const hostile = data({
    siteName: '"><script>alert(1)</script>',
    recipientName: '<img src=x onerror=alert(1)>',
    displayName: 'Jane <b>Doe</b>\r\nBcc: victim@example.com',
    handle: 'jane"onmouseover="x',
    feedbackNote: '<svg onload=alert(1)>\nline two & more',
    tierName: '<iframe src=//evil.example>',
    reason: '</td></tr></table><a href="https://evil.example">click</a>',
    amountLabel: '<b>$1</b>',
    transferId: "tr_'quote'",
    orderId: '<order>',
    payoutEmail: '<img src=x onerror=alert(1)>@evil.example',
    payoutReference: '<svg onload=alert(1)>',
  });

  for (const event of ALL_EVENTS) {
    it(`escapes every value in ${event}`, () => {
      for (const locale of ['en', 'fr'] as AffiliateLocale[]) {
        const message = buildAffiliateEmail(event, { ...hostile, locale });
        expect(message.html).not.toMatch(/<(script|img|svg|iframe|b)\b/i);
        expect(message.html).not.toContain('href="https://evil.example"');
        expectSafeMarkup(message.html);
        expect(message.subject).not.toMatch(/[\r\n]/);
      }
    });
  }

  it('shows hostile text as text', () => {
    const message = buildAffiliateEmail('CHANGES_REQUESTED', hostile);
    expect(message.html).toContain('&lt;svg onload=alert(1)&gt;<br>line two &amp; more');
    expect(message.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(message.text).toContain('<svg onload=alert(1)>\nline two & more');
  });

  it('never links a URL that is not absolute http(s), and falls back to the site', () => {
    const message = buildAffiliateEmail(
      'PAGE_PUBLISHED',
      data({ storefrontUrl: 'javascript:alert(1)', portalUrl: 'data:text/html,x', cmsUrl: '/cms' })
    );
    expect(message.html).not.toMatch(/javascript:|data:text/);
    expect(message.html).toContain('href="https://maple.shop/partners/jane-doe"');
    for (const event of ADMIN_EVENTS) {
      const admin = buildAffiliateEmail(event, data({ cmsUrl: 'javascript:alert(1)', storefrontUrl: 'vbscript:x' }));
      expect(admin.html).not.toMatch(/javascript:|vbscript:/);
    }
    const nowhere = buildAffiliateEmail(
      'COMMISSION_EARNED',
      data({ siteUrl: 'not a url', portalUrl: 'javascript:alert(1)', cmsUrl: 'data:x', storefrontUrl: null })
    );
    expect(nowhere.html).not.toContain('<a ');
  });

  it('only ever links buttons to the site itself', () => {
    for (const event of ALL_EVENTS) {
      const message = buildAffiliateEmail(
        event,
        data({
          portalUrl: 'https://evil.example/portal/retailer',
          cmsUrl: 'https://evil.example/cms/affiliates',
          storefrontUrl: 'https://evil.example/partners/jane-doe',
        })
      );
      for (const match of message.html.matchAll(/href="([^"]*)"/g)) {
        const href = (match[1] ?? '').split('&amp;').join('&');
        const share = /^(https:\/\/(x\.com|www\.facebook\.com|www\.linkedin\.com|www\.pinterest\.com)\/|mailto:\?)/.test(href);
        expect(share || href.startsWith('https://maple.shop/'), `${event}: ${href}`).toBe(true);
        if (share) expect(href).toContain(encodeURIComponent('https://maple.shop/partners/jane-doe'));
      }
    }
  });
});

describe('partner emails', () => {
  it('PAGE_PUBLISHED: live link, URL printed as text, share links built with encodeURIComponent', () => {
    const storefrontUrl = 'https://maple.shop/partners/jane-doe?utm=a&b=c';
    const message = buildAffiliateEmail('PAGE_PUBLISHED', data({ storefrontUrl }));
    const encoded = encodeURIComponent(storefrontUrl);
    expect(message.subject).toBe('Your storefront is live on Maple Shop');
    expect(message.html).toContain(`href="${storefrontUrl.replace('&', '&amp;')}"`);
    expect(message.html).toContain(`>${storefrontUrl.replace('&', '&amp;')}</a>`);
    expect(message.html).toContain(`https://x.com/intent/post?text=${encodeURIComponent('My favorite picks from Maple Shop')}&amp;url=${encoded}`);
    expect(message.html).toContain(`https://www.facebook.com/sharer/sharer.php?u=${encoded}`);
    expect(message.html).toContain(`https://www.linkedin.com/sharing/share-offsite/?url=${encoded}`);
    expect(message.html).toContain(`https://www.pinterest.com/pin/create/button/?url=${encoded}&amp;description=`);
    expect(message.html).toContain('mailto:?subject=');
    expect(message.text).toContain(`View your storefront: ${storefrontUrl}`);
    expect(message.text).toContain(`https://www.facebook.com/sharer/sharer.php?u=${encoded}`);
    expect(message.text).toContain('Hi Jane Doe,');
  });

  it('PAGE_PUBLISHED in Québec French', () => {
    const message = buildAffiliateEmail('PAGE_PUBLISHED', data({ locale: 'fr' }));
    expect(message.subject).toBe('Votre vitrine est en ligne sur Maple Shop');
    expect(message.html).toContain('lang="fr"');
    expect(plain(message.text)).toContain('Bonne nouvelle : nous avons révisé votre vitrine');
    expect(message.text).toContain(`Bonne nouvelle${NBSP}:`);
    expect(message.text).toContain('Partagez votre vitrine');
    expect(message.text).toContain('Envoyer par courriel');
    expect(message.text).toContain('Vous recevez ce courriel parce que vous êtes partenaire de Maple Shop.');
  });

  it('COMMISSION_EARNED says what was earned and when it clears', () => {
    const en = buildAffiliateEmail('COMMISSION_EARNED', data());
    expect(en.subject).toBe('You just earned $25.00');
    expect(en.text).toContain('You just earned 50% ($25.00) — it clears on November 26, 2026.');
    expect(en.html).toContain('You just earned 50% ($25.00) — it clears on November 26, 2026.');

    const fr = buildAffiliateEmail(
      'COMMISSION_EARNED',
      data({ locale: 'fr', amountLabel: `25,00${NBSP}$`, ratePercent: 12.5, clearsAtLabel: '26 novembre 2026' })
    );
    expect(fr.text).toContain(`Vous venez de gagner 12,5${NBSP}% (25,00${NBSP}$) — la commission sera confirmée le 26 novembre 2026.`);
    expect(fr.subject).toBe(`Vous venez de gagner 25,00${NBSP}$`);

    expect(buildAffiliateEmail('COMMISSION_EARNED', data({ clearsAtLabel: null })).text).toContain('You just earned 50% ($25.00).');
    expect(buildAffiliateEmail('COMMISSION_EARNED', data({ ratePercent: null })).text).toContain(
      'You just earned $25.00 — it clears on November 26, 2026.'
    );
    const generic = buildAffiliateEmail('COMMISSION_EARNED', data({ amountLabel: null }));
    expect(generic.subject).toBe('You just earned a commission');
    expect(generic.text).toContain('You just earned a commission on an order placed through your storefront.');
  });

  it('PAYOUT_SENT says the payout went to the bank via Stripe', () => {
    const en = buildAffiliateEmail('PAYOUT_SENT', data({ amountLabel: '$120.00' }));
    expect(en.subject).toBe('Your payout of $120.00 is on its way');
    expect(en.text).toContain('Your automated payout of $120.00 has been sent to your bank via Stripe.');
    expect(en.text).toContain('Stripe transfer: tr_123');
    expect(en.html).toContain('https://maple.shop/portal/retailer');

    const fr = buildAffiliateEmail('PAYOUT_SENT', data({ locale: 'fr', amountLabel: `120,00${NBSP}$` }));
    expect(plain(fr.text)).toContain('Votre versement automatique de 120,00 $ a été envoyé à votre banque par Stripe.');
    expect(plain(fr.text)).toContain('Virement Stripe : tr_123');
  });

  it('PAYOUT_SENT of a manual payout names the channel and the reference, never Stripe (02036)', () => {
    const manual = { payoutMethod: 'manual' as const, transferId: null, payoutReference: '5TY12345AB678901C', payoutNote: 'Thanks for a great month!\nSee you soon.' };
    const en = buildAffiliateEmail('PAYOUT_SENT', data({ ...manual, amountLabel: '$120.00', payoutChannel: 'paypal' }));
    expect(en.subject).toBe('We sent you $120.00');
    expect(en.text).toContain('We sent you $120.00 by PayPal. Reference: 5TY12345AB678901C.');
    expect(en.text).toContain('Reference: 5TY12345AB678901C');
    expect(en.text).toContain('Note from our team:\nThanks for a great month!\nSee you soon.');
    expect(en.html).toContain('Thanks for a great month!<br>See you soon.');
    expect(en.text).not.toMatch(/Stripe/);
    expect(en.html).toContain('href="https://maple.shop/portal/retailer/payouts"');

    const fr = buildAffiliateEmail(
      'PAYOUT_SENT',
      data({ ...manual, locale: 'fr', amountLabel: `120,00${NBSP}$`, payoutChannel: 'interac', payoutNote: null })
    );
    expect(plain(fr.subject)).toBe('Nous vous avons envoyé 120,00 $');
    expect(plain(fr.text)).toContain('Nous vous avons envoyé 120,00 $ par virement Interac. Référence : 5TY12345AB678901C.');
    expect(fr.text).not.toContain('Note de notre équipe');
    expect(fr.text).not.toMatch(/Stripe/);

    // Every channel reads as a phrase; an unknown one says "another payment method".
    const channels = { wise: 'by Wise.', bank_transfer: 'by bank transfer.', other: 'by another payment method.' } as const;
    for (const [channel, phrase] of Object.entries(channels)) {
      expect(buildAffiliateEmail('PAYOUT_SENT', data({ ...manual, payoutReference: null, payoutChannel: channel as never })).text).toContain(
        `We sent you $25.00 ${phrase}`
      );
    }
    expect(buildAffiliateEmail('PAYOUT_SENT', data({ ...manual, payoutChannel: 'venmo' as never })).text).toContain(
      'We sent you $25.00 by another payment method. Reference: 5TY12345AB678901C.'
    );
    const generic = buildAffiliateEmail('PAYOUT_SENT', data({ ...manual, amountLabel: null, payoutChannel: 'paypal' }));
    expect(generic.subject).toBe('We sent your payout');
    expect(generic.text).toContain('We sent your payout by PayPal.');
  });

  it('PAYOUT_SENT of a PayPal payout (02037) says PayPal paid it, with the transaction id, never Stripe or "a few business days"', () => {
    const paypal = { payoutMethod: 'paypal' as const, transferId: null, payoutReference: '5TY12345AB678901C' };
    const en = buildAffiliateEmail('PAYOUT_SENT', data({ ...paypal, amountLabel: '$120.00' }));
    expect(en.subject).toBe('We sent you $120.00 by PayPal');
    expect(en.text).toContain('Your PayPal payout arrived');
    expect(en.text).toContain('We sent you $120.00 by PayPal.');
    expect(en.text).toContain('The money is in your PayPal account now.');
    expect(en.text).toContain('PayPal transaction: 5TY12345AB678901C');
    expect(en.text).not.toMatch(/Stripe|business days|Reference/);
    expect(en.html).toContain('href="https://maple.shop/portal/retailer/payouts"');

    const fr = buildAffiliateEmail('PAYOUT_SENT', data({ ...paypal, locale: 'fr', amountLabel: `120,00${NBSP}$` }));
    expect(plain(fr.subject)).toBe('Nous vous avons envoyé 120,00 $ par PayPal');
    expect(plain(fr.text)).toContain('Nous vous avons envoyé 120,00 $ par PayPal.');
    expect(fr.text).toContain('L’argent est maintenant dans votre compte PayPal.');
    expect(plain(fr.text)).toContain('Transaction PayPal : 5TY12345AB678901C');

    const generic = buildAffiliateEmail('PAYOUT_SENT', data({ ...paypal, amountLabel: null, payoutReference: null }));
    expect(generic.subject).toBe('We sent your payout by PayPal');
    expect(generic.text).toContain('We sent your payout by PayPal.');
    expect(generic.text).not.toContain('PayPal transaction');

    const hostile = buildAffiliateEmail('PAYOUT_SENT', data({ payoutMethod: 'paypal', payoutReference: '<svg onload=alert(1)>', amountLabel: '<b>$1</b>' }));
    expect(hostile.html).not.toMatch(/<(svg|b)\b/i);
    expect(hostile.html).toContain('&lt;svg onload=alert(1)&gt;');
  });

  it('PAYPAL_UNCLAIMED (02037) says the payment waits, where PayPal sent its claim email, and what happens after 30 days', () => {
    const en = buildAffiliateEmail('PAYPAL_UNCLAIMED', data({ amountLabel: '$45.00', payoutEmail: 'jane@paypal.example' }));
    expect(en.subject).toBe('Your PayPal payment of $45.00 is waiting');
    expect(en.text).toContain('Claim your PayPal payment');
    expect(en.text).toContain(
      'Your PayPal payment of $45.00 is waiting: claim it from the email PayPal sent to jane@paypal.example, or update your payout email in the portal.'
    );
    expect(en.text).toContain('PayPal keeps an unclaimed payment for 30 days, then returns it to us');
    // A new payout email does not redirect this payment: it applies from the next payout.
    expect(en.text).toContain(
      'A new payout email is used from your next payout: once this one comes back, the amount goes back to your balance and is sent to your new address.'
    );
    expect(en.text).toContain('Check your payout email: https://maple.shop/portal/retailer/payouts');
    expect(en.text).not.toMatch(/Stripe|tr_123/);

    const fr = buildAffiliateEmail(
      'PAYPAL_UNCLAIMED',
      data({ locale: 'fr', amountLabel: `45,00${NBSP}$`, payoutEmail: 'jane@paypal.example' })
    );
    expect(plain(fr.subject)).toBe('Votre paiement PayPal de 45,00 $ vous attend');
    expect(plain(fr.text)).toContain(
      'Votre paiement PayPal de 45,00 $ vous attend : réclamez-le à partir du courriel que PayPal a envoyé à jane@paypal.example, ou modifiez votre courriel de versement dans le portail.'
    );
    expect(fr.text).toContain(`vous attend${NBSP}:`);
    expect(plain(fr.text)).toContain(
      'Un nouveau courriel de versement s’applique à partir de votre prochain versement : une fois celui-ci retourné, le montant revient dans votre solde et est envoyé à votre nouvelle adresse.'
    );

    // Without the address, or the amount: never "undefined", never an empty "sent to ."
    expect(buildAffiliateEmail('PAYPAL_UNCLAIMED', data({ payoutEmail: null })).text).toContain(
      'Your PayPal payment of $25.00 is waiting: claim it from the email PayPal sent you, or update your payout email in the portal.'
    );
    const generic = buildAffiliateEmail('PAYPAL_UNCLAIMED', data({ amountLabel: null, payoutEmail: 'jane@paypal.example' }));
    expect(generic.subject).toBe('Your PayPal payment is waiting');
    expect(generic.text).toContain('Your PayPal payment is waiting: claim it from the email PayPal sent you');
  });

  it('PAYPAL_PAYOUT_FAILED (02037) words the reason per locale, says the money is back and what happens next', () => {
    // A failure caused by the address (returned, cancelled, blocked, …): PayPal is not tried there again
    // until the partner saves their payout email again; the store pays by hand meanwhile. No retry promised.
    const en = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ amountLabel: '$45.00', reason: 'paypal_returned' }));
    expect(en.subject).toBe('Your PayPal payout of $45.00 could not be sent');
    expect(en.text).toContain(
      'Your PayPal payout of $45.00 was not paid: nobody claimed it within 30 days. In the portal, check that your payout email is the email of your PayPal account and save it again, or choose Interac e-Transfer. Until then, we pay you by hand.'
    );
    expect(en.text).not.toContain('try again');
    expect(en.text).toContain('The amount is back in your balance.');
    expect(en.text).not.toContain('paypal_returned');
    expect(en.html).toContain('href="https://maple.shop/portal/retailer/payouts"');
    // an admin's "Stop payment" of an unclaimed payout is one too
    const cancelled = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ amountLabel: '$45.00', reason: 'paypal_cancelled' }));
    expect(cancelled.text).toContain('Your PayPal payout of $45.00 was not paid: it was cancelled before it was claimed. In the portal,');
    expect(cancelled.text).toContain('Until then, we pay you by hand.');
    expect(cancelled.text).not.toContain('try again');
    // a failure the run does retry keeps the promise
    const retried = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ amountLabel: '$45.00', reason: 'paypal_failed' }));
    expect(retried.text).toContain(
      'Your PayPal payout of $45.00 could not be sent: PayPal could not complete it. Check your payout email in the portal; we’ll try again on the next run.'
    );

    // PayPal's own codes never reach the partner: each reads as a phrase, an unknown one generically.
    const reasons: Array<[string, string, boolean]> = [
      ['paypal_failed:receiver_unregistered', 'this email has no PayPal account', true],
      ['paypal_returned:receiver_unregistered', 'this email has no PayPal account', true],
      ['paypal_failed:receiver_account_locked', 'PayPal could not pay this account', true],
      ['paypal_cancelled', 'it was cancelled before it was claimed', true],
      ['paypal_canceled', 'it was cancelled before it was claimed', true],
      ['paypal_blocked', 'PayPal blocked it', true],
      ['paypal_failed', 'PayPal could not complete it', false],
      ['paypal_refunded', 'PayPal could not complete it', true],
      ['<script>alert(1)</script>', 'PayPal could not complete it', false],
    ];
    for (const [reason, phrase, receiver] of reasons) {
      const message = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ reason }));
      expect(message.text, reason).toContain(receiver ? `was not paid: ${phrase}.` : `could not be sent: ${phrase}.`);
      expect(message.text, reason).not.toContain(reason);
    }

    const fr = buildAffiliateEmail(
      'PAYPAL_PAYOUT_FAILED',
      data({ locale: 'fr', amountLabel: `45,00${NBSP}$`, reason: 'paypal_failed:receiver_unregistered' })
    );
    expect(plain(fr.subject)).toBe('Votre versement PayPal de 45,00 $ n’a pas pu être envoyé');
    expect(plain(fr.text)).toContain(
      'Votre versement PayPal de 45,00 $ n’a pas été payé : ce courriel n’est lié à aucun compte PayPal. Dans le portail, vérifiez que votre courriel de versement est celui de votre compte PayPal et enregistrez-le de nouveau, ou choisissez le virement Interac. D’ici là, nous vous payons manuellement.'
    );
    expect(fr.text).toContain('Le montant est de retour dans votre solde.');
    const frRetried = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ locale: 'fr', amountLabel: `45,00${NBSP}$`, reason: 'paypal_failed' }));
    expect(plain(frRetried.text)).toContain('nous réessaierons au prochain cycle de versement.');

    const generic = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ amountLabel: null, reason: null }));
    expect(generic.subject).toBe('Your PayPal payout could not be sent');
    expect(generic.text).toContain('Your PayPal payout could not be sent: PayPal could not complete it.');
    const genericReceiver = buildAffiliateEmail('PAYPAL_PAYOUT_FAILED', data({ amountLabel: null, reason: 'paypal_returned' }));
    expect(genericReceiver.text).toContain('Your PayPal payout was not paid: nobody claimed it within 30 days.');
  });

  it('COMMISSION_EARNED says how a manually paid commission is paid (02036)', () => {
    const manual = buildAffiliateEmail('COMMISSION_EARNED', data({ payoutMethod: 'manual' }));
    expect(manual.text).toContain('then paid to you directly (by PayPal, Interac e-Transfer or bank transfer) and recorded in your partner portal.');
    expect(manual.text).not.toContain('through Stripe');
    const fr = buildAffiliateEmail('COMMISSION_EARNED', data({ locale: 'fr', payoutMethod: 'manual' }));
    expect(fr.text).toContain('vous sont versées directement (par PayPal, virement Interac ou virement bancaire)');
    expect(buildAffiliateEmail('COMMISSION_EARNED', data()).text).toContain('paid out automatically to your bank account through Stripe.');
  });

  it('CHANGES_REQUESTED carries the reviewer note, then the next step and the edit link', () => {
    const message = buildAffiliateEmail('CHANGES_REQUESTED', data({ portalUrl: 'https://maple.shop/portal/retailer/storefront' }));
    expect(message.subject).toBe('Changes requested on your storefront');
    expect(message.html).toContain('Please add a disclosure.<br>And a photo.');
    expect(message.text).toContain('Note from our team:\nPlease add a disclosure.\nAnd a photo.');
    expect(message.html.indexOf('And a photo.')).toBeLessThan(message.html.indexOf('Update your page'));
    expect(message.html.indexOf('Update your page')).toBeLessThan(message.html.indexOf('href="https://maple.shop/portal/retailer/storefront"'));

    const withoutNote = buildAffiliateEmail('CHANGES_REQUESTED', data({ feedbackNote: '  ' }));
    expect(withoutNote.text).toContain('Open your storefront in the partner portal to see what needs to change.');

    const fr = buildAffiliateEmail('CHANGES_REQUESTED', data({ locale: 'fr' }));
    expect(fr.subject).toBe('Modifications demandées pour votre vitrine');
    expect(plain(fr.text)).toContain('Note de notre équipe :');
  });

  it('PARTNER_SUSPENDED says what stops, keeps the balance, and quotes the reason', () => {
    const reason = 'Chargebacks on 3 orders.\nContact us to discuss.';
    const live = buildAffiliateEmail('PARTNER_SUSPENDED', data({ storefrontLive: true, reason }));
    expect(live.subject).toBe('Your partner account on Maple Shop is suspended');
    expect(live.text).toContain(
      'We suspended your partner account on Maple Shop. Your storefront is offline and your referral links are paused: orders placed through them while your account is suspended do not earn commissions.'
    );
    expect(live.text).toContain('The commissions you already earned stay in your balance, and payouts resume once your account is reactivated.');
    expect(live.text).toContain(`Reason given:\n${reason}`);
    expect(live.html).toContain('Chargebacks on 3 orders.<br>Contact us to discuss.');
    expect(live.text).toContain('Open your partner portal: https://maple.shop/portal/retailer');

    // Never approved: nothing went offline, there is no balance; no reason, no note.
    const unpublished = buildAffiliateEmail('PARTNER_SUSPENDED', data({ storefrontLive: false, reason: null }));
    expect(unpublished.text).toContain("You can’t edit or submit your storefront while your account is suspended.");
    expect(unpublished.text).not.toContain('offline');
    expect(unpublished.text).not.toContain('balance');
    expect(unpublished.text).not.toContain('Reason given');

    const fr = buildAffiliateEmail('PARTNER_SUSPENDED', data({ locale: 'fr', storefrontLive: true, reason: 'Fraude' }));
    expect(fr.subject).toBe('Votre compte partenaire sur Maple Shop est suspendu');
    expect(plain(fr.text)).toContain('Votre vitrine est hors ligne et vos liens de recommandation sont en pause : les commandes');
    expect(plain(fr.text)).toContain('Motif indiqué :\nFraude');
    expect(fr.html).toContain('lang="fr"');
  });

  it('PARTNER_REACTIVATED says the storefront is back, or that editing is', () => {
    const live = buildAffiliateEmail('PARTNER_REACTIVATED', data({ storefrontLive: true }));
    expect(live.subject).toBe('Your partner account on Maple Shop is active again');
    expect(live.text).toContain('Your storefront is back online and your referral links earn commissions again.');
    // Only what reconcile credits: attributed before the suspension, paid during it, 120 days back.
    expect(live.text).toContain(
      'Payouts resume. Orders placed through your links before the suspension and paid while it lasted earn their commission at the next payout run (orders up to 120 days old).'
    );
    expect(live.text).not.toContain('orders you referred');

    const unpublished = buildAffiliateEmail('PARTNER_REACTIVATED', data({ storefrontLive: null }));
    expect(unpublished.text).toContain('You can edit your storefront again and submit it for review.');
    expect(unpublished.text).not.toContain('back online');
    expect(unpublished.text).not.toContain('payout run');

    const fr = buildAffiliateEmail('PARTNER_REACTIVATED', data({ locale: 'fr', storefrontLive: true }));
    expect(fr.subject).toBe('Votre compte partenaire sur Maple Shop est de nouveau actif');
    expect(plain(fr.text)).toContain('Bonne nouvelle : nous avons réactivé votre compte partenaire sur Maple Shop.');
    expect(fr.text).toContain(`Bonne nouvelle${NBSP}:`);
    expect(plain(fr.text)).toContain(
      'Les commandes passées par vos liens avant la suspension et payées pendant celle-ci vous rapportent leur commission au prochain cycle de versement (commandes de 120 jours ou moins).'
    );
  });

  // The rate is stored on each order when it is paid (02035), so it changes at the moment of the
  // move: an order paid earlier that day keeps the old rate. "After this change" says so, like the
  // terms clause, and stays true whenever the email is opened; "from today" would not.
  it('TIER_CHANGED names the new tier and rate, and says the rate applies to orders paid after this change', () => {
    const en = buildAffiliateEmail('TIER_CHANGED', data({ tierName: 'Elite Partner', ratePercent: 35 }));
    expect(en.subject).toBe('Your partner tier on Maple Shop changed');
    expect(en.text).toContain('Hi Jane Doe,');
    expect(en.text).toContain('We moved your partner account on Maple Shop to the Elite Partner tier.');
    expect(en.text).toContain('Your commission rate is now 35%.');
    expect(en.text).toContain('The new rate applies to orders paid after this change. Commissions already recorded keep their rate.');
    expect(en.html).toContain('The new rate applies to orders paid after this change. Commissions already recorded keep their rate.');
    expect(en.text).toContain('Open your partner portal: https://maple.shop/portal/retailer');
    // the tier and the rate come before when they apply
    expect(en.text.indexOf('Elite Partner tier')).toBeLessThan(en.text.indexOf('35%'));
    expect(en.text.indexOf('35%')).toBeLessThan(en.text.indexOf('orders paid after this change'));
    // never a day boundary the database does not use, and a commission email's wording never leaks in
    expect(en.text).not.toMatch(/today/i);
    expect(en.text).not.toMatch(/You just earned|clears on/);

    const fr = buildAffiliateEmail('TIER_CHANGED', data({ locale: 'fr', tierName: 'Partenaire Élite', ratePercent: 12.5 }));
    expect(fr.subject).toBe('Votre niveau de partenaire sur Maple Shop a changé');
    expect(fr.html).toContain('lang="fr"');
    expect(plain(fr.text)).toContain('Nous avons placé votre compte partenaire sur Maple Shop au niveau Partenaire Élite.');
    expect(fr.text).toContain(`Votre taux de commission est maintenant de 12,5${NBSP}%.`);
    expect(fr.text).toContain(
      'Le nouveau taux s’applique aux commandes payées après ce changement. Les commissions déjà inscrites conservent leur taux.'
    );
    expect(fr.text).not.toMatch(/aujourd/i);

    // Without a tier name or a usable rate: a generic line, never "undefined" or a bad percentage.
    const bare = buildAffiliateEmail('TIER_CHANGED', data({ tierName: null, ratePercent: null }));
    expect(bare.text).toContain('We moved your partner account on Maple Shop to another tier.');
    expect(bare.text).not.toContain('commission rate is now');
    expect(bare.text).toContain('The new rate applies to orders paid after this change.');
    expect(buildAffiliateEmail('TIER_CHANGED', data({ ratePercent: 140 })).text).not.toContain('commission rate is now');
  });
});

describe('admin emails', () => {
  it('stay in English whatever the locale', () => {
    for (const event of ADMIN_EVENTS) {
      const en = buildAffiliateEmail(event, data({ locale: 'en' }));
      const fr = buildAffiliateEmail(event, data({ locale: 'fr' }));
      expect(fr).toEqual(en);
      expect(en.html).toContain('lang="en"');
    }
  });

  it('SIGNED_UP shows the tier and the spots left in it', () => {
    const message = buildAffiliateEmail('SIGNED_UP', data());
    expect(message.subject).toBe('New partner signup: Jane Doe');
    expect(message.text).toContain('Tier: Founding Ambassador');
    expect(message.text).toContain('Spots left in this tier: 12');
    expect(message.text).toContain('Handle: @jane-doe');
    const full = buildAffiliateEmail('SIGNED_UP', data({ spotsRemaining: 0 }));
    expect(full.text).toContain('This tier is now full');
    const unlimited = buildAffiliateEmail('SIGNED_UP', data({ spotsRemaining: null }));
    expect(unlimited.text).not.toContain('Spots left');
  });

  it('PAGE_SUBMITTED links to the approvals queue and prints the URL', () => {
    const cmsUrl = 'https://maple.shop/cms/affiliates/approvals';
    const message = buildAffiliateEmail('PAGE_SUBMITTED', data({ cmsUrl }));
    expect(message.subject).toBe('Storefront waiting for review: Jane Doe');
    expect(message.html).toContain(`href="${cmsUrl}"`);
    expect(message.html).toContain(`>${cmsUrl}</a>`);
    expect(message.text).toContain(`Review storefronts: ${cmsUrl}`);
    // Whatever CMS URL the caller passed, the button opens the queue; a deep link into it is kept.
    expect(buildAffiliateEmail('PAGE_SUBMITTED', data({ cmsUrl: 'https://maple.shop/cms/affiliates' })).text).toContain(
      `Review storefronts: ${cmsUrl}`
    );
    expect(
      buildAffiliateEmail('PAGE_SUBMITTED', data({ cmsUrl: 'https://maple.shop/cms/affiliates/approvals?page=p1' })).text
    ).toContain('Review storefronts: https://maple.shop/cms/affiliates/approvals?page=p1');
  });

  it('sends each admin and partner button to its own screen', () => {
    const expected: Record<AffiliateLifecycleEvent, string> = {
      SIGNED_UP: 'https://maple.shop/cms/affiliates',
      PROFILE_COMPLETED: 'https://maple.shop/cms/affiliates',
      PAYOUT_CONFIGURED: 'https://maple.shop/cms/affiliates',
      PAGE_SUBMITTED: 'https://maple.shop/cms/affiliates/approvals',
      PAYOUT_FAILED: 'https://maple.shop/cms/affiliates/payouts',
      REFUND_AFTER_PAYOUT: 'https://maple.shop/cms/affiliates/payouts',
      PAGE_PUBLISHED: 'https://maple.shop/partners/jane-doe',
      CHANGES_REQUESTED: 'https://maple.shop/portal/retailer/storefront',
      COMMISSION_EARNED: 'https://maple.shop/portal/retailer/payouts',
      PAYOUT_SENT: 'https://maple.shop/portal/retailer/payouts',
      PARTNER_SUSPENDED: 'https://maple.shop/portal/retailer',
      PARTNER_REACTIVATED: 'https://maple.shop/portal/retailer',
      TIER_CHANGED: 'https://maple.shop/portal/retailer',
      PAYPAL_UNCLAIMED: 'https://maple.shop/portal/retailer/payouts',
      PAYPAL_PAYOUT_FAILED: 'https://maple.shop/portal/retailer/payouts',
    };
    for (const event of ALL_EVENTS) {
      const message = buildAffiliateEmail(event, data({ cmsUrl: 'https://maple.shop/cms', portalUrl: 'https://maple.shop/' }));
      expect(message.html, event).toContain(`<a href="${expected[event]}" target="_blank" rel="noopener noreferrer" style="display:inline-block;`);
    }
    // No storefront URL given: built from the site and the handle.
    expect(buildAffiliateEmail('PAGE_PUBLISHED', data({ storefrontUrl: null })).text).toContain(
      'View your storefront: https://maple.shop/partners/jane-doe'
    );
  });

  it('PAYOUT_FAILED and REFUND_AFTER_PAYOUT give the amount, the reason and the order', () => {
    const failed = buildAffiliateEmail('PAYOUT_FAILED', data());
    expect(failed.text).toContain('The automated payout of $25.00 to Jane Doe failed.');
    expect(failed.text).toContain('Reason: balance_insufficient');
    const refund = buildAffiliateEmail('REFUND_AFTER_PAYOUT', data());
    expect(refund.text).toContain(
      'Order ord-123 was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.'
    );
    // A payout recorded by hand (02036): no Stripe transfer to reverse.
    const manual = buildAffiliateEmail('REFUND_AFTER_PAYOUT', data({ payoutMethod: 'manual', transferId: null }));
    expect(manual.text).toContain(
      'Order ord-123 was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.'
    );
    expect(manual.text).not.toContain('Reverse the transfer');
    expect(manual.text).not.toMatch(/deduct/i);
    expect(buildAffiliateEmail('REFUND_AFTER_PAYOUT', data({ payoutMethod: 'manual', orderId: null })).text).toContain(
      'An order was refunded after its commission was paid or queued. Recover the amount from the partner'
    );
    // Its manual payout is only prepared: cancel and prepare again if the money has not left yet.
    const prepared = buildAffiliateEmail('REFUND_AFTER_PAYOUT', data({ payoutMethod: 'manual', payoutPrepared: true, transferId: null }));
    expect(prepared.text).toContain(
      'Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner'
    );
  });

  it('PROFILE_COMPLETED names the next step without promising Stripe (a partner paid by hand saves a payout email)', () => {
    const email = buildAffiliateEmail('PROFILE_COMPLETED', data());
    expect(email.text).toContain('Their next step is setting up their payouts.');
    expect(email.text).not.toContain('Stripe');
  });

  it('never link or print the live storefront URL (a click would set the partner’s referral cookie)', () => {
    for (const event of ADMIN_EVENTS) {
      const message = buildAffiliateEmail(event, data({ storefrontUrl: 'https://maple.shop/partners/jane-doe' }));
      for (const match of message.html.matchAll(/href="([^"]*)"/g)) {
        expect(match[1], `${event}: ${match[1]}`).not.toContain('/partners/');
      }
      // Not as text either: mail clients turn a printed URL into a link.
      expect(message.html, event).not.toContain('maple.shop/partners/');
      expect(message.text, event).not.toContain('maple.shop/partners/');
    }
    // The reviewer still reads the public address, as a path nothing turns into a link.
    for (const event of ['SIGNED_UP', 'PAGE_SUBMITTED'] as const) {
      const message = buildAffiliateEmail(event, data());
      expect(message.text, event).toContain('Storefront: /partners/jane-doe');
      expect(message.html, event).toMatch(/<td [^>]*>\/partners\/jane-doe<\/td>/);
    }
    // A handle that is not a handle prints nothing.
    expect(buildAffiliateEmail('PAGE_SUBMITTED', data({ handle: 'jane"onmouseover="x' })).text).not.toContain('Storefront:');
  });

  it('names the partner by handle, or generically, when the display name is missing', () => {
    expect(buildAffiliateEmail('PROFILE_COMPLETED', data({ displayName: null })).subject).toBe('Partner profile completed: @jane-doe');
    expect(buildAffiliateEmail('PROFILE_COMPLETED', data({ displayName: null, handle: null })).subject).toBe(
      'Partner profile completed: A partner'
    );
  });
});

describe('helpers', () => {
  it('formatAffiliateEmailRate formats per locale and refuses nonsense', () => {
    expect(formatAffiliateEmailRate(50, 'en')).toBe('50%');
    expect(formatAffiliateEmailRate(12.5, 'en')).toBe('12.5%');
    expect(formatAffiliateEmailRate(12.5, 'fr')).toBe(`12,5${NBSP}%`);
    expect(formatAffiliateEmailRate('35', 'en')).toBe('35%');
    for (const value of [null, undefined, '', Number.NaN, -1, 101, 'abc']) {
      expect(formatAffiliateEmailRate(value, 'en'), String(value)).toBeNull();
    }
  });

  it('buildAffiliateShareLinks covers the five networks, or none for an unusable URL', () => {
    const links = buildAffiliateShareLinks({ url: 'https://maple.shop/partners/jane', text: 'My picks', locale: 'en' });
    expect(links.map((link) => link.network)).toEqual(['x', 'facebook', 'linkedin', 'pinterest', 'email']);
    expect(links.every((link) => link.url.includes(encodeURIComponent('https://maple.shop/partners/jane')))).toBe(true);
    expect(buildAffiliateShareLinks({ url: 'javascript:alert(1)', text: 'x', locale: 'en' })).toEqual([]);
    expect(buildAffiliateShareLinks({ url: null, text: 'x', locale: 'fr' })).toEqual([]);
    expect(buildAffiliateShareLinks({ url: 'https://maple.shop/p', text: 'x', locale: 'fr' })[4]?.label).toBe('Envoyer par courriel');
  });
});
