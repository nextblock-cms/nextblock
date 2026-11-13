'use client';

/**
 * The link and image-description dialogs of the storefront editor. Both validate before they
 * apply anything: a link must pass `sanitizeStorefrontHref()` (through
 * `normalizeStorefrontLinkInput`), an alt text is one line of at most 250 characters.
 */
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@nextblock-cms/ui';
import { useId, useRef, useState, type FormEvent } from 'react';

import type { AffiliatesCopyTranslate } from '../i18n/types';
import { STOREFRONT_LIMITS } from '../storefront/limits';
import { normalizeStorefrontLinkInput } from './commands';

export interface StorefrontLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: AffiliatesCopyTranslate;
  /** The address of the link being edited ('' for a new link). */
  initialHref: string;
  /** The cursor is on an existing link (shows "Remove link"). */
  editing: boolean;
  onApply: (href: string) => void;
  onRemove: () => void;
  /** Where focus goes when the dialog closes (default: back to the control that opened it). */
  returnFocus?: () => void;
}

/** `onCloseAutoFocus` for a dialog that hands focus back to the editor instead of its trigger. */
function closeAutoFocus(returnFocus: (() => void) | undefined) {
  return returnFocus
    ? (event: Event) => {
        event.preventDefault();
        returnFocus();
      }
    : undefined;
}

function LinkDialogBody({
  onOpenChange,
  t,
  initialHref,
  editing,
  onApply,
  onRemove,
}: Omit<StorefrontLinkDialogProps, 'open' | 'returnFocus'>) {
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initialHref);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (value.trim() === '') {
      setError(t('affiliates.editor.link_error_empty'));
      inputRef.current?.focus();
      return;
    }
    const href = normalizeStorefrontLinkInput(value);
    if (href === null) {
      setError(t('affiliates.editor.link_error_invalid'));
      inputRef.current?.focus();
      return;
    }
    onApply(href);
    onOpenChange(false);
  };

  const inputId = `${baseId}-url`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  return (
    <form className="space-y-4" noValidate onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {editing ? t('affiliates.editor.link_dialog_title_edit') : t('affiliates.editor.link_dialog_title_add')}
        </DialogTitle>
        <DialogDescription>{t('affiliates.editor.link_dialog_description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t('affiliates.editor.link_url_label')}</Label>
        <Input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          maxLength={STOREFRONT_LIMITS.maxHrefLength}
          value={value}
          placeholder={t('affiliates.editor.link_url_placeholder')}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${errorId} ${hintId}` : hintId}
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) setError(null);
          }}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('affiliates.editor.link_url_hint')}
        </p>
        {error !== null ? (
          <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter className="gap-2">
        {editing ? (
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            onClick={() => {
              onRemove();
              onOpenChange(false);
            }}
          >
            {t('affiliates.editor.link_remove')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t('affiliates.editor.cancel')}
        </Button>
        <Button type="submit">{t('affiliates.editor.link_apply')}</Button>
      </DialogFooter>
    </form>
  );
}

/** Add / edit / remove a link. */
export function StorefrontLinkDialog({ open, returnFocus, ...rest }: StorefrontLinkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={rest.onOpenChange}>
      <DialogContent className="max-w-md" onCloseAutoFocus={closeAutoFocus(returnFocus)}>
        <LinkDialogBody {...rest} />
      </DialogContent>
    </Dialog>
  );
}

export interface StorefrontImageAltDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: AffiliatesCopyTranslate;
  initialAlt: string;
  onSave: (alt: string) => void;
  /** Where focus goes when the dialog closes (default: back to the control that opened it). */
  returnFocus?: () => void;
}

function ImageAltDialogBody({
  onOpenChange,
  t,
  initialAlt,
  onSave,
}: Omit<StorefrontImageAltDialogProps, 'open' | 'returnFocus'>) {
  const baseId = useId();
  const [value, setValue] = useState(initialAlt);
  const inputId = `${baseId}-alt`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSave(value);
    onOpenChange(false);
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t('affiliates.editor.image_alt_dialog_title')}</DialogTitle>
        <DialogDescription>{t('affiliates.editor.image_alt_dialog_description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t('affiliates.editor.image_description')}</Label>
        <Input
          id={inputId}
          type="text"
          maxLength={STOREFRONT_LIMITS.maxAltLength}
          value={value}
          placeholder={t('affiliates.editor.image_alt_placeholder')}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t('affiliates.editor.skip')}
        </Button>
        <Button type="submit">{t('affiliates.editor.save')}</Button>
      </DialogFooter>
    </form>
  );
}

/** Edit the description (alt text) of an image. */
export function StorefrontImageAltDialog({ open, returnFocus, ...rest }: StorefrontImageAltDialogProps) {
  return (
    <Dialog open={open} onOpenChange={rest.onOpenChange}>
      <DialogContent className="max-w-md" onCloseAutoFocus={closeAutoFocus(returnFocus)}>
        <ImageAltDialogBody {...rest} />
      </DialogContent>
    </Dialog>
  );
}
