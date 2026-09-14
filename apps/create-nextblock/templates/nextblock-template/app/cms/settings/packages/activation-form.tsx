'use client';

import { useState } from 'react';
import { activatePackage } from '../../../actions/package-actions';
import { toast } from 'sonner';
import { Button } from '@nextblock-cms/ui';
import { Input } from '@nextblock-cms/ui';
import { Loader2, FlaskConical } from 'lucide-react';

const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

export function ActivationForm() {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleActivate = async () => {
    if (!key) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await activatePackage(key);
      if ('error' in res) {
        toast.error(res.error);
        setErrorMsg(res.error);
      } else {
        toast.success(`Package "${res.package}" activated successfully!`);
        setKey('');
        setErrorMsg(null);
      }
    } catch {
      toast.error('Activation failed. Please try again.');
      setErrorMsg('Activation failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (isSandbox) {
    return (
      <div className="mt-8 p-6 border rounded-lg bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
        <div className="flex items-center gap-2 mb-2">
          <FlaskConical className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          <h3 className="text-lg font-medium text-amber-800 dark:text-amber-300">Sandbox Environment</h3>
        </div>
        <p className="text-sm text-amber-700 dark:text-amber-400">
          License activation is disabled in this sandbox demo. To purchase a real license for
          your self-hosted instance, visit{' '}
          <a href="https://nextblock.dev" target="_blank" rel="noopener noreferrer" className="underline font-semibold">
            nextblock.dev
          </a>.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8 p-6 border rounded-lg bg-card">
      <h3 className="text-lg font-medium mb-4">Activate a Package</h3>
      <div className="flex items-start gap-4">
        <div className="flex flex-col gap-2 flex-1 max-w-md">
          <Input 
            placeholder="Enter your Freemius License Key"
            value={key}
            onChange={(e) => {
                setKey(e.target.value);
                setErrorMsg(null);
            }}
          />
          {errorMsg && (
            <p className="text-sm font-medium text-destructive">{errorMsg}</p>
          )}
        </div>
        <Button onClick={handleActivate} disabled={loading || !key}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Activate License
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mt-2">
        Enter the license key you received from Freemius to unlock the package features.
      </p>
    </div>
  );
}
