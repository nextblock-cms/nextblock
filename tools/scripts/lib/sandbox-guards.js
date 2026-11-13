// The public sandbox keeps its refusals.
//
// The sandbox (`NEXT_PUBLIC_IS_SANDBOX=true`) publishes its admin login (and the demo partner's
// once the Affiliates demo is configured), so every visitor is the admin there. Every 15 minutes the reset rebuilds the database and empties the
// bucket; it cannot unsend mail, undo what GoTrue or a payment provider did, or take back a secret
// another visitor already read. Until 2026-11-03 a visitor could create accounts and mail an
// address they typed (site sign-up, partner sign-up, /cms/users), relay mail through the site's
// SMTP (message replies, comment notices), plant a script that read other visitors' OpenRouter
// keys, push live coupons to the operator's Freemius products, and break the shared demo accounts.
//
// SANDBOX_GUARDS lists each function that refuses (or renders nothing) on the sandbox, why, and
// the test that proves the refusal. The check parses the module and fails when a listed function
// stops reading the sandbox flag: `isSandboxEnvironment()`, or `process.env.NEXT_PUBLIC_IS_SANDBOX`
// compared with 'true', directly or through a binding of the same module. It also parses the test,
// which must set the flag to 'true' (`vi.stubEnv` or a direct `process.env` assignment) and use
// every listed function.
//
// Four reverse scans keep new code from skipping the question. A module that creates a mail
// transport, calls a GoTrue API that creates or changes an account, a second factor or an
// identity (or sends auth mail), writes to object storage, or writes to a payment provider (a
// Stripe call that is not a read, a Freemius fetch that is not a GET or HEAD, a Freemius SDK
// write verb, typed-service write or portal processor) must be listed in MAIL_SENDERS /
// ACCOUNT_WRITERS / STORAGE_WRITERS / VENDOR_WRITERS with how it behaves on the sandbox. For mail,
// accounts and payment providers the check goes further, function by function: each call must sit
// in a SANDBOX_GUARDS function of its module, in a private helper or class only those reach, or in
// a function or class the entry exempts by name; code that runs at import never does. Client
// handles resolve by lexical scope, so a same-named local elsewhere cannot borrow one.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const { scanRepository } = require('./service-role-boundary.js');

const REPO_ROOT = path.resolve(__dirname, '../../..');

const SANDBOX_FLAG = 'NEXT_PUBLIC_IS_SANDBOX';

/**
 * Functions other modules call to read the flag. A call to one counts as a check, so each must
 * read the flag itself (checked like a guard).
 */
const FLAG_READERS = [{ file: 'libs/db/src/lib/config-resolve.ts', name: 'isSandboxEnvironment' }];

/** How many same-module bindings a guard may go through to reach the flag. */
const MAX_BINDING_DEPTH = 3;

const MONEY_WHY = 'It moves real money through Stripe; nothing on the sandbox may.';
const AI_KEYS_WHY =
  "AI keys stored in the database would be spent by every visitor; on the sandbox each visitor's own key stays in their browser.";
const SCRIPTS_WHY =
  'A script saved there would run for every later visitor, /cms and the partner portal included, and could read the OpenRouter keys visitors keep in localStorage.';

/**
 * Functions that refuse (or render nothing) on the sandbox. `functions` are export names
 * (`default` for a default export) or top-level bindings of the module; `test` sets the flag and
 * proves the refusal.
 */
const SANDBOX_GUARDS = [
  // Accounts and auth mail.
  {
    file: 'apps/nextblock/app/actions.ts',
    functions: ['signUpAction', 'forgotPasswordAction', 'resetPasswordAction'],
    test: 'apps/nextblock/app/actions.test.ts',
    why: 'Sign-up and password resets create accounts or mail an address the visitor typed, and a password change locks every visitor out of the shared demo admin.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/signup.ts',
    functions: ['submitAffiliateSignup'],
    test: 'apps/nextblock/lib/affiliates/signup.test.ts',
    why: 'Partner sign-up creates an account and mails the address the visitor typed; on the sandbox it runs the checks and writes nothing.',
  },
  {
    file: 'apps/nextblock/app/cms/users/actions.ts',
    functions: ['createUser', 'updateUserProfile', 'deleteUserAndProfile'],
    test: 'apps/nextblock/app/cms/users/actions.test.ts',
    why: 'Visitors share the demo accounts: creating, changing or deleting a user mints live accounts or locks everyone out. The reset deletes every account but two preserved ids, then restores (or re-creates) the demo admin and re-creates the demo partners; it never re-creates the other preserved account, so deleting that one is permanent.',
  },
  {
    file: 'apps/nextblock/app/profile/password/actions.ts',
    functions: ['changePasswordAction'],
    test: 'apps/nextblock/app/profile/password/actions.test.ts',
    why: 'Changing the shared demo password locks every other visitor out until the reset.',
  },
  {
    file: 'apps/nextblock/app/cms/settings/registration/actions.ts',
    functions: ['updateRegistrationSettings'],
    test: 'apps/nextblock/app/cms/settings/registration/actions.test.ts',
    why: 'Sign-up settings are fixed on the sandbox, where every sign-up path refuses.',
  },
  {
    file: 'apps/nextblock/app/cms/settings/security/actions.ts',
    functions: [
      'updateAutoAcceptSignups',
      'updateGlobalSecuritySettings',
      'startTotpEnrollment',
      'verifyTotpEnrollment',
      'sendEmailEnrollmentCode',
      'verifyEmailEnrollment',
      'disableMfa',
      'revokeTrustedDeviceAction',
    ],
    test: 'apps/nextblock/app/cms/settings/security/actions.test.ts',
    why: "Sign-up and second-factor policy are fixed on the sandbox: the published demo logins rely on them, and a factor enrolled on a shared account makes is_admin_mfa() demand aal2 from every visitor until the next reset removes it (restoreDemoAdmin deletes the demo admin's factors; Step A deletes the partners').",
  },
  {
    file: 'apps/nextblock/lib/cortex-ai/sandbox-headers.ts',
    functions: ['clearSandboxCortexKey'],
    test: 'apps/nextblock/lib/cortex-ai/sandbox-headers.test.ts',
    why: "Visitors share the demo accounts: a key or chat left after sign-out is the next person's on a shared machine.",
  },
  // Mail.
  {
    file: 'apps/nextblock/app/actions/email.ts',
    functions: ['sendEmail'],
    test: 'apps/nextblock/app/actions/email.test.ts',
    why: 'Every app email goes through sendEmail; on the sandbox it delivers only to SANDBOX_CONTACT_EMAIL and the product feedback inbox (PRODUCT_FEEDBACK_INBOX), so message replies and comment notices cannot relay mail to an address a visitor chose.',
  },
  {
    file: 'apps/nextblock/lib/config/email-settings.ts',
    functions: ['saveEmailSettings', 'resolveEmailServerConfig'],
    test: 'apps/nextblock/lib/config/email-settings.test.ts',
    why: 'A visitor-chosen SMTP host would receive the env credentials; the sandbox reads SMTP from the env only.',
  },
  {
    file: 'apps/nextblock/app/cms/settings/email/actions.ts',
    functions: ['sendTestEmail'],
    test: 'apps/nextblock/app/cms/settings/email/actions.test.ts',
    why: 'A test email goes to any address the visitor types.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/notify.ts',
    functions: ['notifyAffiliateLifecycle', 'sweepAffiliateCommissionNotifications', 'sweepAffiliateRefundAlertEmails'],
    test: 'apps/nextblock/lib/affiliates/notify.test.ts',
    why: 'Partner notices mail partner addresses; the sandbox mails nobody.',
  },
  // Money.
  {
    file: 'apps/nextblock/app/api/checkout/route.ts',
    functions: ['POST'],
    test: 'apps/nextblock/app/api/checkout/route.test.ts',
    why: 'Checkout opens a real payment session with the store keys; the storefront simulates it on the sandbox.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/payout-runner.ts',
    functions: ['resolveAffiliateStripeClient', 'maybeRunAffiliatePayouts', 'runAffiliatePayoutCycleNow', 'retryAffiliatePayoutNow', 'releaseAffiliatePayoutNow'],
    test: 'apps/nextblock/lib/affiliates/payout-runner.test.ts',
    why: MONEY_WHY,
  },
  {
    file: 'apps/nextblock/app/cms/affiliates/actions.ts',
    functions: ['testAffiliateStripeSetup'],
    test: 'apps/nextblock/app/cms/affiliates/actions.test.ts',
    why: "The sandbox's Stripe key comes from the deployment's env and belongs to its operator: \"Test connection\" answers before any Stripe call.",
  },
  // PayPal Payouts (02037): real money from the operator's PayPal balance, with credentials that are
  // the operator's (CMS-saved or env).
  {
    file: 'apps/nextblock/lib/affiliates/paypal/client.ts',
    functions: ['sendAffiliatePayPalRequest'],
    test: 'apps/nextblock/lib/affiliates/paypal/client.test.ts',
    why: 'Every PayPal request (token, payout batch, cancel, reads) goes through it: on the sandbox it throws before any fetch, so PayPal is never called whatever reaches it.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/paypal/credentials.ts',
    functions: [
      'resolveAffiliatePayPalEnvironment',
      'resolveAffiliatePayPalCredentials',
      'getAffiliatePayPalCredentialStatus',
      'storeAffiliatePayPalCredentials',
      'previewAffiliatePayPalCredentials',
    ],
    test: 'apps/nextblock/lib/affiliates/paypal/credentials.test.ts',
    why: "PayPal credentials a visitor saved would pay out of a PayPal account of their choosing for every later visitor, and the env pair belongs to the operator: the sandbox neither saves nor reads either (no fact about them is shown).",
  },
  {
    file: 'apps/nextblock/lib/affiliates/paypal/engine.ts',
    functions: ['runAffiliatePayPalPayouts', 'cancelAffiliatePayPalPayout'],
    test: 'apps/nextblock/lib/affiliates/paypal/engine.test.ts',
    why: 'The PayPal payout run claims commissions and sends PayPal payout batches; the CMS Cancel cancels an unclaimed item at PayPal. Both answer sandbox before reading anything.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/paypal/runner.ts',
    functions: ['runAffiliatePayPalStep'],
    test: 'apps/nextblock/lib/affiliates/paypal/runner.test.ts',
    why: 'The PayPal step of every payout run returns null on the sandbox before it reads a credential or a payout.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/paypal/admin.ts',
    functions: [
      'loadAffiliatePayPalPayoutsOverview',
      'testAffiliatePayPalConnectionNow',
      'saveAffiliatePayPalCredentialsNow',
      'syncAffiliatePayPalPayoutsNow',
      'cancelAffiliatePayPalPayoutNow',
    ],
    test: 'apps/nextblock/lib/affiliates/paypal/admin.test.ts',
    why: "The PayPal payouts screen's work: on the sandbox it asks PayPal nothing, shows no credential fact, saves no credential and cancels nothing, whatever calls it.",
  },
  {
    file: 'apps/nextblock/app/cms/affiliates/paypal/actions.ts',
    functions: [
      'saveAffiliatePayPalCredentialsAction',
      'testAffiliatePayPalConnectionAction',
      'syncAffiliatePayPalPayoutsAction',
      'cancelAffiliatePayPalPayoutAction',
    ],
    test: 'apps/nextblock/app/cms/affiliates/paypal/actions.test.ts',
    why: 'The PayPal payouts screen\'s actions are refused right after the admin check, before the input is read: no credential is saved, PayPal is never asked, nothing is cancelled.',
  },
  {
    file: 'apps/nextblock/app/cms/affiliates/actions.ts',
    functions: [
      'prepareManualAffiliatePayoutAction',
      'prepareManualAffiliatePayPalPayoutsAction',
      'recordManualAffiliatePayoutAction',
      'cancelManualAffiliatePayoutAction',
    ],
    test: 'apps/nextblock/app/cms/affiliates/actions.test.ts',
    why: "Preparing, recording or cancelling a manual payout reserves, marks paid or hands back the shared demo partner's commissions (and recording mails the partner); each is refused right after the admin check, before the input is read.",
  },
  {
    file: 'apps/nextblock/lib/affiliates/manual-payouts.ts',
    functions: [
      'prepareManualAffiliatePayoutNow',
      'prepareManualAffiliatePayPalPayoutsNow',
      'recordManualAffiliatePayoutNow',
      'cancelManualAffiliatePayoutNow',
    ],
    test: 'apps/nextblock/lib/affiliates/manual-payouts.test.ts',
    why: 'The writes behind "Pay manually" refuse on the sandbox too, whatever calls them: no payout is prepared, recorded or cancelled for the shared demo partner and no PAYOUT_SENT email is scheduled.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/payout-setup.ts',
    functions: ['testAffiliateStripeSetupNow', 'loadAffiliateStripePayoutsOverview'],
    test: 'apps/nextblock/lib/affiliates/payout-setup.test.ts',
    why: "The sandbox's Stripe key belongs to its operator: the Stripe payouts screen and its connection test ask Stripe nothing there (the ledger's demo figures still show).",
  },
  {
    file: 'apps/nextblock/app/api/affiliates/cron/payouts/route.ts',
    functions: ['GET', 'POST'],
    test: 'apps/nextblock/app/api/affiliates/cron/payouts/route.test.ts',
    why: MONEY_WHY,
  },
  {
    file: 'apps/nextblock/app/(portal)/portal/retailer/actions.ts',
    functions: ['startStripeConnectOnboarding', 'refreshStripeConnectStatus', 'openStripeExpressDashboard'],
    test: 'apps/nextblock/app/(portal)/portal/retailer/actions.test.ts',
    why: 'Stripe Connect onboarding creates real connected accounts on the platform.',
  },
  {
    file: 'apps/nextblock/app/(portal)/portal/retailer/payouts/connect/refresh/route.ts',
    functions: ['GET'],
    test: 'apps/nextblock/app/(portal)/portal/retailer/payouts/connect/refresh/route.test.ts',
    why: 'Stripe Connect onboarding creates real connected accounts on the platform.',
  },
  {
    file: 'apps/nextblock/app/api/packages/provision-trial/route.ts',
    functions: ['POST'],
    test: 'apps/nextblock/app/api/packages/provision-trial/route.test.ts',
    why: "It mints a real trial license on the operator's Freemius product: the sandbox answers 404 even with the vendor flag copied into its env.",
  },
  {
    file: 'apps/nextblock/lib/packages/revalidate-activations.ts',
    functions: ['maybeRevalidatePackageActivations'],
    test: 'apps/nextblock/lib/packages/revalidate-activations.test.ts',
    why: 'It re-issues Freemius licenses/activate.json for every activation; the sandbox seeds placeholder activations and asks Freemius nothing.',
  },
  {
    file: 'libs/ecommerce/src/lib/freemius-coupons.ts',
    functions: ['freemiusCouponRequest', 'syncCouponToFreemius', 'syncProductSaleCouponToFreemius', 'deleteCouponFromFreemius'],
    test: 'libs/ecommerce/src/lib/freemius-coupons.test.ts',
    why: "Coupon, sale-price and promotion saves would create, change or delete live coupons on the operator's real Freemius products (the reset syncs their ids) with the deployment's bearer, and a remote coupon outlives the reset.",
  },
  // Secrets later visitors would read or spend.
  {
    file: 'libs/ecommerce/src/lib/payment-config.ts',
    functions: ['savePaymentCredentials', 'loadPaymentRows', 'hydrateFreemiusEnvFromDb', 'getPaymentCredentialsView'],
    test: 'libs/ecommerce/src/lib/payment-config.test.ts',
    why: 'Payment rows a visitor writes (the CMS form, PostgREST as the factor-less demo admin, Cortex DB tools) would be used for every later visitor, and hydrateFreemiusEnvFromDb would copy their Freemius ids into process.env, which no reset clears: the sandbox neither saves nor reads them.',
  },
  {
    file: 'libs/ecommerce/src/lib/payment-config.ts',
    functions: ['getStripeKeyDiagnostics'],
    test: 'libs/ecommerce/src/lib/payment-config.test.ts',
    why: "The key facts (source, mode, last 4 characters) would describe the operator's env key to every visitor: on the sandbox nothing is read and every fact is empty.",
  },
  {
    file: 'apps/nextblock/app/cms/settings/bot-protection/actions.ts',
    functions: ['updateBotProtectionSettings', 'getBotProtectionSettings'],
    test: 'apps/nextblock/app/cms/settings/bot-protection/actions.test.ts',
    why: 'A captcha secret saved there would be shown to every later visitor.',
  },
  {
    file: 'apps/nextblock/app/cms/settings/cortex-ai/actions.ts',
    functions: [
      'saveOpenRouterApiKeyAction',
      'clearOpenRouterApiKeyAction',
      'saveStockPhotoKeysAction',
      'clearStockPhotoKeysAction',
      'saveCortexAiAgentSettingsAction',
      'resetCortexAiAgentSettingsAction',
      'saveCortexAiModelSelectionAction',
      'clearCortexAiModelSelectionAction',
    ],
    test: 'apps/nextblock/app/cms/settings/cortex-ai/actions.test.ts',
    why: AI_KEYS_WHY,
  },
  {
    file: 'apps/nextblock/app/cms/settings/cortex-ai/setup/actions.ts',
    functions: [
      'connectOpenRouterKeyAction',
      'selectModelForSetupAction',
      'saveStockPhotoKeysForSetupAction',
      'enableMcpForSetupAction',
      'reuseExistingMcpTokenForSetupAction',
      'completeCortexSetupAction',
    ],
    test: 'apps/nextblock/app/cms/settings/cortex-ai/setup/actions.test.ts',
    why: AI_KEYS_WHY,
  },
  {
    file: 'apps/nextblock/app/cms/settings/cortex-ai/setup/brief-actions.ts',
    functions: ['saveSiteBriefFromFormAction'],
    test: 'apps/nextblock/app/cms/settings/cortex-ai/setup/brief-actions.test.ts',
    why: 'The setup wizard stores nothing on the sandbox, where every visitor shares its answers.',
  },
  {
    file: 'apps/nextblock/app/cms/settings/cortex-ai/mcp-actions.ts',
    functions: ['saveMcpSettingsAction', 'createMcpAccessTokenAction', 'revokeMcpAccessTokenAction'],
    test: 'apps/nextblock/app/cms/settings/cortex-ai/mcp-actions.test.ts',
    why: 'An MCP token minted there would let whoever holds it drive the shared admin from outside the site.',
  },
  {
    file: 'apps/nextblock/app/actions/package-actions.ts',
    functions: ['activatePackage', 'activatePurchasedPackage', 'deactivatePackage', 'resendPurchasedLicenseEmail'],
    test: 'apps/nextblock/app/actions/package-actions.test.ts',
    why: "Activating a license there would spend a real seat (the reset activates placeholder licenses itself), and a resend has Freemius mail a license email on a visitor's request.",
  },
  {
    file: 'apps/nextblock/lib/full-backup/server.ts',
    functions: ['requireFullBackupAdmin', 'exportFullBackupArchive', 'reviewFullBackupArchiveForAdmin', 'restoreFullBackupArchive'],
    test: 'apps/nextblock/lib/full-backup/server.test.ts',
    why: "A full backup hands out the whole database and every account's password hash, and a restore creates, updates and deletes accounts through GoTrue; only pg_dump/psql missing from the host used to stop either on the sandbox.",
  },
  // Scripts that run for every visitor.
  {
    file: 'apps/nextblock/components/SiteScripts.tsx',
    functions: ['default'],
    test: 'apps/nextblock/components/SiteScripts.test.tsx',
    why: SCRIPTS_WHY,
  },
  {
    file: 'apps/nextblock/components/privacy/ConsentGatedAnalytics.tsx',
    functions: ['ConsentGatedAnalytics'],
    test: 'apps/nextblock/components/privacy/ConsentGatedAnalytics.test.tsx',
    why: `Custom scripts and a GTM container run for every visitor. ${SCRIPTS_WHY}`,
  },
  {
    file: 'apps/nextblock/app/cms/settings/site-scripts/actions.ts',
    functions: ['createSiteScript', 'updateSiteScript', 'setSiteScriptActive', 'deleteSiteScript', 'revertSiteScript'],
    test: 'apps/nextblock/app/cms/settings/site-scripts/actions.test.ts',
    why: `The render guard (SiteScripts) is the one that protects visitors; this keeps the CMS from claiming a save. ${SCRIPTS_WHY}`,
  },
  {
    file: 'apps/nextblock/app/cms/settings/google-analytics/actions.ts',
    functions: ['updateGoogleAnalyticsSettings'],
    test: 'apps/nextblock/app/cms/settings/google-analytics/actions.test.ts',
    why: `Custom scripts and a GTM container run for every visitor. ${SCRIPTS_WHY}`,
  },
  // The shared demo partner.
  {
    file: 'apps/nextblock/app/cms/affiliates/actions.ts',
    functions: [
      'suspendAffiliatePartnerAction',
      'reactivateAffiliatePartnerAction',
      'changeAffiliatePartnerTierAction',
      'removeAffiliatePartnerAction',
    ],
    test: 'apps/nextblock/app/cms/affiliates/actions.test.ts',
    why: 'The demo partner is shared: pausing it, removing it or moving its tier breaks the portal for every visitor.',
  },
  {
    file: 'apps/nextblock/lib/affiliates/review.ts',
    functions: ['removeAffiliatePartner', 'changeAffiliatePartnerTier'],
    test: 'apps/nextblock/lib/affiliates/review.test.ts',
    why: 'Removing a partner deletes its storefront and demotes its account, and a tier move changes the demo partner\'s rate and the spots left; the demo partners every visitor shares come back only with the next reset.',
  },
  {
    file: 'apps/nextblock/app/(portal)/portal/retailer/actions.ts',
    functions: ['saveRetailerPayoutEmail'],
    test: 'apps/nextblock/app/(portal)/portal/retailer/actions.test.ts',
    why: "The demo partner is shared: a payout email saved there would be shown to every later visitor (the portal, the CMS Pay manually list) and listed in the PayPal payouts file, so a visitor's own address would leak to the next one. It is refused right after the partner check.",
  },
  // Links every visitor follows.
  {
    file: 'apps/nextblock/app/cms/affiliates/actions.ts',
    functions: ['saveAffiliatesProgramSettings'],
    test: 'apps/nextblock/app/cms/affiliates/actions.test.ts',
    why: "A partner terms link saved there would send every later visitor (the /partners/terms redirect, the sign-up form's terms link, the portal's) to an address a visitor chose: a non-empty one is refused, the other program settings save as anywhere else.",
  },
  {
    file: 'apps/nextblock/lib/affiliates/settings.ts',
    functions: ['normalizeAffiliateTermsUrl', 'getPublicAffiliatesProgramSettings'],
    test: 'apps/nextblock/lib/affiliates/settings.test.ts',
    why: 'A terms link written into affiliates_settings another way (over PostgREST as the demo admin, whose second factor is always satisfied there) must redirect nobody either: every read drops it on the sandbox.',
  },
  // The reset itself.
  {
    file: 'apps/nextblock/app/api/cron/reset-sandbox/route.ts',
    functions: ['GET'],
    test: 'apps/nextblock/app/api/cron/reset-sandbox/route.test.ts',
    why: 'The reset drops the public schema and empties the bucket: anywhere but the sandbox it must answer 404.',
  },
];

/**
 * Modules that create a mail transport, with how they behave on the sandbox. `exempt` names
 * functions that send without a sandbox refusal of their own, each with the reason that is safe.
 */
const MAIL_SENDERS = new Map([
  [
    'apps/nextblock/app/actions/email.ts',
    {
      why: 'sendEmail delivers only to SANDBOX_CONTACT_EMAIL and the product feedback inbox (PRODUCT_FEEDBACK_INBOX) on the sandbox (SANDBOX_GUARDS).',
    },
  ],
]);

/**
 * Modules that call a GoTrue API which creates or changes an account, a second factor or an
 * identity, or sends auth mail. `exempt` as for MAIL_SENDERS.
 */
const ACCOUNT_WRITERS = new Map([
  ['apps/nextblock/app/actions.ts', { why: 'signUpAction, forgotPasswordAction and resetPasswordAction refuse on the sandbox (SANDBOX_GUARDS).' }],
  ['apps/nextblock/app/cms/users/actions.ts', { why: 'every user write refuses on the sandbox (SANDBOX_GUARDS).' }],
  ['apps/nextblock/app/profile/password/actions.ts', { why: 'changePasswordAction redirects away on the sandbox (SANDBOX_GUARDS).' }],
  ['apps/nextblock/lib/affiliates/signup.ts', { why: 'submitAffiliateSignup stops before any write on the sandbox (SANDBOX_GUARDS).' }],
  [
    'apps/nextblock/app/cms/settings/security/actions.ts',
    { why: 'second-factor enrollment, verification, disabling and device changes refuse on the sandbox (SANDBOX_GUARDS).' },
  ],
  [
    'apps/nextblock/app/(auth-pages)/two-factor/actions.ts',
    {
      why: 'the sign-in challenge steps a session up with a factor the account already has.',
      exempt: {
        verifyTotpChallenge:
          'mfa.challenge and mfa.verify only check a code against an existing factor: nothing is created, changed or mailed (on the sandbox the second factor reads satisfied, so the page is never reached).',
      },
    },
  ],
  [
    'apps/nextblock/app/api/cron/reset-sandbox/route.ts',
    {
      why: 'the reset re-creates or restores the demo admin and deletes its second factors (restoreDemoAdmin, right after the SQL reset and before every later step; a failure in the bucket wipe, the seed upload or the SQL ends that run first); it answers 404 off the sandbox and needs the cron secret (GET is in SANDBOX_GUARDS).',
    },
  ],
  [
    'apps/nextblock/lib/full-backup/server.ts',
    {
      why: 'a full restore creates, updates (email, password hash, ban) and deletes accounts through a stored auth.admin handle passed to its helpers; every entry point refuses on the sandbox (SANDBOX_GUARDS).',
    },
  ],
  [
    'apps/nextblock/app/api/cron/reset-sandbox/affiliate-demo.ts',
    {
      why: 'the reset seeds the demo partners as confirmed accounts (no mail).',
      exempt: {
        seedSandboxAffiliateDemo:
          'only the reset route calls it, after its sandbox and cron-secret checks; the partners use reserved or demo addresses and email_confirm, so no mail is sent.',
      },
    },
  ],
  [
    'apps/nextblock/lib/setup/provision-admin.ts',
    {
      why: 'first-admin provisioning (/setup, /api/setup/bootstrap).',
      exempt: {
        provisionFirstAdmin:
          'refuses once an admin exists unless a local-dev reset was asked for (isLocalWritableEnv), and the sandbox always has its demo admin.',
      },
    },
  ],
]);

/**
 * Modules that write, copy or delete stored objects, with how they behave on the sandbox. Uploads
 * stay open there: the reset requires R2 and empties the whole bucket on every run (checked in
 * sandbox-guards.test.ts), so a visitor's file lasts one cycle, like every other edit.
 */
const STORAGE_WRITERS = new Map([
  [
    'apps/nextblock/app/api/cron/reset-sandbox/route.ts',
    'the reset empties the bucket, then uploads its seed assets; it logs an error and returns a warning when uploads go to another backend or bucket (checkSandboxUploadTarget).',
  ],
  ['apps/nextblock/app/api/upload/proxy/route.ts', 'staff upload; emptied by the next reset on the sandbox.'],
  ['apps/nextblock/app/api/upload/presigned-url/route.ts', 'staff upload; emptied by the next reset on the sandbox.'],
  ['apps/nextblock/app/cms/media/actions.ts', 'deletes and moves media objects; the sandbox bucket is rebuilt by every reset.'],
  ['apps/nextblock/app/api/process-image/route.ts', 're-encodes an object already in the bucket; emptied by the next reset on the sandbox.'],
  ['apps/nextblock/lib/affiliates/uploads.ts', 'partner avatar and storefront images; emptied by the next reset on the sandbox.'],
  ['apps/nextblock/lib/custom-block-r2-upload.ts', 'custom block assets; emptied by the next reset on the sandbox.'],
  ['apps/nextblock/lib/media/external-image-import.ts', 'imports an external image into media; emptied by the next reset on the sandbox.'],
  ['apps/nextblock/lib/full-backup/server.ts', 'full backup export and restore; both refuse on the sandbox (SANDBOX_GUARDS).'],
  ['libs/ecommerce/src/lib/product-actions.ts', "updateProduct deletes the objects of the media rows it removed; the sandbox bucket is emptied by every reset."],
  ['apps/nextblock/lib/storage/supabase-storage.ts', 'the Supabase Storage adapter; callers of its write helpers (STORAGE_HELPERS) are listed here.'],
  ['libs/utils/src/lib/r2-client.ts', 'a deleteMediaFiles copy no module imports; callers of deleteMediaFiles (STORAGE_HELPERS) are listed here.'],
  ['libs/utils/src/server.ts', 'deleteMediaFiles (@nextblock-cms/utils/server); its callers (STORAGE_HELPERS) are listed here.'],
]);

/**
 * Modules that write to a payment provider (a Stripe write, a Freemius fetch that is not a GET), with
 * how they behave on the sandbox. `exempt` as for MAIL_SENDERS.
 */
const CHECKOUT_ONLY = 'only /api/checkout opens a session, and it answers 403 on the sandbox (SANDBOX_GUARDS).';
const CONNECT_ONLY =
  "the app calls it only through lib/affiliates/connect-service.ts from the partner portal's Connect actions and refresh route, which refuse on the sandbox (SANDBOX_GUARDS).";

const VENDOR_WRITERS = new Map([
  ['apps/nextblock/app/actions/package-actions.ts', { why: 'license activation, deactivation and the license-email resend refuse on the sandbox (SANDBOX_GUARDS).' }],
  [
    'apps/nextblock/lib/packages/activate-license.ts',
    {
      why: 'Freemius licenses/activate.json for a key the install was given.',
      exempt: {
        activateLicenseKeyWithFreemius:
          "called from package-actions' activation (SANDBOX_GUARDS) and from env-license's ensureEnvLicenseActivation, which activates only the operator's own NEXTBLOCK_LICENSE_KEY (the shared demo sandbox never sets it).",
      },
    },
  ],
  ['apps/nextblock/lib/packages/revalidate-activations.ts', { why: 'the daily re-validation skips the sandbox before reading an activation (SANDBOX_GUARDS).' }],
  [
    'libs/affiliates/src/lib/connect/accounts.ts',
    {
      why: 'Stripe Connect accounts and links, with the Stripe client the app hands in.',
      exempt: {
        ensureAffiliateExpressAccount: CONNECT_ONLY,
        createAffiliateOnboardingLink: CONNECT_ONLY,
        createAffiliateExpressDashboardLink: CONNECT_ONLY,
      },
    },
  ],
  [
    'libs/affiliates/src/lib/payouts/transfers.ts',
    {
      why: 'payout transfers, with the Stripe client the app hands in.',
      exempt: {
        createAffiliatePayoutTransfer:
          'reached only through the payout engine (a cycle or a retry), which the app runs only from payout-runner functions in SANDBOX_GUARDS (resolveAffiliateStripeClient answers sandbox first).',
      },
    },
  ],
  ['libs/ecommerce/src/lib/freemius-coupons.ts', { why: 'every request refuses on the sandbox (freemiusCouponRequest and its callers are in SANDBOX_GUARDS).' }],
  [
    'apps/nextblock/lib/affiliates/paypal/client.ts',
    { why: 'every PayPal request goes through sendAffiliatePayPalRequest, which throws on the sandbox before any fetch (SANDBOX_GUARDS).' },
  ],
  [
    'apps/nextblock/lib/affiliates/paypal/engine.ts',
    {
      why: 'PayPal payout batches and the cancel of an unclaimed item, through the PayPal client; runAffiliatePayPalPayouts and cancelAffiliatePayPalPayout answer sandbox first (SANDBOX_GUARDS), and the client refuses there too.',
    },
  ],
  [
    'libs/ecommerce/src/lib/freemius-trial-provision.ts',
    {
      why: 'mints a trial license on a vendor product.',
      exempt: {
        provisionFreemiusTrialLicense:
          'only the vendor route /api/packages/provision-trial calls it, which needs NEXTBLOCK_LICENSE_CLAIM_ENABLED and answers 404 on the sandbox (SANDBOX_GUARDS).',
      },
    },
  ],
  [
    'libs/ecommerce/src/lib/providers/stripe.ts',
    { why: 'Stripe Checkout sessions and the customer they carry (upsertStripeCheckoutCustomer, which only the provider reaches).', exempt: { StripeProvider: CHECKOUT_ONLY } },
  ],
  [
    'libs/ecommerce/src/lib/stripe/checkout.ts',
    {
      why: 'a standalone Checkout session helper.',
      exempt: {
        createCheckoutSession: 'exported for standalone use but unused by the app, which checks out through providers/stripe.ts behind /api/checkout (403 on the sandbox).',
      },
    },
  ],
]);

/**
 * GoTrue methods (after `auth.`, `auth.admin.`, `auth.mfa.` or `auth.admin.mfa.`) that create or
 * change an account, its second factors or identities, or send auth mail.
 */
const ACCOUNT_METHODS = new Set([
  'signUp',
  'signInWithOtp',
  'signInAnonymously',
  'signInWithIdToken',
  'signInWithOAuth',
  'resetPasswordForEmail',
  'resend',
  'reauthenticate',
  'updateUser',
  'linkIdentity',
  'createUser',
  'inviteUserByEmail',
  'generateLink',
  'updateUserById',
  'deleteUser',
  'enroll',
  'unenroll',
  'challenge',
  'verify',
  'challengeAndVerify',
  'deleteFactor',
]);

/** A GoTrue receiver, after any client: `auth`, `auth.admin`, `auth.mfa` or `auth.admin.mfa`. */
const AUTH_RECEIVER = /(?:^|\.)(auth(?:\.admin)?(?:\.mfa)?)$/;

/** Type names of GoTrue clients, for a parameter that receives one under another name. */
const AUTH_CLIENT_TYPE = /\b(?:GoTrueAdminApi|GoTrueAdminMFAApi|GoTrueClient|GoTrueMFAApi|SupabaseAuthClient|AuthClient|AuthAdminApi)\b/;

/** A GoTrue client written as an indexed type: `SupabaseClient['auth']`, `…['auth']['admin']`. */
const AUTH_INDEX = /\[\s*['"]auth['"]\s*\]/;

/** S3 commands that write, copy or delete objects. */
const STORAGE_COMMANDS = new Set([
  'PutObjectCommand',
  'CopyObjectCommand',
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'CompleteMultipartUploadCommand',
]);

/** Supabase Storage bucket methods that write, copy or delete objects. */
const STORAGE_METHODS = new Set(['upload', 'update', 'remove', 'move', 'copy', 'createSignedUploadUrl', 'uploadToSignedUrl']);

/**
 * Write helpers whose callers write storage: the Supabase Storage adapter's
 * (`apps/nextblock/lib/storage/supabase-storage.ts`) and the R2 delete helper `deleteMediaFiles`
 * (`@nextblock-cms/utils/server`).
 */
const STORAGE_HELPERS = new Set(['supabaseUploadObject', 'supabaseCreateSignedUpload', 'supabaseRemoveObjects', 'deleteMediaFiles']);

function parseSource(fileName, source) {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** `process.env.NEXT_PUBLIC_IS_SANDBOX` or `process.env['NEXT_PUBLIC_IS_SANDBOX']`. */
function isFlagRead(node) {
  const current = unwrap(node);
  let object;
  let name;
  if (ts.isPropertyAccessExpression(current)) {
    object = current.expression;
    name = current.name.text;
  } else if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
    object = current.expression;
    name = current.argumentExpression.text;
  } else {
    return false;
  }
  if (name !== SANDBOX_FLAG) return false;
  const env = unwrap(object);
  return ts.isPropertyAccessExpression(env) && env.name.text === 'env' && ts.isIdentifier(env.expression) && env.expression.text === 'process';
}

const EQUALITY_TOKENS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const isTrueLiteral = (node) => ts.isStringLiteralLike(node) && node.text === 'true';

const FLAG_READER_NAMES = new Set(FLAG_READERS.map((reader) => reader.name));

/** A call to a FLAG_READERS function, or the flag compared with 'true'. */
function isDirectPredicate(node, readerNames = FLAG_READER_NAMES) {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    return name !== null && readerNames.has(name);
  }
  if (ts.isBinaryExpression(node) && EQUALITY_TOKENS.has(node.operatorToken.kind)) {
    const left = unwrap(node.left);
    const right = unwrap(node.right);
    return (isFlagRead(left) && isTrueLiteral(right)) || (isFlagRead(right) && isTrueLiteral(left));
  }
  return false;
}

/** Top-level bindings a guard may reach the flag through: functions and const initializers. */
function moduleBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) bindings.set(statement.name.text, statement);
    if (ts.isClassDeclaration(statement) && statement.name) bindings.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

/** The node behind each export name (`default` included). */
function moduleExports(sourceFile, bindings) {
  const exports = new Map();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && exported) {
      if (isDefault) exports.set('default', statement);
      if (statement.name) exports.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) exports.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isExportAssignment(statement)) {
      const expression = unwrap(statement.expression);
      exports.set('default', ts.isIdentifier(expression) && bindings.has(expression.text) ? bindings.get(expression.text) : expression);
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (bindings.has(local)) exports.set(element.name.text, bindings.get(local));
      }
    }
  }
  return exports;
}

/** True inside a type (an annotation, `typeof x`, a type literal), where a name runs nothing. */
function inTypePosition(node) {
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
    if (ts.isStatement(current) || ts.isFunctionLike(current)) return false;
  }
  return false;
}

/** An identifier that names a runtime value here, not a property, a declaration, a label or a type. */
function isReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isEnumMember(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  return !inTypePosition(node);
}

/**
 * True when `node`, or a same-module binding it names, reads the sandbox flag. `readerNames` are
 * the calls that count as a read (FLAG_READERS; none when checking a reader itself).
 */
function readsSandboxFlag(node, bindings, readerNames = FLAG_READER_NAMES, depth = 0, seen = new Set()) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (isDirectPredicate(child, readerNames)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(child) && depth < MAX_BINDING_DEPTH && bindings.has(child.text) && !seen.has(child.text) && isReference(child)) {
      seen.add(child.text);
      if (readsSandboxFlag(bindings.get(child.text), bindings, readerNames, depth + 1, seen)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function readRepoFile(repoPath) {
  return fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8');
}

/** The node an export name (or, failing that, a top-level binding) of a module stands for. */
function lookupFunction(repoPath, source, name) {
  const sourceFile = parseSource(repoPath, source);
  const bindings = moduleBindings(sourceFile);
  const node = moduleExports(sourceFile, bindings).get(name) ?? bindings.get(name);
  return { node, bindings };
}

/** FLAG_READERS entries that are gone or no longer read the flag themselves. */
function findFlagReaderProblems(readers = FLAG_READERS, readFile = readRepoFile) {
  const problems = [];
  for (const reader of readers) {
    let source;
    try {
      source = readFile(reader.file);
    } catch {
      problems.push(`${reader.file}: missing. Moved? Update FLAG_READERS (tools/scripts/lib/sandbox-guards.js).`);
      continue;
    }
    const { node, bindings } = lookupFunction(reader.file, source, reader.name);
    if (!node) problems.push(`${reader.file}#${reader.name}: not found. Renamed? Update FLAG_READERS.`);
    else if (!readsSandboxFlag(node, bindings, new Set())) {
      problems.push(`${reader.file}#${reader.name}: no longer compares process.env.${SANDBOX_FLAG} with 'true', yet guards call it as their sandbox check.`);
    }
  }
  return problems;
}

/** An identifier inside an import clause (binding a name, not using it). */
function isImportBinding(node) {
  const parent = node.parent;
  return Boolean(parent && (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)));
}

/**
 * What a guard's test does: whether its code calls `stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true')` (or
 * assigns the flag 'true'), the names its code uses (identifiers, member names such as
 * `actions.createUser`, and string literals that key a table of actions; imports and comments do
 * not count), and the modules it default-imports.
 */
function testCoverage(testPath, source) {
  const sourceFile = parseSource(testPath, source);
  let setsFlag = false;
  const names = new Set();
  const defaultImports = [];
  const visit = (node) => {
    // Types run nothing, and a type-only import binds nothing a test could call.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      const [envName, value] = node.arguments;
      if (name === 'stubEnv' && envName && value && ts.isStringLiteralLike(envName) && envName.text === SANDBOX_FLAG && isTrueLiteral(unwrap(value))) {
        setsFlag = true;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isFlagRead(node.left) && isTrueLiteral(unwrap(node.right))) {
      setsFlag = true;
    }
    if (ts.isIdentifier(node) && !isImportBinding(node) && (isReference(node) || ts.isPropertyAccessExpression(node.parent))) {
      names.add(node.text);
    }
    // A name in a table (`it.each(['createUser', ...])`) or an index (`actions['createUser']`); never a
    // test title or another argument.
    if (
      ts.isStringLiteralLike(node) &&
      /^[A-Za-z_$][\w$]*$/.test(node.text) &&
      (ts.isArrayLiteralExpression(node.parent) || (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node))
    ) {
      names.add(node.text);
    }
    if (ts.isImportDeclaration(node) && node.importClause?.name && ts.isStringLiteral(node.moduleSpecifier)) {
      defaultImports.push({ specifier: node.moduleSpecifier.text, local: node.importClause.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { setsFlag, names, defaultImports };
}

/** The bindings a binding reaches through the module's own names (itself included). */
function reachableBindings(index, start) {
  const reached = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = index.bindings.get(queue.shift());
    if (!node) continue;
    const visit = (child) => {
      if (ts.isIdentifier(child) && index.bindings.has(child.text) && !reached.has(child.text) && isReference(child)) {
        reached.add(child.text);
        queue.push(child.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  return reached;
}

/**
 * A private binding listed as a guard counts as run when the test runs an export of the module
 * that reaches it (`loadPaymentRows` through `hydrateFreemiusEnvFromDb`).
 */
function runsPrivateBinding(index, name, testNames) {
  if (index.exportKeys.has(name) || !index.bindings.has(name)) return false;
  for (const [exportName, key] of index.exportKeys) {
    if (testNames.has(exportName) && reachableBindings(index, key).has(name)) return true;
  }
  return false;
}

/** True when a relative import specifier written in `fromFile` names `targetFile` (any extension). */
function importNames(fromFile, specifier, targetFile) {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return resolved === targetFile.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Each listed function that no longer reads the flag or is gone, and each guard whose test does not
 * set the flag to 'true' or never uses a listed function (a refusal its test does not run could be
 * removed with every test green).
 */
function findGuardProblems(guards = SANDBOX_GUARDS, readFile = readRepoFile) {
  const problems = [];
  for (const guard of guards) {
    let source;
    try {
      source = readFile(guard.file);
    } catch {
      problems.push(`${guard.file}: missing. Moved? Update SANDBOX_GUARDS (tools/scripts/lib/sandbox-guards.js).`);
      continue;
    }
    for (const name of guard.functions) {
      const { node, bindings } = lookupFunction(guard.file, source, name);
      if (!node) {
        problems.push(`${guard.file}#${name}: not found. Renamed? Update SANDBOX_GUARDS.`);
      } else if (!readsSandboxFlag(node, bindings)) {
        problems.push(`${guard.file}#${name}: no longer checks the sandbox. ${guard.why}`);
      }
    }
    let test;
    try {
      test = readFile(guard.test);
    } catch {
      problems.push(`${guard.file}: its test ${guard.test} is missing.`);
      continue;
    }
    const coverage = testCoverage(guard.test, test);
    if (!coverage.setsFlag) {
      problems.push(`${guard.test}: never sets ${SANDBOX_FLAG} to 'true', so it cannot prove the refusal in ${guard.file}.`);
    }
    const index = moduleIndex(parseSource(guard.file, source));
    for (const name of guard.functions) {
      const used =
        name === 'default'
          ? coverage.defaultImports.some(({ specifier, local }) => importNames(guard.test, specifier, guard.file) && coverage.names.has(local))
          : coverage.names.has(name) || runsPrivateBinding(index, name, coverage.names);
      if (!used) {
        problems.push(`${guard.test}: never runs ${guard.file}#${name}, so its refusal could be removed with every test green.`);
      }
    }
  }
  return problems;
}

/**
 * A module's top-level bindings, the binding each export name stands for (`exportKeys`), and the
 * bindings that are exported.
 */
function moduleIndex(sourceFile) {
  const bindings = moduleBindings(sourceFile);
  const exportKeys = new Map();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && exported) {
      const key = statement.name ? statement.name.text : 'default';
      if (statement.name) exportKeys.set(key, key);
      if (isDefault) exportKeys.set('default', key);
    } else if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportKeys.set(declaration.name.text, declaration.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      const expression = unwrap(statement.expression);
      exportKeys.set('default', ts.isIdentifier(expression) && bindings.has(expression.text) ? expression.text : 'default');
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exportKeys.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { bindings, exportKeys, exportedKeys: new Set(exportKeys.values()) };
}

/** A function expression called where it stands (an IIFE): its body runs with the code around it. */
function isImmediatelyInvoked(fn) {
  let current = fn;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return Boolean(current.parent && ts.isCallExpression(current.parent) && current.parent.expression === current);
}

/** An identifier stored as a value (`const ACTIONS = { invite: inviteHelper }`), not called right away. */
function isStoredValue(node) {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent)) return parent.initializer === current;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent)
    ) {
      continue;
    }
    return false;
  }
  return false;
}

/** Calls that run their callback as soon as the module has loaded, not when something calls it. */
const RUNS_SOON = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']);

/**
 * A function that runs later, not where it stands: a stored value (`const f = () => …`, an object
 * method, an array element), a class member, or an argument of a plain wrapper call (`cache(fn)`).
 * A callback to a member call (`.map`, `.then`), a timer, a `new Promise` executor or an IIFE runs at once.
 */
function isKeptForLater(fn) {
  if (isStoredValue(fn)) return true;
  let current = fn;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if (!parent) return false;
  if (ts.isClassLike(parent) || ts.isObjectLiteralExpression(parent)) return true;
  if (ts.isPropertyDeclaration(parent) && parent.initializer === current) return true;
  if (!ts.isCallExpression(parent) || parent.expression === current) return false;
  const wrapper = unwrap(parent.expression);
  return ts.isIdentifier(wrapper) && !RUNS_SOON.has(wrapper.text);
}

/** Code that runs when its class is defined: a `static {}` block, a static field initializer, a decorator, a computed member name. */
function runsWithClassDefinition(node) {
  if (ts.isClassStaticBlockDeclaration(node) || ts.isDecorator(node)) return true;
  if (ts.isComputedPropertyName(node) && node.parent && ts.isClassElement(node.parent)) return true;
  return ts.isPropertyDeclaration(node) && Boolean(node.initializer) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * The top-level binding a node runs in: `default` for an anonymous default export, `(module)` for
 * code that runs at import (outside any binding; in a top-level initializer outside a function kept
 * for later, as `const x = await admin.createUser()`, an IIFE body or a `.then` callback; or in a
 * class's static code).
 */
function declarationKeyOf(node) {
  let statement = node;
  let deferred = false;
  // Set by class definition code, cleared by a function kept for later around that class.
  let atLoad = false;
  for (let current = node; current.parent && !ts.isSourceFile(current.parent); current = current.parent) {
    if (ts.isFunctionLike(current) && !isImmediatelyInvoked(current) && isKeptForLater(current)) {
      deferred = true;
      atLoad = false;
    }
    if (!deferred && runsWithClassDefinition(current)) atLoad = true;
    statement = current.parent;
  }
  if (ts.isFunctionDeclaration(statement)) return statement.name ? statement.name.text : 'default';
  if (atLoad) return '(module)';
  if (ts.isClassDeclaration(statement)) return statement.name ? statement.name.text : 'default';
  if (ts.isExportAssignment(statement)) return deferred || (ts.isIdentifier(node) && isStoredValue(node)) ? 'default' : '(module)';
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.pos <= node.pos && node.end <= declaration.end) {
        return deferred || (ts.isIdentifier(node) && isStoredValue(node)) ? declaration.name.text : '(module)';
      }
    }
  }
  return '(module)';
}

/**
 * The bindings a side effect may sit in: the listed guards and exemptions, then (to a fixed point)
 * every private binding whose every use is inside an accepted one.
 */
function acceptedBindings(sourceFile, index, names) {
  const accepted = new Set(names.map((name) => index.exportKeys.get(name) ?? name));
  const usedFrom = new Map();
  const visit = (node) => {
    if (ts.isIdentifier(node) && index.bindings.has(node.text) && isReference(node)) {
      const from = declarationKeyOf(node);
      if (from !== node.text) {
        if (!usedFrom.has(node.text)) usedFrom.set(node.text, new Set());
        usedFrom.get(node.text).add(from);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of index.bindings.keys()) {
      if (accepted.has(key) || index.exportedKeys.has(key)) continue;
      if ([...(usedFrom.get(key) ?? [])].every((from) => accepted.has(from))) {
        accepted.add(key);
        changed = true;
      }
    }
  }
  return accepted;
}

/**
 * Names this module binds to a GoTrue client, each with its scope: `const admin = client.auth.admin`,
 * `const { auth } = supabase`, `const { admin } = client.auth`, or a parameter typed as one.
 */
function authHandles(sourceFile) {
  const handles = new Map();
  const aliases = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type.getText(sourceFile));
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const text = receiverText(unwrap(node.initializer), sourceFile);
      const scope = text.match(AUTH_RECEIVER)?.[1] ?? null;
      if (ts.isIdentifier(node.name) && scope) handles.set(node, scope);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          if (property === 'auth') handles.set(element, 'auth');
          else if (scope && (property === 'admin' || property === 'mfa')) {
            const nested = `${scope}.${property}`.match(AUTH_RECEIVER)?.[1];
            if (nested) handles.set(element, nested);
          }
        }
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      const written = node.type.getText(sourceFile).trim();
      const typeText = aliases.get(written) ?? written;
      if (AUTH_CLIENT_TYPE.test(typeText) || AUTH_INDEX.test(typeText)) {
        const admin = /Admin|\[\s*['"]admin['"]\s*\]/.test(typeText) ? '.admin' : '';
        const mfa = /MFA|\[\s*['"]mfa['"]\s*\]/.test(typeText) ? '.mfa' : '';
        handles.set(node, `auth${admin}${mfa}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return handles;
}

/**
 * The declaration (variable, parameter or destructured element) a name resolves to by lexical scope,
 * or null for a global. Enough to tell a client from a same-named local elsewhere in the module.
 */
function resolveDeclaration(identifier) {
  const name = identifier.text;
  const match = (bindingName) => {
    if (ts.isIdentifier(bindingName)) return bindingName.text === name ? bindingName.parent : null;
    if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
      for (const element of bindingName.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const found = match(element.name);
        if (found) return found;
      }
    }
    return null;
  };
  const inDeclarations = (declarations) => {
    for (const declaration of declarations) {
      const found = match(declaration.name);
      if (found) return found;
    }
    return null;
  };
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters) {
      const found = inDeclarations(scope.parameters);
      if (found) return found;
    }
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const found = inDeclarations(statement.declarationList.declarations);
        if (found) return found;
      }
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const found = inDeclarations(scope.initializer.declarations);
      if (found) return found;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      const found = match(scope.variableDeclaration.name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * True when a declaration says what it holds: a typed parameter, or a variable with a plain
 * initializer. Its name then cannot borrow a client handle declared elsewhere in the module; a
 * destructured element, an untyped parameter or a global can (`const { admin } = params`).
 */
function declaresItsValue(declaration) {
  if (!declaration) return false;
  if (ts.isParameter(declaration)) return Boolean(declaration.type) && !isOpaqueType(declaration.type);
  return ts.isVariableDeclaration(declaration) && Boolean(declaration.initializer) && ts.isIdentifier(declaration.name);
}

/** A type that says nothing readable about the value: `any`, `unknown`, `typeof x`, `T['k']`, `ReturnType<…>`. */
function isOpaqueType(type) {
  if (type.kind === ts.SyntaxKind.AnyKeyword || type.kind === ts.SyntaxKind.UnknownKeyword) return true;
  if (ts.isTypeQueryNode(type) || ts.isIndexedAccessTypeNode(type)) return true;
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && /^(?:ReturnType|Awaited|InstanceType)$/.test(type.typeName.text);
}

function declarationName(declaration) {
  return declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

/** The leftmost identifier of a member chain (`a` in `a.b.c`, `a?.b`, `a!.b`), or null (`this`, a call). */
function headIdentifier(expression) {
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
  return ts.isIdentifier(current) ? current : null;
}

/** A receiver's text as the matchers read it: `supabase.auth?.admin`, `client!.auth` → `supabase.auth.admin`, `client.auth`. */
function receiverText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, '').replace(/\?\./g, '.').replace(/!/g, '');
}

/**
 * A receiver chain that starts from a call, with the member names read after it:
 * `(await loadStripe()).charges` → the `loadStripe()` call and ['charges'].
 */
function callRootedChain(expression) {
  const names = [];
  let current = expression;
  for (;;) {
    current = unwrap(current);
    if (ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isPropertyAccessExpression(current)) {
      names.unshift(current.name.text);
      current = current.expression;
    } else break;
  }
  if (!ts.isCallExpression(current)) return null;
  const callee = unwrap(current.expression);
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return { name, names };
}

/** The Stripe client type itself (`Stripe`, `AffiliatesStripeLike`), not a data type (`Stripe.Tax.Calculation`). */
const STRIPE_CLIENT_TYPE = /^(?:Stripe|\w*StripeLike)(?:\s*\|\s*(?:null|undefined))*$/;

/** The Stripe client's top-level resources: a member named `stripe` followed by one is a client. */
const STRIPE_RESOURCES = new Set([
  'accounts', 'accountLinks', 'accountSessions', 'applePayDomains', 'applicationFees', 'balance', 'balanceTransactions',
  'billing', 'billingPortal', 'charges', 'checkout', 'climate', 'confirmationTokens', 'countrySpecs', 'coupons',
  'creditNotes', 'customers', 'customerSessions', 'disputes', 'entitlements', 'ephemeralKeys', 'events',
  'exchangeRates', 'files', 'fileLinks', 'financialConnections', 'forwarding', 'identity', 'invoiceItems',
  'invoices', 'issuing', 'mandates', 'paymentIntents', 'paymentLinks', 'paymentMethodConfigurations',
  'paymentMethodDomains', 'paymentMethods', 'payouts', 'plans', 'prices', 'products', 'promotionCodes', 'quotes',
  'radar', 'refunds', 'reporting', 'reviews', 'setupAttempts', 'setupIntents', 'shippingRates', 'sigma', 'sources',
  'subscriptionItems', 'subscriptionSchedules', 'subscriptions', 'tax', 'taxCodes', 'taxIds', 'taxRates',
  'terminal', 'testHelpers', 'tokens', 'topups', 'transfers', 'treasury', 'webhookEndpoints',
]);

/** Stripe methods that only read; every other method on a Stripe resource writes or moves money. */
const STRIPE_READ_METHOD = /^(?:retrieve|list|search|construct)/;

/**
 * Names bound to a Stripe client: `getStripeClient()`, `new Stripe(…)`, a `stripe` destructured from
 * `resolveAffiliateStripeClient()`, or a parameter typed `Stripe` / `…StripeLike`.
 */
function stripeHandles(sourceFile) {
  const handles = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const text = node.initializer.getText(sourceFile).replace(/\s+/g, ' ');
      if (/\bgetStripeClient\s*\(|\bnew Stripe\s*\(|\bresolveAffiliateStripeClient\s*\(/.test(text)) {
        if (ts.isIdentifier(node.name)) handles.add(node);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.getText(sourceFile);
            if (ts.isIdentifier(element.name) && /stripe/i.test(property)) handles.add(element);
          }
        }
      }
    }
    // A parameter, variable or field typed as the client itself (`let cached: Stripe | null`).
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name) && node.type && STRIPE_CLIENT_TYPE.test(node.type.getText(sourceFile).trim())) {
      handles.add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return handles;
}

/** PayPal's REST hosts (the affiliate PayPal Payouts, 02037): a string naming one marks a PayPal module. */
const PAYPAL_API_HOST = /api-m\.(?:sandbox\.)?paypal\.com/i;

/**
 * The PayPal client's write verbs (`lib/affiliates/paypal/client.ts`): creating a payout batch moves
 * money, cancelling an unclaimed item returns it. A call to one on any receiver is a PayPal write.
 */
const PAYPAL_WRITE_METHODS = new Set(['createPayoutBatch', 'cancelPayoutItem']);

/** A module that names a PayPal REST host in code (a URL string), not only in a comment. */
function mentionsPayPalApi(sourceFile) {
  if (!PAYPAL_API_HOST.test(sourceFile.text)) return false;
  let found = false;
  const visit = (node) => {
    if (found) return;
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (literal && PAYPAL_API_HOST.test(node.text)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** A module that names Freemius in code (a URL string, the shared `FREEMIUS_API_URL`), not only in a comment. */
function mentionsFreemius(sourceFile) {
  if (!/freemius\.com|FREEMIUS_API_URL/i.test(sourceFile.text)) return false;
  let found = false;
  const visit = (node) => {
    if (found) return;
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if ((literal && /freemius\.com/i.test(node.text)) || (ts.isIdentifier(node) && node.text === 'FREEMIUS_API_URL')) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * A fetch whose URL is a literal for this site or for another host than the vendor's (`'/api/…'`, a
 * template that starts with `/api/`, `'https://hooks.example.com'`). A URL built from a variable or
 * a call stays a possible vendor write. `vendorHost`: Freemius by default, PayPal's REST hosts for a
 * PayPal module.
 */
function fetchesElsewhere(url, vendorHost = /freemius\.com/i) {
  const target = url && unwrap(url);
  if (!target) return false;
  const text = ts.isStringLiteralLike(target) ? target.text : ts.isTemplateExpression(target) ? target.head.text : null;
  if (text === null || vendorHost.test(text)) return false;
  return text.startsWith('/') || /^[a-z][a-z\d+.-]*:\/\//i.test(text);
}

/** The `method` of a `fetch(url, init)` call: 'GET' when absent, the literal when one, else null (unknown). */
function fetchMethod(init) {
  if (!init) return 'GET';
  const options = unwrap(init);
  if (!ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && propertyKey(property.name) === 'method') {
      const value = unwrap(property.initializer);
      return ts.isStringLiteralLike(value) ? value.text.toUpperCase() : null;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method') return null;
    if (ts.isSpreadAssignment(property)) return null;
  }
  return 'GET';
}

function propertyKey(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

/** Every mail, account, storage and vendor call site of a module, with its line and top-level binding. */
function sideEffectSites(sourceFile) {
  const sites = [];
  const handles = authHandles(sourceFile);
  const stripe = stripeHandles(sourceFile);
  const handleNames = new Map([...handles].map(([declaration, scope]) => [declarationName(declaration), scope]));
  const stripeNames = new Set([...stripe].map(declarationName));
  // Fields and constructor parameter properties typed as the client, read as `this.<name>`.
  const stripeMembers = new Set(
    [...stripe]
      .filter((declaration) => ts.isPropertyDeclaration(declaration) || (ts.isParameter(declaration) && (ts.getModifiers(declaration) ?? []).length > 0))
      .map(declarationName)
  );
  const talksToFreemius = mentionsFreemius(sourceFile);
  const talksToPayPal = mentionsPayPalApi(sourceFile);
  const usesFreemiusSdk = /from ['"]@freemius\//.test(sourceFile.text);
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const add = (kind, label, node) => sites.push({ kind, label: `${label} (line ${lineOf(node)})`, key: declarationKeyOf(node) });
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isIdentifier(callee)) {
        const name = ts.isIdentifier(callee) ? callee.text : callee.name.text;
        if (name === 'createTransport') add('mail', 'createTransport', node);
        if (STORAGE_HELPERS.has(name)) add('storage', name, node);
        if (ts.isPropertyAccessExpression(callee)) {
          // `supabase.auth?.signUp`, `client!.auth`: optional chaining and non-null marks change nothing.
          const receiver = receiverText(callee.expression, sourceFile);
          const headNode = headIdentifier(callee.expression);
          const head = headNode ? headNode.text : '';
          const declaration = headNode ? resolveDeclaration(headNode) : null;
          // A head that resolves to a GoTrue handle reads as its scope; one that resolves to some other
          // local merely named `auth` (`const auth = await requireAdmin()`) is not GoTrue.
          const handleScope =
            declaration && handles.has(declaration) ? handles.get(declaration) : !declaresItsValue(declaration) ? handleNames.get(head) : undefined;
          const normalized = handleScope ? `${handleScope}${receiver.slice(head.length)}` : receiver;
          // Only a suffix that comes from the head itself can be shadowed: `auth.supabase.auth.admin` (a gate
          // result named `auth` that carries a client) is still GoTrue.
          const shadowed =
            head === 'auth' && declaresItsValue(declaration) && !handles.has(declaration) && /^auth(?:\.|$)/.test(receiver) && !AUTH_RECEIVER.test(receiver.slice(head.length));
          const scope = shadowed ? undefined : normalized.match(AUTH_RECEIVER)?.[1];
          if (ACCOUNT_METHODS.has(name) && scope) add('account', `${scope}.${name}`, node);
          if (STORAGE_METHODS.has(name) && /\.storage\.from\(/.test(receiver)) add('storage', `storage.from().${name}`, node);
          const segments = receiver.split('.');
          const isStripe = (declaration && stripe.has(declaration)) || (!declaresItsValue(declaration) && stripeNames.has(head));
          // A client carried in an object (`context.stripe.accounts.create`, a destructured `stripe`): a member
          // named `stripe` right before a Stripe resource.
          const carried = segments.findIndex((segment, index) => segment === 'stripe' && STRIPE_RESOURCES.has(segments[index + 1]));
          const ownField = segments[0] === 'this' && (segments[1] === 'stripe' || stripeMembers.has(segments[1]));
          const stripeHead = isStripe ? 1 : ownField ? 2 : carried >= 0 ? carried + 1 : 0;
          const loaded = stripeHead === 0 ? callRootedChain(callee.expression) : null;
          if (stripeHead > 0 && segments.length > stripeHead && !STRIPE_READ_METHOD.test(name)) {
            add('vendor', `stripe.${segments.slice(stripeHead).join('.')}.${name}`, node);
          } else if (loaded && /stripe/i.test(loaded.name) && STRIPE_RESOURCES.has(loaded.names[0]) && !STRIPE_READ_METHOD.test(name)) {
            add('vendor', `stripe.${loaded.names.join('.')}.${name}`, node);
          }
        }
        if (
          talksToFreemius &&
          name === 'fetch' &&
          (ts.isIdentifier(callee) || /^(?:globalThis|window)$/.test(callee.expression.getText(sourceFile))) &&
          !fetchesElsewhere(node.arguments[0])
        ) {
          const method = fetchMethod(node.arguments[1]);
          if (method !== 'GET' && method !== 'HEAD') add('vendor', `fetch ${method ?? '(method not a literal)'} in a Freemius module`, node);
        }
        // A PayPal module (02037): a fetch that is not a GET or HEAD, to a URL that is not a literal for
        // another host, is a PayPal write (a payout batch, a cancel).
        if (
          talksToPayPal &&
          name === 'fetch' &&
          (ts.isIdentifier(callee) || /^(?:globalThis|window)$/.test(callee.expression.getText(sourceFile))) &&
          !fetchesElsewhere(node.arguments[0], PAYPAL_API_HOST)
        ) {
          const method = fetchMethod(node.arguments[1]);
          if (method !== 'GET' && method !== 'HEAD') add('vendor', `fetch ${method ?? '(method not a literal)'} in a PayPal module`, node);
        }
        // The PayPal client's write verbs, wherever they are called.
        if (ts.isPropertyAccessExpression(callee) && PAYPAL_WRITE_METHODS.has(name)) add('vendor', `PayPal ${name}`, node);
        // The Freemius SDK's typed client (`freemius.api.__unstable_ApiClient`): its write verbs.
        if (usesFreemiusSdk && ts.isPropertyAccessExpression(callee) && /^(?:POST|PUT|PATCH|DELETE)$/.test(name)) {
          add('vendor', `Freemius SDK ${name}`, node);
        }
        // ... and its typed services and customer-portal processors that write (`api.license.update`,
        // `api.subscription.cancel`). Anchored on the receiver: the same modules call Supabase `.update()`.
        if (usesFreemiusSdk && ts.isPropertyAccessExpression(callee)) {
          const sdkReceiver = receiverText(callee.expression, sourceFile);
          if (/(?:^|\.)api\.(?:license|subscription|user|product|payment|event)$/.test(sdkReceiver) && !/^(?:retrieve|list|search|get|iterate)/.test(name)) {
            add('vendor', `Freemius SDK ${sdkReceiver.split('.').slice(-2).join('.')}.${name}`, node);
          }
          if (/(?:^|\.)customerPortal\.(?:request|action(?:\.\w+)?)$/.test(sdkReceiver) && /^(?:process|createProcessor|processAction)$/.test(name)) {
            add('vendor', `Freemius SDK customerPortal ${name}`, node);
          }
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && STORAGE_COMMANDS.has(node.expression.text)) {
      add('storage', `new ${node.expression.text}`, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** What a module does that the sandbox has to answer for: `mail`, `account`, `storage` and `vendor` call sites. */
function sideEffectsInSource(fileName, source) {
  const found = { mail: [], account: [], storage: [], vendor: [] };
  for (const site of sideEffectSites(parseSource(fileName, source))) found[site.kind].push(site.label);
  return found;
}

/** Cheap text filter: only modules that could match one of the call sites above are parsed. */
const SIDE_EFFECT_HINT =
  /createTransport|\bauth\b|GoTrue|AuthClient|AuthAdminApi|ObjectCommand|ObjectsCommand|MultipartUpload|UploadPartCommand|\.storage\b|supabase(?:UploadObject|CreateSignedUpload|RemoveObjects)|deleteMediaFiles|stripe|freemius\.com|FREEMIUS_API_URL|@freemius\/|paypal\.com|createPayoutBatch|cancelPayoutItem/i;

const SIDE_EFFECT_LISTS = [
  ['mail', 'MAIL_SENDERS', 'creates a mail transport'],
  ['account', 'ACCOUNT_WRITERS', 'calls a GoTrue account, second-factor or auth-mail API'],
  ['storage', 'STORAGE_WRITERS', 'writes to object storage'],
  ['vendor', 'VENDOR_WRITERS', 'writes to a payment provider (Stripe, Freemius, PayPal)'],
];

/** A list entry as `{ why, exempt }` (a plain string is a reason with no exemptions). */
function listEntry(value) {
  return typeof value === 'string' ? { why: value, exempt: {} } : { why: value.why, exempt: value.exempt ?? {} };
}

/**
 * Modules with a mail, account or storage side effect that the matching list does not name, list
 * entries that no longer have one, and (mail and accounts) each call site outside a SANDBOX_GUARDS
 * function of its module, a private helper only those reach, or an exempted function. Storage
 * stays module-level: uploads are open on the sandbox, whose bucket every reset empties.
 */
function findUnlistedSideEffects(
  modules = scanRepository(),
  lists = { mail: MAIL_SENDERS, account: ACCOUNT_WRITERS, storage: STORAGE_WRITERS, vendor: VENDOR_WRITERS },
  readFile = (absolute) => fs.readFileSync(absolute, 'utf8'),
  guards = SANDBOX_GUARDS
) {
  const problems = [];
  const seen = { mail: new Set(), account: new Set(), storage: new Set(), vendor: new Set() };
  const guardedNames = new Map();
  for (const guard of guards) guardedNames.set(guard.file, [...(guardedNames.get(guard.file) ?? []), ...guard.functions]);
  for (const mod of modules.values()) {
    const source = readFile(mod.absolute);
    if (!SIDE_EFFECT_HINT.test(source)) continue;
    const sourceFile = parseSource(mod.absolute, source);
    const sites = sideEffectSites(sourceFile);
    let index = null;
    for (const [kind, listName, what] of SIDE_EFFECT_LISTS) {
      const kindSites = sites.filter((site) => site.kind === kind);
      if (kindSites.length === 0) continue;
      seen[kind].add(mod.repoPath);
      if (!lists[kind]?.has(mod.repoPath)) {
        problems.push(
          `${mod.repoPath} ${what} (${kindSites.map((site) => site.label).join(', ')}): refuse it on the sandbox (isSandboxEnvironment()) and list the module in ${listName} (tools/scripts/lib/sandbox-guards.js) with how it behaves there.`
        );
        continue;
      }
      if (kind === 'storage') continue;
      index ??= moduleIndex(sourceFile);
      const { exempt } = listEntry(lists[kind].get(mod.repoPath));
      const guarded = guardedNames.get(mod.repoPath) ?? [];
      const exemptNames = Object.keys(exempt);
      const accepted = acceptedBindings(sourceFile, index, [...guarded, ...exemptNames]);
      for (const site of kindSites) {
        if (!accepted.has(site.key)) {
          problems.push(
            `${mod.repoPath}#${site.key} ${what} (${site.label}) outside a SANDBOX_GUARDS function of the module or a private helper only those reach: refuse it on the sandbox and list the function in SANDBOX_GUARDS, or exempt it by name with the reason in ${listName} (tools/scripts/lib/sandbox-guards.js).`
          );
        }
      }
      for (const name of exemptNames) {
        const without = acceptedBindings(sourceFile, index, [...guarded, ...exemptNames.filter((other) => other !== name)]);
        if (kindSites.every((site) => without.has(site.key) || !accepted.has(site.key))) {
          problems.push(`${listName} exempts ${mod.repoPath}#${name}, which no longer ${what}: remove the exemption.`);
        }
      }
    }
  }
  for (const [kind, listName] of SIDE_EFFECT_LISTS) {
    for (const repoPath of lists[kind]?.keys() ?? []) {
      if (!seen[kind].has(repoPath)) problems.push(`${listName} lists ${repoPath}, which no longer has that side effect: remove the entry.`);
    }
  }
  return problems;
}

module.exports = {
  VENDOR_WRITERS,
  ACCOUNT_WRITERS,
  FLAG_READERS,
  MAIL_SENDERS,
  SANDBOX_GUARDS,
  STORAGE_WRITERS,
  findFlagReaderProblems,
  findGuardProblems,
  findUnlistedSideEffects,
  headIdentifier,
  isReference,
  lookupFunction,
  resolveDeclaration,
  moduleBindings,
  moduleExports,
  parseSource,
  readsSandboxFlag,
  sideEffectsInSource,
  testCoverage,
};
