import 'server-only';
// DB-backed SMTP configuration. Non-secret fields (host, port, from, secure) live in the
// public `email_public` row; the SMTP username and password live encrypted in the
// ADMIN-only `email_secret` row. Resolution is DB-first with an env fallback
// (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM_EMAIL / SMTP_FROM_NAME) so
// existing deployments keep working until the values are moved into the CMS.
import {
  createClient,
  getServiceRoleSupabaseClient,
  encryptWithEnvKey,
  getSecretEnvelopeStatus,
  isSandboxEnvironment,
  resealWithEnvKey,
  resolveConfigValue,
  siteSettingSecretSlot,
  tryDecryptWithEnvKey,
} from '@nextblock-cms/db/server';
import type { Json } from '@nextblock-cms/db';
import { requireCmsAdmin } from '../auth/cms-actor';

const EMAIL_PUBLIC_KEY = 'email_public';
const EMAIL_SECRET_KEY = 'email_secret';
/**
 * Each credential opens only from its own field of `email_secret` (libs/db secret-crypto). SMTP
 * AUTH hands both to whatever host is saved, so an envelope copied in from another row (the Stripe
 * key, the captcha secret, a Cortex key) must never decrypt here (2026-11-04).
 */
function emailSecretSlot(field: 'user' | 'pass') {
  return siteSettingSecretSlot(EMAIL_SECRET_KEY, field);
}

export type EmailPublicSettings = {
  host: string;
  port: string;
  fromEmail: string;
  fromName: string;
  secure: boolean;
};

export const DEFAULT_EMAIL_PUBLIC_SETTINGS: EmailPublicSettings = {
  host: '',
  port: '',
  fromEmail: '',
  fromName: '',
  secure: true,
};

/** What the CMS form needs: public fields + whether each secret is already stored. */
export type EmailSettingsView = EmailPublicSettings & {
  hasUser: boolean;
  hasPass: boolean;
  userLast4: string | null;
  envFallbackActive: boolean;
  /**
   * The saved host is ignored: the username or password still comes from SMTP_USER / SMTP_PASS,
   * and those only ever go to SMTP_HOST (see resolveEmailServerConfig).
   */
  hostPinnedToEnv: boolean;
  /** The sandbox: its admin login is public, so nothing here can be saved or test-sent. */
  readOnly: boolean;
};

/** Fully-resolved transport config consumed by nodemailer. */
export type ResolvedEmailConfig = {
  /** Refuse to send unless the connection is upgraded to TLS (STARTTLS ports). */
  requireTLS?: boolean;
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  from: string;
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === 'on';
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizePublic(value: unknown): EmailPublicSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    host: asString(raw['host']),
    port: asString(raw['port']),
    fromEmail: asString(raw['fromEmail']),
    fromName: asString(raw['fromName']),
    secure: asBool(raw['secure'], true),
  };
}

export async function getEmailPublicSettings(): Promise<EmailPublicSettings> {
  const supabase = createClient();
  const { data } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', EMAIL_PUBLIC_KEY)
    .maybeSingle();
  return normalizePublic(data?.value);
}

/**
 * Read the public settings plus stored-secret status for the CMS form. ADMIN only, read
 * with the service role after the role check: `email_secret` is a secret row of
 * `site_settings`, which no API session reaches since migration 02038 (only the service role
 * does; see `lib/auth/cms-actor.ts`).
 */
export async function getEmailSettingsView(): Promise<EmailSettingsView> {
  const { supabase } = await requireCmsAdmin();
  const [{ data: publicData }, { data: secretData }] = await Promise.all([
    supabase.from('site_settings').select('value').eq('key', EMAIL_PUBLIC_KEY).maybeSingle(),
    supabase.from('site_settings').select('value').eq('key', EMAIL_SECRET_KEY).maybeSingle(),
  ]);

  const pub = normalizePublic(publicData?.value);
  const secret = asRecord(secretData?.value);
  const userStatus = getSecretEnvelopeStatus(secret['user']);
  const passStatus = getSecretEnvelopeStatus(secret['pass']);
  const envHost = (process.env['SMTP_HOST'] ?? '').trim();
  // The resolver's own test: a stored login it cannot decrypt (after a key change, or sealed for
  // another slot) counts as missing there, so the hint must say the env login is used.
  const credentialFromEnv =
    !tryDecryptWithEnvKey(secret['user'], emailSecretSlot('user'))?.trim() ||
    !tryDecryptWithEnvKey(secret['pass'], emailSecretSlot('pass'))?.trim();
  // The sandbox saves nothing here and sends only through its SMTP_* env, so neither hint applies
  // there: both describe what saving the form would change, next to the read-only note.
  const readOnly = isSandboxEnvironment();

  return {
    ...pub,
    hasUser: userStatus.hasStoredValue,
    hasPass: passStatus.hasStoredValue,
    userLast4: userStatus.last4,
    // Show a hint in the UI when SMTP still comes from env vars rather than the CMS.
    envFallbackActive: !readOnly && !pub.host && Boolean(envHost),
    hostPinnedToEnv:
      !readOnly && Boolean(envHost) && credentialFromEnv && Boolean(pub.host.trim()) && !sameSmtpHost(pub.host, envHost),
    readOnly,
  };
}

export type SaveEmailSettingsInput = {
  host: string;
  port: string;
  fromEmail: string;
  fromName: string;
  secure: boolean;
  /** Only persisted when non-empty — a blank field keeps the existing stored secret. */
  user?: string;
  pass?: string;
};

/**
 * Persist email settings. Public fields always overwrite; secret fields are encrypted
 * and only written when a new value is supplied, and a stored credential from before 0.23.1 is
 * re-sealed for its field on every save. Refuses everything on the sandbox: its
 * admin login is public, and a saved host would steer where mail goes (2026-11-03: with the
 * credentials left to SMTP_USER / SMTP_PASS, a visitor could point it at their own server and
 * capture the deployment's login). Enforces ADMIN itself (throws otherwise) and
 * writes with the service role: `email_secret` is a secret row of `site_settings`, which no API
 * session can write since migration 02038.
 */
export async function saveEmailSettings(input: SaveEmailSettingsInput): Promise<void> {
  const { supabase } = await requireCmsAdmin();

  if (isSandboxEnvironment()) {
    throw new Error('Email settings cannot be changed in the sandbox.');
  }

  const publicValue: EmailPublicSettings = {
    host: input.host.trim(),
    port: input.port.trim(),
    fromEmail: input.fromEmail.trim(),
    fromName: input.fromName.trim(),
    secure: input.secure,
  };
  if (publicValue.port && parseSmtpPort(publicValue.port) === null) {
    throw new Error('Port must be a whole number from 1 to 65535.');
  }

  const { error: publicError } = await supabase
    .from('site_settings')
    .upsert({ key: EMAIL_PUBLIC_KEY, value: publicValue });
  if (publicError) {
    console.error('Error saving email_public settings:', publicError.message);
    throw new Error('Failed to save email settings.');
  }

  const newUser = input.user?.trim();
  const newPass = input.pass?.trim();
  // Read-merge so updating only one of user/pass keeps the other. What is kept is re-sealed for
  // its own field: an envelope from before 0.23.1 opens in any slot, so every save, one that
  // changes neither credential included, leaves both bound to where they are stored.
  const { data: existing, error: readError } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', EMAIL_SECRET_KEY)
    .maybeSingle();
  if (readError) {
    console.error('Error reading email_secret settings:', readError.message);
    // Writing now could drop the credential that was not re-entered.
    if (newUser || newPass) throw new Error('Failed to save email credentials.');
  } else {
    const current = asRecord(existing?.value);
    const nextValue: Record<string, unknown> = { ...current };
    let changed = false;
    for (const [field, supplied] of [
      ['user', newUser],
      ['pass', newPass],
    ] as const) {
      const slot = emailSecretSlot(field);
      const next = supplied ? encryptWithEnvKey(supplied, slot) : resealWithEnvKey(current[field], slot);
      if (next !== current[field]) {
        nextValue[field] = next;
        changed = true;
      }
    }

    if (changed) {
      const { error: secretError } = await supabase
        .from('site_settings')
        .upsert({ key: EMAIL_SECRET_KEY, value: nextValue as Json });
      if (secretError) {
        console.error('Error saving email_secret settings:', secretError.message);
        throw new Error('Failed to save email credentials.');
      }
    }
  }

  // The mailer memoizes the resolved transport config; make the new values live now.
  invalidateEmailConfigCache();
}

// Resolving SMTP costs two service-role reads plus an AES decrypt of each secret, and
// transactional email (2FA codes especially) is latency-sensitive. The values only change
// when an admin saves the form, so memoize briefly and bust the cache on save.
const CONFIG_CACHE_TTL_MS = 60_000;
type ConfigCacheEntry = { value: ResolvedEmailConfig | null; expiresAt: number; warnings: string[] };
let configCache: ConfigCacheEntry | null = null;

/**
 * Print what a resolution found on the first call that may log. A silent check
 * (isEmailConfigured, UI gating) fills the cache first on several paths, and the send right after
 * it must still say why it picked a port or why mail is off.
 */
function reportWarnings(entry: ConfigCacheEntry, options: { silent?: boolean }): ResolvedEmailConfig | null {
  if (!options.silent && entry.warnings.length > 0) {
    for (const message of entry.warnings) console.warn(message);
    entry.warnings = [];
  }
  return entry.value;
}

function rememberEmailConfig(
  value: ResolvedEmailConfig | null,
  warnings: string[],
  options: { silent?: boolean }
): ResolvedEmailConfig | null {
  configCache = { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS, warnings };
  return reportWarnings(configCache, options);
}

/** Drop the memoized SMTP config so the next resolve re-reads the DB. */
export function invalidateEmailConfigCache(): void {
  configCache = null;
}

/**
 * Cheap "can this instance actually send mail right now?" check for UI gating. Never
 * logs — an unconfigured instance is an expected state here, not an error condition.
 */
export async function isEmailConfigured(): Promise<boolean> {
  return (await resolveEmailServerConfig({ silent: true })) !== null;
}

/**
 * Ports whose TLS mode is not a preference but a protocol fact.
 *
 * 465 is SMTPS: the server expects a TLS handshake as the very first bytes. 25, 587 and
 * 2525 are plaintext-then-STARTTLS: the server opens with a plaintext `220` greeting.
 *
 * Getting this backwards produces an error nobody can act on. Implicit TLS against a
 * STARTTLS port makes OpenSSL read that plaintext greeting as a TLS record and fail with
 * "ssl3_get_record:wrong version number" — which says nothing about ports or SMTP. The
 * combination is never valid, so rather than honour a setting that cannot work, reconcile
 * it and say so.
 */
const IMPLICIT_TLS_PORTS = new Set([465]);
const STARTTLS_PORTS = new Set([25, 587, 2525]);

/** The submission port, for env credentials pinned to SMTP_HOST when nothing names another. */
const DEFAULT_SUBMISSION_PORT = 587;

/** A TCP port written as plain digits (1 to 65535), or null for anything else. */
function parseSmtpPort(value: string | null | undefined): number | null {
  const text = (value ?? '').trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Host names compare without case or surrounding whitespace. */
function sameSmtpHost(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  return left !== '' && left === (b ?? '').trim().toLowerCase();
}

/** SMTP_PORT, when it is a port. */
function envSmtpPort(): number | null {
  return parseSmtpPort(resolveConfigValue(null, 'SMTP_PORT', { warnOnEnvFallback: false }));
}

/** A stored value for a log line: at most 32 characters, printable ASCII only, quoted. */
function describeStoredValue(value: string): string {
  let shown = '';
  for (const character of value.slice(0, 32)) {
    const code = character.charCodeAt(0);
    shown += code >= 0x20 && code <= 0x7e ? character : '?';
  }
  return `${JSON.stringify(shown)}${value.length > 32 ? '…' : ''}`;
}

/**
 * The port for env credentials pinned to SMTP_HOST. A port saved in the CMS for that same server
 * (no CMS host, or SMTP_HOST itself) comes first, as every CMS field does; then SMTP_PORT; then
 * 587. A CMS port never moves the credentials off SMTP_HOST, and resolveEmailServerConfig demands
 * TLS when it moves them off the port the env alone gives, so it cannot lower their protection
 * either. Without this, an install that kept its port only in the CMS sent no mail at all once
 * the host was pinned (2026-11-03), email sign-in codes included.
 */
function pinnedSmtpPort(pub: EmailPublicSettings, envHost: string): { port: number; source: 'cms' | 'env' | 'default' } {
  const cmsPort = parseSmtpPort(pub.port);
  if (cmsPort !== null && (!pub.host.trim() || sameSmtpHost(pub.host, envHost))) return { port: cmsPort, source: 'cms' };
  // A saved value that is not a port, with implicit TLS switched on for SMTP_HOST itself: before
  // 2026-11-03 nodemailer read that as 465, ahead of SMTP_PORT like any saved value, so it still does.
  if (pub.port.trim() && sameSmtpHost(pub.host, envHost) && pub.secure) return { port: 465, source: 'cms' };
  const envPort = envSmtpPort();
  if (envPort !== null) return { port: envPort, source: 'env' };
  return { port: DEFAULT_SUBMISSION_PORT, source: 'default' };
}

/** Local relays (Mailpit, MailHog, Papercut) legitimately speak plaintext with no TLS. */
function isLocalRelay(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export interface ReconciledTls {
  secure: boolean;
  /** True when we refuse to send unless the connection is upgraded to TLS. */
  requireTLS: boolean;
  /** Set when the stored setting disagreed with the port and was overridden. */
  correctedFrom?: boolean;
}

export function reconcileTlsForPort(
  port: number,
  configuredSecure: boolean,
  host: string
): ReconciledTls {
  if (IMPLICIT_TLS_PORTS.has(port)) {
    return {
      secure: true,
      requireTLS: false,
      ...(configuredSecure ? {} : { correctedFrom: configuredSecure }),
    };
  }

  if (STARTTLS_PORTS.has(port)) {
    return {
      secure: false,
      // Opportunistic STARTTLS would silently send credentials in the clear against a
      // relay that stopped advertising it. Demand the upgrade — every hosted provider
      // on these ports supports it; only a local test relay might not.
      requireTLS: !isLocalRelay(host),
      ...(configuredSecure ? { correctedFrom: configuredSecure } : {}),
    };
  }

  // A non-standard port carries no convention, so the operator's choice stands.
  return { secure: configuredSecure, requireTLS: false };
}

/**
 * Resolve the full SMTP transport config, DB-first with an env fallback. Uses the
 * service-role client so it works from any context (the secret row is service-role only since
 * 02038). Returns null when host/user/pass/from cannot be resolved from either source. A stored
 * credential counts only when it opens from its own field of `email_secret`: an envelope copied
 * in from another row reads as missing, so it never reaches SMTP AUTH.
 *
 * Two rules keep the deployment's SMTP_* login with the server it belongs to:
 * - On the sandbox the database is never read: its admin login is public, so only the
 *   deployment's SMTP_* env counts.
 * - A username or password taken from SMTP_USER / SMTP_PASS goes only to SMTP_HOST (on the
 *   port pinnedSmtpPort picks), and never unencrypted because of a value saved in the CMS. SMTP
 *   AUTH hands the credentials to whatever server the transport connects to, so pairing them
 *   with a host from the CMS let anyone who could save that host capture them on the next send.
 *   Credentials saved in the CMS still go to the CMS host.
 *
 * Memoized for CONFIG_CACHE_TTL_MS; pass `silent` when "not configured" is an expected
 * answer (UI gating) rather than a misconfiguration worth warning about. Its warnings then wait
 * for the next call that may log.
 */
export async function resolveEmailServerConfig(
  options: { silent?: boolean } = {},
): Promise<ResolvedEmailConfig | null> {
  const cached = configCache;
  if (cached && cached.expiresAt > Date.now()) {
    return reportWarnings(cached, options);
  }

  let pub: EmailPublicSettings = DEFAULT_EMAIL_PUBLIC_SETTINGS;
  let secret: Record<string, unknown> = {};

  if (!isSandboxEnvironment()) {
    try {
      const supabase = getServiceRoleSupabaseClient();
      const [{ data: publicData }, { data: secretData }] = await Promise.all([
        supabase.from('site_settings').select('value').eq('key', EMAIL_PUBLIC_KEY).maybeSingle(),
        supabase.from('site_settings').select('value').eq('key', EMAIL_SECRET_KEY).maybeSingle(),
      ]);
      pub = normalizePublic(publicData?.value);
      secret = asRecord(secretData?.value);
    } catch {
      // No service-role key (unconfigured instance) — fall through to env-only resolution.
    }
  }

  // Each from its own field only: an envelope sealed for another row never reaches SMTP AUTH.
  const storedUser = tryDecryptWithEnvKey(secret['user'], emailSecretSlot('user'));
  const storedPass = tryDecryptWithEnvKey(secret['pass'], emailSecretSlot('pass'));
  const user = resolveConfigValue(storedUser, 'SMTP_USER');
  const pass = resolveConfigValue(storedPass, 'SMTP_PASS');
  const envHost = resolveConfigValue(null, 'SMTP_HOST', { warnOnEnvFallback: false });
  const credentialFromEnv = !storedUser?.trim() || !storedPass?.trim();
  const pinToEnvHost = credentialFromEnv && Boolean(envHost);
  const warnings: string[] = [];
  if (pinToEnvHost && pub.host.trim() && !sameSmtpHost(pub.host, envHost)) {
    warnings.push(
      '[email] SMTP_USER / SMTP_PASS come from the environment, so mail goes to SMTP_HOST; the host and ' +
        'port saved in CMS Settings → Email are ignored. Save the username and password there to use them.'
    );
  }

  const host = pinToEnvHost ? envHost : resolveConfigValue(pub.host, 'SMTP_HOST');
  const pinnedPort = pinToEnvHost && envHost ? pinnedSmtpPort(pub, envHost) : null;
  const unusableCmsPort =
    pub.port.trim() !== '' && parseSmtpPort(pub.port) === null && (!pub.host.trim() || sameSmtpHost(pub.host, envHost));
  if (pinnedPort && unusableCmsPort) {
    warnings.push(
      `[email] ${describeStoredValue(pub.port)} saved in CMS Settings → Email is not an SMTP port, so mail to ` +
        `SMTP_HOST uses port ${pinnedPort.port}.`
    );
  } else if (pinnedPort?.source === 'default') {
    warnings.push(
      isSandboxEnvironment()
        ? `[email] No usable SMTP_PORT, so mail to SMTP_HOST uses port ${DEFAULT_SUBMISSION_PORT}. Set SMTP_PORT to choose it.`
        : '[email] No usable SMTP_PORT, and no usable port is saved for SMTP_HOST in CMS Settings → Email, so ' +
            `mail to SMTP_HOST uses port ${DEFAULT_SUBMISSION_PORT}. Set SMTP_PORT to choose it.`
    );
  }
  const port = pinnedPort ? String(pinnedPort.port) : resolveConfigValue(pub.port, 'SMTP_PORT');
  const fromEmail = resolveConfigValue(pub.fromEmail, 'SMTP_FROM_EMAIL');
  const fromName = resolveConfigValue(pub.fromName, 'SMTP_FROM_NAME');

  if (!host || !port || !user || !pass || !fromEmail) {
    warnings.push('Email is not configured (CMS or SMTP_* env). Outbound email will not be sent.');
    return rememberEmailConfig(null, warnings, options);
  }

  // The CMS TLS toggle was saved for the CMS host: it counts wherever that host is the one used
  // (for env credentials, only when it names SMTP_HOST itself).
  const tlsFromDb = Boolean(pub.host.trim()) && (!pinToEnvHost || sameSmtpHost(pub.host, envHost));
  const parsedPort = parseSmtpPort(port);
  const configuredSecure = tlsFromDb ? pub.secure : parsedPort === 465;
  // Not a port at all: nodemailer would quietly pick 465 or 587 and, on 587, settle for
  // opportunistic STARTTLS. Pick the same port here, so the TLS rules below still apply.
  const portNumber = parsedPort ?? (configuredSecure ? 465 : DEFAULT_SUBMISSION_PORT);
  if (parsedPort === null) {
    warnings.push(
      `[email] ${describeStoredValue(port)} is not an SMTP port, so mail uses port ${portNumber}. ` +
        'Correct it in CMS Settings → Email or SMTP_PORT.'
    );
  }
  // The CMS toggle defaults to ON, so a host entered with port 587 or 2525 lands in a
  // combination that can never connect. Reconcile against the port before building the
  // transport rather than letting it fail at handshake time.
  const tls = reconcileTlsForPort(portNumber, configuredSecure, host);
  if (tls.correctedFrom !== undefined) {
    warnings.push(
      `[email] Port ${portNumber} requires TLS mode "${tls.secure ? 'implicit' : 'STARTTLS'}"; ` +
        `the saved setting said the opposite and was overridden. Update it in CMS Settings → Email.`
    );
  }
  // A CMS port that moves env credentials off the port the env alone gives demands TLS (a loopback
  // relay aside): only the SMTP_* env may settle for opportunistic STARTTLS on a non-standard
  // port. The toggle needs no such rule, since it can only raise TLS above the env's own choice.
  // The split legacy setup (SMTP_HOST unset) is not pinned: there the CMS picks host, port and TLS.
  const envOnlyPort = envSmtpPort();
  const cmsMovedPort = pinnedPort?.source === 'cms' && pinnedPort.port !== (envOnlyPort ?? DEFAULT_SUBMISSION_PORT);
  if (cmsMovedPort && !tls.secure && !tls.requireTLS && !isLocalRelay(host)) {
    warnings.push(
      `[email] Port ${portNumber} saved in CMS Settings → Email moves the SMTP_USER / SMTP_PASS login off ` +
        `${envOnlyPort !== null ? `SMTP_PORT (${envOnlyPort})` : `the default port ${DEFAULT_SUBMISSION_PORT}`}, so it must ` +
        `upgrade to TLS there. To send to a relay without STARTTLS on that port, set SMTP_PORT=${portNumber}.`
    );
  }
  const resolved: ResolvedEmailConfig = {
    host,
    port: portNumber,
    secure: tls.secure,
    requireTLS: tls.requireTLS || (cmsMovedPort && !tls.secure && !isLocalRelay(host)),
    auth: { user, pass },
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
  };
  return rememberEmailConfig(resolved, warnings, options);
}
