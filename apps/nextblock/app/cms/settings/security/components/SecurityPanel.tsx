'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MailWarning } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Separator,
  Spinner,
} from '@nextblock-cms/ui';
import { Message } from '../../../../../components/form-message';
import {
  MAX_TRUSTED_DEVICE_DAYS,
  MIN_TRUSTED_DEVICE_DAYS,
} from '../../../../../lib/privacy/types';
import {
  disableMfa,
  revokeTrustedDeviceAction,
  sendEmailEnrollmentCode,
  startTotpEnrollment,
  updateAutoAcceptSignups,
  updateGlobalSecuritySettings,
  verifyEmailEnrollment,
  verifyTotpEnrollment,
  type ActionResult,
  type SecurityPanelData,
} from '../actions';

type EnrollMode = 'idle' | 'totp' | 'email';

/**
 * How long the resend button stays parked after a successful send. Relays queue for
 * seconds-to-minutes, and hammering resend is what leaves a user holding several codes
 * with no idea which to type — they all work now, but the wait is still the real fix.
 */
const RESEND_COOLDOWN_SECONDS = 30;

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

export default function SecurityPanel({ data }: { data: SecurityPanelData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);

  const [mode, setMode] = useState<EnrollMode>('idle');
  const [totp, setTotp] = useState<{ factorId: string; qrCode: string; secret: string } | null>(
    null,
  );
  const [emailSent, setEmailSent] = useState(false);
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  // Server-reported: catches SMTP breaking between page load and the click, when the
  // server-rendered `data.emailConfigured` is already stale.
  const [smtpUnavailable, setSmtpUnavailable] = useState(false);
  const emailAvailable = data.emailConfigured && !smtpUnavailable;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /**
   * Actions report failure by returning it, so a failed one must not run `onSuccess` — a
   * rejected code has to leave the QR / code entry on screen for another attempt.
   */
  const run = (fn: () => Promise<ActionResult>, onSuccess?: () => void) => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (!result.ok) {
          if (result.needsSmtp) setSmtpUnavailable(true);
          setMessage({ error: result.error });
          return;
        }
        setMessage({ success: result.message });
        onSuccess?.();
        router.refresh();
      } catch (error) {
        // Transport-level only (the actions themselves no longer throw).
        setMessage({
          error: error instanceof Error ? error.message : 'Something went wrong.',
        });
      }
    });
  };

  const resetEnrollment = () => {
    setMode('idle');
    setTotp(null);
    setEmailSent(false);
    setCode('');
  };

  // --- Enrollment handlers ------------------------------------------------------

  const beginTotp = () => {
    setMessage(null);
    setMode('totp');
    setEmailSent(false);
    startTransition(async () => {
      const result = await startTotpEnrollment();
      if (result.ok) {
        setTotp({ factorId: result.factorId, qrCode: result.qrCode, secret: result.secret });
      } else {
        setMessage({ error: result.error });
        setMode('idle');
      }
    });
  };

  const submitTotpCode = () => {
    if (!totp) return;
    const formData = new FormData();
    formData.append('factorId', totp.factorId);
    formData.append('code', code);
    run(() => verifyTotpEnrollment(formData), resetEnrollment);
  };

  /** Used for both the initial "Secure Email Code" click and the Resend button. */
  const requestEmailCode = () => {
    if (!emailAvailable) return;
    setTotp(null);
    setMessage(null);
    if (mode !== 'email') {
      setMode('email');
      setCode('');
    }

    if (cooldown > 0) {
      setMessage({
        success: `A code is already on its way to ${data.email}. You can request another in ${cooldown}s.`,
      });
      return;
    }

    startTransition(async () => {
      try {
        const result = await sendEmailEnrollmentCode();
        if (result.ok) {
          setEmailSent(true);
          setCooldown(RESEND_COOLDOWN_SECONDS);
          setMessage({ success: result.message });
          return;
        }
        if (result.needsSmtp) setSmtpUnavailable(true);
        // Never leave the panel stuck on "Sending…" — drop back to the chooser so the
        // failure and the fix (configure SMTP) are the only things on screen.
        setEmailSent(false);
        setMode('idle');
        setMessage({ error: result.error });
      } catch (error) {
        setEmailSent(false);
        setMode('idle');
        setMessage({
          error: error instanceof Error ? error.message : 'Could not send a code.',
        });
      }
    });
  };

  const submitEmailCode = () => {
    const formData = new FormData();
    formData.append('code', code);
    run(() => verifyEmailEnrollment(formData), resetEnrollment);
  };

  const messageAlert = message && (
    <Alert
      variant={'success' in message ? 'success' : 'destructive'}
      className="py-2 px-4"
    >
      <AlertDescription>
        {'success' in message
          ? message.success
          : 'error' in message
            ? message.error
            : ''}
      </AlertDescription>
    </Alert>
  );

  return (
    <>
      {/* Status + per-user MFA */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Two-Factor Authentication
            {data.mfaEnabled ? (
              <Badge variant="default">
                Enabled · {data.mfaType === 'totp' ? 'Authenticator app' : 'Email code'}
              </Badge>
            ) : (
              <Badge variant="secondary">Off</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Add a second step when you sign in to the CMS. You can use an authenticator
            app (TOTP) or a one-time code sent to <strong>{data.email}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {messageAlert}

          {data.mfaEnabled ? (
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="text-sm">
                <p className="font-medium">
                  {data.mfaType === 'totp'
                    ? 'Authenticator app is protecting your account.'
                    : 'Email verification is protecting your account.'}
                </p>
                <p className="text-slate-500">
                  Disabling 2FA also forgets all of your trusted devices.
                </p>
              </div>
              <Button
                variant="destructive"
                disabled={isPending}
                onClick={() => run(() => disableMfa(), resetEnrollment)}
              >
                {isPending ? <Spinner className="h-4 w-4 animate-spin" /> : 'Disable 2FA'}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {!emailAvailable && <SmtpRequiredNotice isAdmin={data.isAdmin} />}

              {/* Method chooser */}
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={beginTotp}
                  className={`rounded-lg border p-4 text-left transition hover:border-primary ${
                    mode === 'totp' ? 'border-primary ring-1 ring-primary' : ''
                  }`}
                >
                  <span className="block font-medium text-sm">
                    Authenticator App (TOTP)
                  </span>
                  <span className="block text-xs text-slate-500">
                    Scan a QR code with Google Authenticator, 1Password, Authy, etc.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={requestEmailCode}
                  disabled={!emailAvailable}
                  aria-describedby={!emailAvailable ? 'smtp-required-notice' : undefined}
                  className={`rounded-lg border p-4 text-left transition enabled:hover:border-primary disabled:cursor-not-allowed disabled:opacity-60 ${
                    mode === 'email' ? 'border-primary ring-1 ring-primary' : ''
                  }`}
                >
                  <span className="block font-medium text-sm">
                    Secure Email Code
                    {!emailAvailable && (
                      <Badge variant="secondary" className="ml-2 align-middle text-[10px]">
                        Needs SMTP
                      </Badge>
                    )}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {emailAvailable
                      ? 'Receive a 6-digit code at your account email each time you sign in.'
                      : 'Unavailable until an email (SMTP) server is configured for this site.'}
                  </span>
                </button>
              </div>

              {/* TOTP enrollment */}
              {mode === 'totp' && (
                <div className="rounded-lg border p-4 space-y-4">
                  {totp ? (
                    <>
                      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={totp.qrCode}
                          alt="Authenticator setup QR code"
                          className="h-44 w-44 rounded bg-white p-2"
                        />
                        <div className="text-sm space-y-2">
                          <p>1. Scan this QR code with your authenticator app.</p>
                          <p>
                            2. Or enter this key manually:
                            <br />
                            <code className="break-all text-xs bg-muted px-1 py-0.5 rounded">
                              {totp.secret}
                            </code>
                          </p>
                          <p>3. Enter the current 6-digit code below.</p>
                        </div>
                      </div>
                      <div className="flex items-end gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="totp_code">6-digit code</Label>
                          <Input
                            id="totp_code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                            className="w-32 tracking-widest"
                            placeholder="000000"
                          />
                        </div>
                        <Button onClick={submitTotpCode} disabled={isPending || code.length !== 6}>
                          {isPending ? <Spinner className="h-4 w-4 animate-spin" /> : 'Verify & enable'}
                        </Button>
                        <Button variant="ghost" onClick={resetEnrollment} disabled={isPending}>
                          Cancel
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      <Spinner className="h-4 w-4 animate-spin" /> Generating your QR code…
                    </div>
                  )}
                </div>
              )}

              {/* Email enrollment */}
              {mode === 'email' && (
                <div className="rounded-lg border p-4 space-y-4">
                  <p className="text-sm">
                    {emailSent
                      ? `Enter the 6-digit code we sent to ${data.email}.`
                      : 'Sending a verification code to your email…'}
                  </p>
                  <div className="flex items-end gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="email_code">6-digit code</Label>
                      <Input
                        id="email_code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                        className="w-32 tracking-widest"
                        placeholder="000000"
                        disabled={!emailSent}
                      />
                    </div>
                    <Button
                      onClick={submitEmailCode}
                      disabled={isPending || code.length !== 6 || !emailSent}
                    >
                      {isPending ? <Spinner className="h-4 w-4 animate-spin" /> : 'Verify & enable'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={requestEmailCode}
                      disabled={isPending || cooldown > 0}
                      title="Send a new code"
                    >
                      {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}
                    </Button>
                    <Button variant="ghost" onClick={resetEnrollment} disabled={isPending}>
                      Cancel
                    </Button>
                  </div>
                  {emailSent && (
                    <p className="text-xs text-slate-500">
                      Delivery depends on your mail provider and can take a minute. If you
                      request another code, the earlier ones keep working for 5 minutes — enter
                      whichever arrives first.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trusted devices */}
      <Card>
        <CardHeader>
          <CardTitle>Trusted Devices</CardTitle>
          <CardDescription>
            Devices where you chose &ldquo;Remember this device&rdquo; skip 2FA until the
            trust expires. Revoke any you no longer recognize.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.trustedDevices.length === 0 ? (
            <p className="text-sm text-slate-500">No trusted devices.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.trustedDevices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-4 p-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {device.browser_metadata || 'Unknown device'}
                    </p>
                    <p className="text-xs text-slate-500">
                      Trusted {formatDate(device.created_at)} · expires{' '}
                      {formatDate(device.expires_at)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    onClick={() => {
                      const formData = new FormData();
                      formData.append('id', device.id);
                      run(() => revokeTrustedDeviceAction(formData));
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Admin global policy */}
      {data.isAdmin && (
        <AdminPolicyCard
          initial={data.globalSettings}
          isPending={isPending}
          onSave={(formData) => run(() => updateGlobalSecuritySettings(formData))}
        />
      )}

      {/* Sign-up policy (admin only) */}
      {data.isAdmin && (
        <SignupPolicyCard
          initial={data.autoAcceptSignups}
          isPending={isPending}
          onSave={(formData) => run(() => updateAutoAcceptSignups(formData))}
        />
      )}
    </>
  );
}

/**
 * Shown when no SMTP transport resolves. Without one the email factor is a dead end — the
 * code is minted and the panel claims success, but nothing is ever delivered — so the tile
 * is disabled and this points at the fix instead.
 */
function SmtpRequiredNotice({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Alert variant="warning" id="smtp-required-notice">
      <MailWarning className="h-4 w-4" />
      <AlertTitle>Email codes need an SMTP server</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          This site has no outgoing mail server configured, so a verification code cannot
          reach your inbox. Use an authenticator app instead, or set up SMTP first.
        </p>
        {isAdmin ? (
          <Link
            href="/cms/settings/email"
            className="inline-flex items-center font-medium underline underline-offset-4"
          >
            Configure email (SMTP) →
          </Link>
        ) : (
          <p className="font-medium">
            Ask an administrator to configure it under Settings → Email.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function SignupPolicyCard({
  initial,
  isPending,
  onSave,
}: {
  initial: boolean;
  isPending: boolean;
  onSave: (formData: FormData) => void;
}) {
  const [enabled, setEnabled] = useState(initial);
  // Read-only on the sandbox, whose admin login is public (updateAutoAcceptSignups refuses
  // there). The security page shows a notice instead of this panel on the sandbox today; the
  // card stays honest if it is ever rendered there.
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-up Policy (Admin)</CardTitle>
        <CardDescription>
          Controls how new public registrations are handled across the whole site.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData();
            formData.append('auto_accept_signups', String(enabled));
            onSave(formData);
          }}
          className="space-y-6"
        >
          <div className="flex items-start gap-3">
            <Checkbox
              id="auto_accept_signups"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
              disabled={isSandbox}
              aria-describedby={isSandbox ? 'auto_accept_signups_sandbox_note' : undefined}
              className="mt-1"
            />
            <div className="space-y-1">
              <Label htmlFor="auto_accept_signups">
                Auto-approve registrations (skip outbound email verification)
              </Label>
              <p className="text-xs text-slate-500">
                New accounts become active immediately, even without SMTP configured. Convenient
                for local / self-hosted use; leave off for public production sites.
              </p>
              {isSandbox ? (
                <p id="auto_accept_signups_sandbox_note" className="text-xs text-slate-500">
                  Sign-up settings are disabled in the sandbox.
                </p>
              ) : null}
            </div>
          </div>

          <Separator />

          <Button type="submit" disabled={isPending || isSandbox}>
            {isPending ? <Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Policy
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AdminPolicyCard({
  initial,
  isPending,
  onSave,
}: {
  initial: SecurityPanelData['globalSettings'];
  isPending: boolean;
  onSave: (formData: FormData) => void;
}) {
  const [days, setDays] = useState(String(initial.trusted_device_days));
  const [enforce, setEnforce] = useState(initial.enforce_staff_2fa);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Policy (Admin)</CardTitle>
        <CardDescription>
          Applies to every staff member. Trusted-device trust is server-validated and
          revocable at any time from this page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData();
            formData.append('trusted_device_days', days);
            formData.append('enforce_staff_2fa', String(enforce));
            onSave(formData);
          }}
          className="space-y-6"
        >
          <div className="space-y-2">
            <Label htmlFor="trusted_device_days">Remember-device duration (days)</Label>
            <Input
              id="trusted_device_days"
              type="number"
              min={MIN_TRUSTED_DEVICE_DAYS}
              max={MAX_TRUSTED_DEVICE_DAYS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-40"
            />
            <p className="text-xs text-slate-500">
              How long a &ldquo;Remember this device&rdquo; choice lasts before 2FA is
              required again. Default 30 days, up to {MAX_TRUSTED_DEVICE_DAYS} (10 years).
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="enforce_staff_2fa"
              checked={enforce}
              onCheckedChange={(checked) => setEnforce(checked === true)}
              className="mt-1"
            />
            <div className="space-y-1">
              <Label htmlFor="enforce_staff_2fa">Encourage staff to enable 2FA</Label>
              <p className="text-xs text-slate-500">
                Shows a reminder banner across the CMS to ADMIN/WRITER accounts that
                haven&rsquo;t set up a second factor. On by default.
              </p>
            </div>
          </div>

          <Separator />

          <Button type="submit" disabled={isPending}>
            {isPending ? <Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Policy
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
