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
  resolveConfigValue,
  tryDecryptWithEnvKey,
} from '@nextblock-cms/db/server';

const EMAIL_PUBLIC_KEY = 'email_public';
const EMAIL_SECRET_KEY = 'email_secret';

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
 * Read the public settings plus stored-secret status for the CMS form. Uses the
 * request-scoped client; RLS restricts the secret row to ADMIN, which is who reaches
 * this page.
 */
export async function getEmailSettingsView(): Promise<EmailSettingsView> {
  const supabase = createClient();
  const [{ data: publicData }, { data: secretData }] = await Promise.all([
    supabase.from('site_settings').select('value').eq('key', EMAIL_PUBLIC_KEY).maybeSingle(),
    supabase.from('site_settings').select('value').eq('key', EMAIL_SECRET_KEY).maybeSingle(),
  ]);

  const pub = normalizePublic(publicData?.value);
  const secret = (secretData?.value ?? {}) as Record<string, unknown>;
  const userStatus = getSecretEnvelopeStatus(secret['user']);
  const passStatus = getSecretEnvelopeStatus(secret['pass']);

  return {
    ...pub,
    hasUser: userStatus.hasStoredValue,
    hasPass: passStatus.hasStoredValue,
    userLast4: userStatus.last4,
    // Show a hint in the UI when SMTP still comes from env vars rather than the CMS.
    envFallbackActive: !pub.host && Boolean(process.env['SMTP_HOST']),
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
 * and only written when a new value is supplied. Refuses to store real secrets in the
 * sandbox (its DB resets every 15 minutes). Caller must enforce ADMIN; RLS double-enforces.
 */
export async function saveEmailSettings(input: SaveEmailSettingsInput): Promise<void> {
  const supabase = createClient();

  const publicValue: EmailPublicSettings = {
    host: input.host.trim(),
    port: input.port.trim(),
    fromEmail: input.fromEmail.trim(),
    fromName: input.fromName.trim(),
    secure: input.secure,
  };

  const { error: publicError } = await supabase
    .from('site_settings')
    .upsert({ key: EMAIL_PUBLIC_KEY, value: publicValue });
  if (publicError) {
    console.error('Error saving email_public settings:', publicError.message);
    throw new Error('Failed to save email settings.');
  }

  const newUser = input.user?.trim();
  const newPass = input.pass?.trim();
  if (newUser || newPass) {
    if (isSandboxEnvironment()) {
      throw new Error('The sandbox cannot store live SMTP credentials.');
    }

    // Read-merge so updating only one of user/pass keeps the other.
    const { data: existing } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', EMAIL_SECRET_KEY)
      .maybeSingle();
    const current = (existing?.value ?? {}) as Record<string, unknown>;

    const nextValue: Record<string, unknown> = { ...current };
    if (newUser) nextValue['user'] = encryptWithEnvKey(newUser);
    if (newPass) nextValue['pass'] = encryptWithEnvKey(newPass);

    const { error: secretError } = await supabase
      .from('site_settings')
      .upsert({ key: EMAIL_SECRET_KEY, value: nextValue });
    if (secretError) {
      console.error('Error saving email_secret settings:', secretError.message);
      throw new Error('Failed to save email credentials.');
    }
  }

  // The mailer memoizes the resolved transport config; make the new values live now.
  invalidateEmailConfigCache();
}

// Resolving SMTP costs two service-role reads plus an AES decrypt of each secret, and
// transactional email (2FA codes especially) is latency-sensitive. The values only change
// when an admin saves the form, so memoize briefly and bust the cache on save.
const CONFIG_CACHE_TTL_MS = 60_000;
let configCache: { value: ResolvedEmailConfig | null; expiresAt: number } | null = null;

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
 * service-role client so it works from any context (the secret row is ADMIN-only under
 * RLS). Returns null when host/user/pass/from cannot be resolved from either source.
 *
 * Memoized for CONFIG_CACHE_TTL_MS; pass `silent` when "not configured" is an expected
 * answer (UI gating) rather than a misconfiguration worth warning about.
 */
export async function resolveEmailServerConfig(
  options: { silent?: boolean } = {},
): Promise<ResolvedEmailConfig | null> {
  const cached = configCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let pub: EmailPublicSettings = DEFAULT_EMAIL_PUBLIC_SETTINGS;
  let secret: Record<string, unknown> = {};

  try {
    const supabase = getServiceRoleSupabaseClient();
    const [{ data: publicData }, { data: secretData }] = await Promise.all([
      supabase.from('site_settings').select('value').eq('key', EMAIL_PUBLIC_KEY).maybeSingle(),
      supabase.from('site_settings').select('value').eq('key', EMAIL_SECRET_KEY).maybeSingle(),
    ]);
    pub = normalizePublic(publicData?.value);
    secret = (secretData?.value ?? {}) as Record<string, unknown>;
  } catch {
    // No service-role key (unconfigured instance) — fall through to env-only resolution.
  }

  const host = resolveConfigValue(pub.host, 'SMTP_HOST');
  const port = resolveConfigValue(pub.port, 'SMTP_PORT');
  const fromEmail = resolveConfigValue(pub.fromEmail, 'SMTP_FROM_EMAIL');
  const fromName = resolveConfigValue(pub.fromName, 'SMTP_FROM_NAME');
  const user = resolveConfigValue(tryDecryptWithEnvKey(secret['user']), 'SMTP_USER');
  const pass = resolveConfigValue(tryDecryptWithEnvKey(secret['pass']), 'SMTP_PASS');

  if (!host || !port || !user || !pass || !fromEmail) {
    if (!options.silent) {
      console.warn('Email is not configured (CMS or SMTP_* env). Outbound email will not be sent.');
    }
    configCache = { value: null, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return null;
  }

  const portNumber = Number(port);
  // The CMS toggle defaults to ON, so a host entered with port 587 or 2525 lands in a
  // combination that can never connect. Reconcile against the port before building the
  // transport rather than letting it fail at handshake time.
  const tls = reconcileTlsForPort(portNumber, pub.host ? pub.secure : portNumber === 465, host);
  if (tls.correctedFrom !== undefined) {
    console.warn(
      `[email] Port ${portNumber} requires TLS mode "${tls.secure ? 'implicit' : 'STARTTLS'}"; ` +
        `the saved setting said the opposite and was overridden. Update it in CMS Settings → Email.`
    );
  }
  const resolved: ResolvedEmailConfig = {
    host,
    port: portNumber,
    secure: tls.secure,
    requireTLS: tls.requireTLS,
    auth: { user, pass },
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
  };
  configCache = { value: resolved, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return resolved;
}
