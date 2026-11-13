'use client';

import { useState, useTransition, useRef } from 'react';
import { Label } from '@nextblock-cms/ui';
import { Input } from '@nextblock-cms/ui';
import { Button } from '@nextblock-cms/ui';
import { Alert, AlertDescription, Spinner } from '@nextblock-cms/ui';
import { Message } from '../../../../../components/form-message';
import { useHotkeys } from '../../../../../hooks/use-hotkeys';
import { BotProtectionSettings, updateBotProtectionSettings } from '../actions';
import { SANDBOX_SECRET_NOTE_ID, SANDBOX_SECRET_REFUSED } from '../sandbox';

interface BotProtectionFormProps {
  initialSettings: BotProtectionSettings;
}

export default function BotProtectionForm({ initialSettings }: BotProtectionFormProps) {
  // The public sandbox stores no captcha secret and never shows the stored one, so its secret
  // field stays empty: disabled and optional there (required would block every provider or site
  // key save), beside the reason. Read inline, as SandboxCredentialsAlert does.
  const sandboxLocked = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);
  
  const [provider, setProvider] = useState<'none' | 'turnstile' | 'recaptcha'>(initialSettings.provider);
  const [siteKey, setSiteKey] = useState<string>(initialSettings.siteKey);
  const [secretKey, setSecretKey] = useState<string>(initialSettings.secretKey || '');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);

    const formData = new FormData();
    formData.append('provider', provider);
    formData.append('siteKey', siteKey);
    formData.append('secretKey', secretKey);

    startTransition(async () => {
      try {
        const result = await updateBotProtectionSettings(formData);
        setMessage(result.ok ? { success: result.message } : { error: result.error });
      } catch (error) {
        setMessage({ error: error instanceof Error ? error.message : 'An unknown error occurred.' });
      }
    });
  };

  const formRef = useRef<HTMLFormElement>(null);
  useHotkeys('ctrl+s', () => formRef.current?.requestSubmit());

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="provider">Protection Provider</Label>
          <select
            id="provider"
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as any)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="none">None (Honeypot Only)</option>
            <option value="turnstile">Cloudflare Turnstile (Recommended)</option>
            <option value="recaptcha">Google reCAPTCHA v3</option>
          </select>
          <p className="text-xs text-slate-500">
            NextBlock always renders a hidden Honeypot field in form blocks by default. Setting a provider adds an additional cryptographic verification layer.
          </p>
        </div>

        {provider !== 'none' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="siteKey">
                {provider === 'turnstile' ? 'Turnstile Site Key' : 'reCAPTCHA Site Key'}
              </Label>
              <Input
                id="siteKey"
                name="siteKey"
                value={siteKey}
                onChange={(e) => setSiteKey(e.target.value)}
                placeholder={provider === 'turnstile' ? 'e.g., 0x4AAAAAAAB...' : 'e.g., 6LdGP...'}
                required
              />
              <p className="text-xs text-slate-500">
                The public key used to initialize the widget or API script on the client side.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="secretKey">
                {provider === 'turnstile' ? 'Turnstile Secret Key' : 'reCAPTCHA Secret Key'}
              </Label>
              <Input
                id="secretKey"
                name="secretKey"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="••••••••••••••••••••••••••••••••"
                required={!sandboxLocked}
                disabled={sandboxLocked}
                aria-describedby={sandboxLocked ? SANDBOX_SECRET_NOTE_ID : undefined}
              />
              <p className="text-xs text-slate-500">
                The private key used to sign server-to-server validation requests. Stored securely on the server.
              </p>
              {sandboxLocked && (
                <p id={SANDBOX_SECRET_NOTE_ID} className="text-xs text-slate-500">
                  {SANDBOX_SECRET_REFUSED}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <>
              <Spinner className="mr-2 h-4 w-4 animate-spin" /> Saving...
            </>
          ) : (
            'Save Settings'
          )}
        </Button>
        {message && (
          <Alert variant={'success' in message ? 'success' : 'destructive'} className="py-2 px-4 w-auto inline-flex items-center">
             <AlertDescription>{'success' in message ? (message as any).success : (message as any).error}</AlertDescription>
          </Alert>
        )}
      </div>
    </form>
  );
}
