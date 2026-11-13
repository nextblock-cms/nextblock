'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { toast } from 'sonner';

const DEFAULT_FAILURE_MESSAGE = 'Copy failed. Select the text and copy it by hand.';

/**
 * Copy a value (a URL, a command) to the clipboard, announcing the result. The default failure
 * hint assumes the value is printed beside the button; pass `failureMessage` where it is not.
 */
export function CopyTextButton({
  value,
  label,
  failureMessage = DEFAULT_FAILURE_MESSAGE,
}: {
  value: string;
  label: string;
  failureMessage?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-8 shrink-0"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success('Copied to the clipboard.');
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error(failureMessage);
        }
      }}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
