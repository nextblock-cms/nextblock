'use client';

import { useRef, useState, useTransition } from 'react';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Spinner,
  Textarea,
} from '@nextblock-cms/ui';
import { Message } from '../../../../../components/form-message';
import { useHotkeys } from '../../../../../hooks/use-hotkeys';
import {
  updateGoogleAnalyticsSettings,
  type GoogleAnalyticsSettings,
} from '../actions';
import { SITE_SCRIPTS_SANDBOX_MESSAGE } from '../../site-scripts/sandbox-lock';

interface GoogleAnalyticsFormProps {
  initialSettings: GoogleAnalyticsSettings;
}

const SANDBOX_NOTE_ID = 'google-analytics-sandbox-note';

export default function GoogleAnalyticsForm({ initialSettings }: GoogleAnalyticsFormProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);
  // Read-only on the sandbox, whose admin login is public (updateGoogleAnalyticsSettings refuses there).
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  const [gtmId, setGtmId] = useState(initialSettings.gtm_id);
  const [gaId, setGaId] = useState(initialSettings.ga_measurement_id);
  const [customScripts, setCustomScripts] = useState(initialSettings.custom_scripts);

  const formRef = useRef<HTMLFormElement>(null);
  useHotkeys('ctrl+s', () => formRef.current?.requestSubmit());

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);

    const formData = new FormData();
    formData.append('gtm_id', gtmId);
    formData.append('ga_measurement_id', gaId);
    formData.append('custom_scripts', customScripts);

    startTransition(async () => {
      try {
        const result = await updateGoogleAnalyticsSettings(formData);
        setMessage(result.ok ? { success: result.message } : { error: result.error });
      } catch (error) {
        setMessage({
          error: error instanceof Error ? error.message : 'An unknown error occurred.',
        });
      }
    });
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-8">
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Analytics &amp; tracking</h3>
          <p className="text-xs text-slate-500">
            These load <strong>only</strong> after a visitor consents to analytics in the
            Law 25 banner (managed under Privacy &amp; Consent), so the default page weight
            stays at zero tracking bytes.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="gtm_id">Google Tag Manager ID</Label>
          <Input
            id="gtm_id"
            value={gtmId}
            onChange={(e) => setGtmId(e.target.value)}
            placeholder="GTM-XXXXXXX"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ga_measurement_id">GA4 Measurement ID</Label>
          <Input
            id="ga_measurement_id"
            value={gaId}
            onChange={(e) => setGaId(e.target.value)}
            placeholder="G-XXXXXXXXXX"
          />
          <p className="text-xs text-slate-500">
            Loads Google Analytics 4 directly via <code>gtag</code>. If you also configure
            GA4 inside your GTM container, set only one of these to avoid double-counting.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="custom_scripts">Custom consented scripts (optional)</Label>
          <Textarea
            id="custom_scripts"
            value={customScripts}
            onChange={(e) => setCustomScripts(e.target.value)}
            placeholder="<!-- Additional marketing/analytics <script> tags, injected only after consent -->"
            rows={4}
            className="font-mono text-xs"
          />
        </div>
      </section>

      {isSandbox ? (
        <p id={SANDBOX_NOTE_ID} className="text-sm text-muted-foreground">
          {SITE_SCRIPTS_SANDBOX_MESSAGE}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <Button
          type="submit"
          disabled={isPending || isSandbox}
          aria-describedby={isSandbox ? SANDBOX_NOTE_ID : undefined}
        >
          {isPending ? (
            <>
              <Spinner className="mr-2 h-4 w-4 animate-spin" /> Saving...
            </>
          ) : (
            'Save Google Analytics Settings'
          )}
        </Button>
        {message && (
          <Alert
            variant={'success' in message ? 'success' : 'destructive'}
            className="py-2 px-4 w-auto inline-flex items-center"
          >
            <AlertDescription>
              {'success' in message
                ? message.success
                : 'error' in message
                  ? message.error
                  : ''}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </form>
  );
}
