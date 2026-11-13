'use client';

import { useRef, useState, useTransition } from 'react';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Input,
  Label,
  Spinner,
} from '@nextblock-cms/ui';
import type { EmailSettingsView } from '../../../../../lib/config/email-settings';
import { updateEmailSettings, sendTestEmail } from '../actions';
import type { Message } from '../../../../../components/form-message';
import { useHotkeys } from '../../../../../hooks/use-hotkeys';

interface EmailFormProps {
  initialSettings: EmailSettingsView;
}

/**
 * TLS mode implied by a port, or null when the port carries no convention.
 *
 * 465 is SMTPS (TLS from the first byte); 25, 587 and 2525 open in plaintext and upgrade
 * via STARTTLS. Mixing them up is the single most common SMTP misconfiguration, and it
 * surfaces as an OpenSSL "wrong version number" that names neither TLS mode nor port.
 */
function impliedSecureForPort(port: string): boolean | null {
  const value = Number(port.trim());
  if (value === 465) return true;
  if (value === 25 || value === 587 || value === 2525) return false;
  return null;
}

export default function EmailForm({ initialSettings }: EmailFormProps) {
  const [isPending, startTransition] = useTransition();
  const [isTesting, startTestTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);

  const [host, setHost] = useState(initialSettings.host);
  const [port, setPort] = useState(initialSettings.port);
  const [fromEmail, setFromEmail] = useState(initialSettings.fromEmail);
  const [fromName, setFromName] = useState(initialSettings.fromName);
  const [secure, setSecure] = useState(initialSettings.secure);

  // Surfaces a saved-but-impossible combination (e.g. an install that entered 2525 while
  // the toggle still held its default of ON).
  const impliedSecure = impliedSecureForPort(port);
  const tlsMismatch =
    impliedSecure !== null && impliedSecure !== secure ? { expected: impliedSecure } : null;
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [testTo, setTestTo] = useState('');

  const formRef = useRef<HTMLFormElement>(null);
  useHotkeys('ctrl+s', () => formRef.current?.requestSubmit());

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const formData = new FormData();
    formData.append('host', host);
    formData.append('port', port);
    formData.append('fromEmail', fromEmail);
    formData.append('fromName', fromName);
    formData.append('secure', secure ? 'on' : '');
    // Only send credentials when changed — blank keeps the stored secret.
    if (user.trim()) formData.append('user', user.trim());
    if (pass.trim()) formData.append('pass', pass.trim());

    startTransition(async () => {
      try {
        const result = await updateEmailSettings(formData);
        if (!result.ok) {
          setMessage({ error: result.error });
          return;
        }
        setMessage({ success: result.message });
        setUser('');
        setPass('');
      } catch (error) {
        setMessage({ error: error instanceof Error ? error.message : 'Failed to save settings.' });
      }
    });
  };

  const handleSendTest = () => {
    setMessage(null);
    const formData = new FormData();
    formData.append('to', testTo.trim());
    startTestTransition(async () => {
      try {
        const result = await sendTestEmail(formData);
        setMessage(result.ok ? { success: result.message } : { error: result.error });
      } catch (error) {
        setMessage({ error: error instanceof Error ? error.message : 'Failed to send test email.' });
      }
    });
  };

  const readOnly = initialSettings.readOnly;

  return (
    <div className="space-y-6">
      {readOnly && (
        <Alert className="py-2 px-4">
          <AlertDescription className="text-xs">
            Email settings are read-only in this demo. It sends mail only through the
            deployment&rsquo;s <code>SMTP_*</code> environment, and test emails are off.
          </AlertDescription>
        </Alert>
      )}
      {initialSettings.envFallbackActive && (
        <Alert className="py-2 px-4">
          <AlertDescription className="text-xs">
            SMTP is currently read from environment variables (<code>SMTP_*</code>). What you save
            here takes precedence, except that mail keeps going to <code>SMTP_HOST</code> until a
            username and password are saved here too (another host saved here then drops its port
            and TLS setting). With no host saved here, the TLS mode follows the port, and a port
            other than <code>SMTP_PORT</code> (else 587) must use TLS.
          </AlertDescription>
        </Alert>
      )}
      {initialSettings.hostPinnedToEnv && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          The username and password still come from <code>SMTP_USER</code> /{' '}
          <code>SMTP_PASS</code>, so mail goes to <code>SMTP_HOST</code> and the host, port and TLS
          setting below are not used (the port comes from <code>SMTP_PORT</code>, else 587). Save a
          username and password here to send through them.
        </p>
      )}

      <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
        <fieldset disabled={readOnly} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="host">SMTP host</Label>
              <Input id="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                value={port}
                onChange={(e) => {
                  const next = e.target.value;
                  setPort(next);
                  // The TLS mode is a property of the port, not a preference. Follow it, so
                  // the impossible combination is never saved in the first place.
                  const implied = impliedSecureForPort(next);
                  if (implied !== null) setSecure(implied);
                }}
                placeholder="465"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fromEmail">From email</Label>
              <Input id="fromEmail" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="no-reply@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fromName">From name</Label>
              <Input id="fromName" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="My Site" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user">
                Username{' '}
                {initialSettings.hasUser && (
                  <span className="text-xs text-muted-foreground">
                    (stored{initialSettings.userLast4 ? ` ••••${initialSettings.userLast4}` : ''} — leave blank to keep)
                  </span>
                )}
              </Label>
              <Input id="user" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} placeholder={initialSettings.hasUser ? '••••••••' : 'smtp username'} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pass">
                Password{' '}
                {initialSettings.hasPass && (
                  <span className="text-xs text-muted-foreground">(stored — leave blank to keep)</span>
                )}
              </Label>
              <Input id="pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={initialSettings.hasPass ? '••••••••' : 'smtp password'} />
            </div>
          </div>

          <label className="flex items-start gap-3">
            <Checkbox checked={secure} onCheckedChange={(c) => setSecure(c === true)} className="mt-1" />
            <span className="text-sm">
              <span className="font-medium">Use implicit TLS (SMTPS)</span>
              <span className="block text-xs text-muted-foreground">
                Port 465 needs this on. Ports 25, 587 and 2525 need it off — they upgrade to
                TLS with STARTTLS instead.
              </span>
            </span>
          </label>

          {tlsMismatch && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              Port {port} expects implicit TLS to be{' '}
              <strong>{tlsMismatch.expected ? 'on' : 'off'}</strong>. Mail is sent that way
              whatever this switch says; switch it {tlsMismatch.expected ? 'on' : 'off'} and save
              to match.
            </p>
          )}

          <div className="flex items-center gap-4">
            <Button type="submit" disabled={isPending || readOnly}>
              {isPending ? (<><Spinner className="mr-2 h-4 w-4" /> Saving…</>) : 'Save settings'}
            </Button>
          </div>
        </fieldset>
      </form>

      <div className="rounded-lg border p-4 space-y-3">
        <div className="space-y-1">
          <Label htmlFor="testTo">Send a test email</Label>
          <p className="text-xs text-muted-foreground">
            Save your settings first, then send a test message to confirm delivery.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input
            id="testTo"
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
            className="sm:max-w-xs"
          />
          <Button type="button" variant="outline" onClick={handleSendTest} disabled={isTesting || !testTo.trim() || readOnly}>
            {isTesting ? (<><Spinner className="mr-2 h-4 w-4" /> Sending…</>) : 'Send test email'}
          </Button>
        </div>
      </div>

      {message && (
        <Alert variant={'error' in message ? 'destructive' : 'success'} className="py-2 px-4">
          <AlertDescription>
            {'error' in message
              ? message.error
              : 'success' in message
                ? message.success
                : message.message}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
