'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Label } from '@nextblock-cms/ui';

import { usePortalCopy } from './use-portal-copy';

type CopyState = 'idle' | 'copied' | 'manual';

/** A read-only link with a copy button; the result is announced politely. */
export function CopyField({ label, value, description }: { label: string; value: string; description?: string }) {
  const { t } = usePortalCopy();
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state !== 'copied') return undefined;
    const handle = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(handle);
  }, [state]);

  useEffect(() => {
    setState('idle');
  }, [value]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setState('manual');
    }
  };

  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className="space-y-1.5">
      <Label id={labelId} htmlFor={`${id}-input`}>
        {label}
      </Label>
      {description ? (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          ref={inputRef}
          id={`${id}-input`}
          readOnly
          value={value}
          aria-describedby={descriptionId}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-sm"
          translate="no"
        />
        <Button type="button" variant="outline" className="shrink-0" aria-describedby={labelId} onClick={() => void copy()}>
          {state === 'copied' ? t('affiliates.common.link_copied') : t('affiliates.common.copy_link')}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {state === 'copied' ? t('affiliates.common.link_copied') : state === 'manual' ? t('affiliates.portal.copy_manual') : ''}
      </p>
    </div>
  );
}
