import 'server-only';
// The single outbound-mail choke point. Deliberately NOT a "use server" module: every
// caller is server-side (2FA codes, form/interaction notifications, feedback, the SMTP
// test), and marking it as an action would register `sendEmail` as a client-callable
// endpoint — an open relay taking an arbitrary recipient, subject and HTML body.

import nodemailer, { type Transporter } from 'nodemailer';
import { isSandboxEnvironment } from '@nextblock-cms/db/server';
import { resolveEmailServerConfig, type ResolvedEmailConfig } from '../../lib/config/email-settings';
import { applyEmailBranding, resolveEmailBranding } from '../../lib/email/branding';

interface EmailParams {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Where a reply should go, when that is not the SMTP identity. Set only from a
   * server-validated address — it lands in a mail header, so an unvalidated value
   * would be a header-injection vector.
   */
  replyTo?: string;
  /** Stable id for this message, so later mail can reference it. */
  messageId?: string;
  /** Thread root this message answers. Makes a "Re:" subject legitimate. */
  inReplyTo?: string;
  /** Full reference chain; mail clients thread on this. */
  references?: string;
}

// Without explicit bounds nodemailer inherits the OS socket timeouts, so an unreachable
// or silently-dropping relay hangs the request (and the user's spinner) for minutes.
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

// Opening a fresh SMTP connection per message costs a TCP handshake + TLS negotiation +
// AUTH round trip before the first byte of the message is sent — typically the bulk of the
// wait when a user clicks "send me a code". A pooled transport keeps the authenticated
// connection warm so subsequent sends start at DATA. Set SMTP_POOL=false to opt out.
const POOL_ENABLED = process.env['SMTP_POOL'] !== 'false';

let cachedTransport: { key: string; transporter: Transporter } | null = null;

/** Identity of a transport: anything that changes it must force a rebuild. */
function transportKey(config: ResolvedEmailConfig): string {
  return [config.host, config.port, config.secure, config.requireTLS ?? false, config.auth.user].join('|');
}

function getTransporter(config: ResolvedEmailConfig): Transporter {
  const key = transportKey(config);
  if (cachedTransport && cachedTransport.key === key) {
    return cachedTransport.transporter;
  }

  // Settings changed — tear the old pool down rather than leaking its sockets.
  if (cachedTransport) {
    try {
      cachedTransport.transporter.close();
    } catch {
      /* already closed */
    }
    cachedTransport = null;
  }

  const base = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Set on STARTTLS ports against a remote relay: without it nodemailer would fall
    // back to plaintext if the server stopped advertising STARTTLS, quietly shipping
    // credentials in the clear.
    ...(config.requireTLS ? { requireTLS: true } : {}),
    auth: config.auth,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };

  // Branched rather than `pool: POOL_ENABLED` — nodemailer types `pool` as the literal
  // `true` to select the pooled transport overload, so a boolean matches neither.
  const transporter: Transporter = POOL_ENABLED
    ? nodemailer.createTransport({ ...base, pool: true, maxConnections: 3, maxMessages: 100 })
    : nodemailer.createTransport(base);

  // A pool that errors out (relay restart, credentials rotated, idle socket reaped) must
  // not be handed to the next caller — drop it so the following send reconnects cleanly.
  transporter.on('error', () => {
    if (cachedTransport?.transporter === transporter) {
      cachedTransport = null;
    }
  });

  cachedTransport = { key, transporter };
  return transporter;
}

/** Any value bound for a mail header: a newline here would inject extra headers. */
function header(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Domain of the configured From address, used to mint RFC-compliant Message-IDs.
 * Falls back to a neutral literal rather than inventing a domain we do not control.
 */
export async function resolveFromDomain(): Promise<string> {
  const config = await resolveEmailServerConfig({ silent: true });
  const match = config?.from?.match(/@([^>\s]+)/);
  return match?.[1]?.trim() || 'localhost';
}

/**
 * Turn a transport failure into something the person reading it can act on.
 *
 * The raw text is written for whoever wrote OpenSSL, not for a shop owner: an admin who
 * sees "ssl3_get_record:wrong version number" beside their reply learns nothing, and the
 * actual cause — a TLS mode that does not match the port — is never mentioned. The
 * original is still logged server-side; this is what gets stored and shown.
 */
export function describeSmtpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code ?? '';

  if (/wrong version number/i.test(raw)) {
    return 'The mail server refused the TLS handshake. This almost always means the TLS setting does not match the port: ports 25, 587 and 2525 need TLS OFF (STARTTLS), port 465 needs it ON. Check CMS Settings → Email.';
  }
  if (/ssl|tls|certificate/i.test(raw) && /alert|handshake|self.signed|unable to verify/i.test(raw)) {
    return `The mail server's TLS certificate could not be verified (${raw.slice(0, 120)}). Check the host name matches the certificate.`;
  }
  if (code === 'EAUTH' || /invalid login|authentication failed|535/i.test(raw)) {
    return 'The mail server rejected the username or password. Re-enter the SMTP credentials in CMS Settings → Email.';
  }
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(raw)) {
    return 'The mail server hostname could not be resolved. Check the SMTP host in CMS Settings → Email.';
  }
  if (code === 'ECONNREFUSED') {
    return 'The mail server refused the connection. Check the SMTP host and port in CMS Settings → Email.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /timeout/i.test(raw)) {
    return 'The mail server did not respond in time. It may be unreachable from this host, or the port may be blocked.';
  }
  if (/not configured/i.test(raw)) {
    return 'Email sending is not configured yet. Add SMTP details in CMS Settings → Email.';
  }
  return raw;
}

/** NextBlock's product feedback inbox (`submitFeedback`, app/actions/feedback.ts). */
export const PRODUCT_FEEDBACK_INBOX = 'feedback@nextblock.dev';

/**
 * The public sandbox (published admin login) mails only inboxes no visitor can choose: its
 * operator's (SANDBOX_CONTACT_EMAIL) and the product feedback inbox, fixed in code.
 */
function isSandboxRecipientAllowed(to: string): boolean {
  const allowed = new Set([PRODUCT_FEEDBACK_INBOX]);
  const operator = process.env['SANDBOX_CONTACT_EMAIL']?.trim().toLowerCase();
  if (operator) allowed.add(operator);
  const recipients = to.split(',').map((address) => address.trim().toLowerCase()).filter(Boolean);
  return recipients.length > 0 && recipients.every((address) => allowed.has(address));
}

export async function sendEmail({
  to,
  subject,
  text,
  html,
  replyTo,
  messageId,
  inReplyTo,
  references,
}: EmailParams) {
  // 2026-11-03: every visitor to the public sandbox is its admin, so a visitor chose both the
  // recipient and the text of mail sent on the deployment's SMTP account: a contact form's sender
  // address answered from /cms/messages, the comment notification list, a stored form recipient.
  // There, only the operator's own inbox (SANDBOX_CONTACT_EMAIL) and the product feedback inbox
  // are ever recipients (`to` is the only recipient field: no cc, no bcc). Any other send fails before the config is even read,
  // and every caller already records or reports a failed send.
  if (isSandboxEnvironment() && !isSandboxRecipientAllowed(to)) {
    throw new Error('Email is turned off in the sandbox.');
  }

  // DB-first (CMS Settings → Configuration → Email), falling back to SMTP_* env vars.
  // Resolved in parallel with branding — neither depends on the other, and both are
  // pure reads standing between the click and the first SMTP packet.
  const [emailConfig, branding] = await Promise.all([
    resolveEmailServerConfig(),
    resolveEmailBranding(),
  ]);

  if (!emailConfig) {
    throw new Error("Email server is not configured. Configure SMTP in CMS Settings → Configuration → Email.");
  }

  // Single interception point: white-label every outgoing email with the tenant's own
  // logo + site name (or a text banner when no logo is set). Every app-dispatched email
  // funnels through here, so branding is applied once, centrally.
  const brandedHtml = applyEmailBranding(html, branding);

  const transporter = getTransporter(emailConfig);

  const options = {
    from: emailConfig.from,
    to,
    subject,
    text,
    html: brandedHtml,
    // Stripped of CR/LF defensively: these values end up in mail headers.
    ...(replyTo ? { replyTo: header(replyTo) } : {}),
    ...(messageId ? { messageId: header(messageId) } : {}),
    ...(inReplyTo ? { inReplyTo: header(inReplyTo) } : {}),
    ...(references ? { references: header(references) } : {}),
  };

  try {
    return await transporter.sendMail(options);
  } catch (error) {
    if (!isTransientTransportError(error)) throw error;

    // A pooled connection that the relay reaped while it sat idle looks alive to
    // nodemailer until the send hangs and the socket times out. That is exactly what a
    // long-running dev server or a quiet production instance produces: everything
    // verifies, one send fails, the next works. Drop the pool and try once more on a
    // fresh single-use connection before reporting failure.
    console.warn('[email] Transient transport failure; retrying once on a fresh connection.', error);
    try {
      cachedTransport?.transporter.close();
    } catch {
      /* already closed */
    }
    cachedTransport = null;

    const retryTransport = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      ...(emailConfig.requireTLS ? { requireTLS: true } : {}),
      auth: emailConfig.auth,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });

    try {
      return await retryTransport.sendMail(options);
    } finally {
      retryTransport.close();
    }
  }
}

/**
 * Whether a failure is worth one more attempt.
 *
 * Only connection-level faults qualify. Retrying a rejected password or a TLS mismatch
 * just fails again a second time and delays the real answer.
 */
function isTransientTransportError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);

  return (
    ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EPIPE', 'ECONNECTION', 'EAI_AGAIN'].includes(code) ||
    /timeout|socket close|connection closed|read ECONNRESET/i.test(message)
  );
}
