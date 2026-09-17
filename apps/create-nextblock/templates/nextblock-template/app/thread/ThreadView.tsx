'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@nextblock-cms/ui';
import { Textarea } from '@nextblock-cms/ui';
import { useTranslations } from '@nextblock-cms/utils';
import { CheckCircle2, Loader2, Send } from 'lucide-react';

import { AuthBotProtection } from '../../components/auth/AuthBotProtection';
import { submitThreadReply, type ThreadReplyState } from '../actions/threadActions';

export interface ThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  author_name: string | null;
  created_at: string;
}

interface ThreadViewProps {
  invalid?: boolean;
  subjectLabel?: string;
  closed?: boolean;
  messages?: ThreadMessage[];
  botProtectionProvider?: 'none' | 'turnstile' | 'recaptcha';
  botProtectionSiteKey?: string;
  scriptNonce?: string;
}

const INITIAL_STATE: ThreadReplyState = { success: false, messageKey: '' };

// `t()` returns the key itself when a translation row is missing, so every string
// carries the English literal it should fall back to.
const FALLBACKS: Record<string, string> = {
  'thread.heading': 'Your conversation',
  'thread.reply_label': 'Write a reply',
  'thread.send': 'Send reply',
  'thread.sending': 'Sending…',
  'thread.sent': 'Thanks - your reply has been sent.',
  'thread.error': "Sorry, your reply couldn't be sent. Please try again in a moment.",
  'thread.throttled': "You've sent several replies already. Please wait a few minutes.",
  'thread.closed': 'This conversation has been closed.',
  'thread.invalid':
    'This link has expired or is no longer valid. If you still need help, please contact us again from our website.',
  'thread.you': 'You',
};

function SendButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="min-w-[140px]">
      {pending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        <>
          <Send className="mr-2 h-4 w-4" />
          {label}
        </>
      )}
    </Button>
  );
}

export default function ThreadView({
  invalid = false,
  subjectLabel,
  closed = false,
  messages = [],
  botProtectionProvider = 'none',
  botProtectionSiteKey = '',
  scriptNonce,
}: ThreadViewProps) {
  const { t } = useTranslations();
  const [state, formAction] = useActionState(submitThreadReply, INITIAL_STATE);

  const label = (key: string): string => {
    const value = t(key);
    return value === key ? (FALLBACKS[key] ?? key) : value;
  };

  // One page for every failure: expired, revoked, and never-existed are indistinguishable
  // on purpose, so this page cannot be used to probe for valid threads.
  if (invalid) {
    return (
      <div className="rounded-2xl border border-border/80 bg-card/50 p-6 text-center">
        <p className="text-sm text-muted-foreground">{label('thread.invalid')}</p>
      </div>
    );
  }

  const errorText = state.message || (!state.success && state.messageKey ? label(state.messageKey) : null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">{label('thread.heading')}</h1>
        {subjectLabel && <p className="text-sm text-muted-foreground">{subjectLabel}</p>}
      </header>

      <ol className="space-y-4">
        {messages.map((message) => {
          const fromVisitor = message.direction === 'inbound';
          return (
            <li
              key={message.id}
              className={`rounded-2xl border p-4 ${
                fromVisitor
                  ? 'border-border/80 bg-card/50'
                  : 'border-primary/30 bg-primary/5'
              }`}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {fromVisitor ? label('thread.you') : message.author_name || 'Support'}
                </span>
                <time className="text-xs text-muted-foreground" suppressHydrationWarning>
                  {new Date(message.created_at).toLocaleString()}
                </time>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">{message.body}</p>
            </li>
          );
        })}
      </ol>

      {state.success ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-sm text-emerald-900 dark:text-emerald-200">{label('thread.sent')}</p>
        </div>
      ) : closed ? (
        <p className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          {label('thread.closed')}
        </p>
      ) : (
        <form action={formAction} className="space-y-3 rounded-2xl border border-border/80 bg-card/50 p-4">
          <label
            htmlFor="thread-reply"
            className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {label('thread.reply_label')}
          </label>
          <Textarea id="thread-reply" name="body" required maxLength={5000} className="min-h-[120px]" />

          <AuthBotProtection
            provider={botProtectionProvider}
            siteKey={botProtectionSiteKey}
            scriptNonce={scriptNonce}
          />

          {errorText && (
            <p role="alert" className="text-sm font-semibold text-destructive">
              {errorText}
            </p>
          )}

          <div className="flex justify-end">
            <SendButton label={label('thread.send')} pendingLabel={label('thread.sending')} />
          </div>
        </form>
      )}
    </div>
  );
}
