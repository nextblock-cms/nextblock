'use client';

import { useState } from 'react';
import { Button } from '@nextblock-cms/ui';
import { Check, Copy } from 'lucide-react';

/** A ghost "Copy" button that confirms itself for a moment after the copy lands. */
export function CopyButton({
  className,
  label = 'Copy',
  value,
}: {
  className?: string;
  label?: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ?? 'h-7 shrink-0'}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** A titled, copyable code block. */
export function Snippet({ code, title }: { code: string; title: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
