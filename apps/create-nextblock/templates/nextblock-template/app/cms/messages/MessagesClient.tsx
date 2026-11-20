'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@nextblock-cms/ui';
import { Input } from '@nextblock-cms/ui';
import { Textarea } from '@nextblock-cms/ui';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Copy,
  Eye,
  EyeOff,
  Inbox,
  Link2Off,
  Loader2,
  Mail,
  MailWarning,
  RefreshCw,
  Send,
  Star,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { LocalDateTime } from '../../../components/LocalDateTime';
import { saveStoreContactEmail } from '../inquiries/actions';
import {
  createVisitorLink,
  markThreadRead,
  replyToThread,
  retryThreadDelivery,
  revokeThreadLink,
  setThreadStatus,
} from './actions';
import { replyToInteraction, updateInteractionStatus } from '../../actions/interactions';
import type { InboxItem, InboxPage } from './loadInbox';
import type { ThreadDetail } from './loadInbox';

const SOURCE_TABS: Array<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'product_inquiry', label: 'Product enquiries' },
  { key: 'contact_form', label: 'Contact forms' },
  { key: 'review', label: 'Reviews' },
  { key: 'comment', label: 'Comments' },
];

const SOURCE_LABELS: Record<string, string> = {
  sandbox: 'the sandbox override',
  store_contact: 'the address set below',
  invoice: 'your invoice email',
  privacy: 'your support email',
  first_admin: "the first admin's login email",
  none: 'nowhere — no address could be resolved',
};

interface MessagesClientProps {
  inbox: InboxPage;
  openThread: ThreadDetail | null;
  isAdmin: boolean;
  activeSource: string;
  showHandled: boolean;
  storeContactEmail: string;
  resolvedFallback: { email: string | null; source: string };
  smtpConfigured: boolean;
}

/** Keeps the source filter and the handled toggle independent in the URL. */
function buildHref({ source, handled }: { source: string; handled: boolean }): string {
  const query = new URLSearchParams();
  if (source) query.set('source', source);
  if (handled) query.set('handled', '1');
  const search = query.toString();
  return search ? `/cms/messages?${search}` : '/cms/messages';
}

function SaveButton({ label = 'Save' }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {label}
    </Button>
  );
}

export default function MessagesClient({
  inbox,
  openThread,
  isAdmin,
  activeSource,
  showHandled,
  storeContactEmail,
  resolvedFallback,
  smtpConfigured,
}: MessagesClientProps) {
  const router = useRouter();
  const [settingsState, settingsAction] = useActionState(saveStoreContactEmail, {
    success: false,
    message: '',
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [, startTransition] = useTransition();

  // Switching conversations must not carry the draft across. Without this, a half-typed
  // reply to one visitor stays in the box when the admin opens another thread — and the
  // next Send delivers it to the wrong person.
  useEffect(() => {
    setReplyBody('');
  }, [openThread?.id]);

  const run = (id: string, work: () => Promise<{ success: boolean; message: string }>) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await work();
      setBusyId(null);
      if (result.success) {
        if (result.message) toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message || 'Something went wrong.');
      }
    });
  };

  const openThreadPane = (item: InboxItem) => {
    const query = new URLSearchParams();
    if (activeSource) query.set('source', activeSource);
    if (showHandled) query.set('handled', '1');
    query.set('thread', item.id);
    router.push(`/cms/messages?${query.toString()}`);
    if (item.unread) void markThreadRead(item.id);
  };

  return (
    <div className="space-y-6">
      {/* Source tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {SOURCE_TABS.map((tab) => {
          const count =
            tab.key && tab.key in inbox.counts
              ? inbox.counts[tab.key as keyof typeof inbox.counts]
              : 0;
          const isActive = activeSource === tab.key;
          return (
            <Link
              key={tab.key || 'all'}
              href={buildHref({ source: tab.key, handled: showHandled })}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                isActive
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
              {count > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-bold text-amber-700 dark:text-amber-400">
                  {count}
                </span>
              )}
            </Link>
          );
        })}

        {/* Handled items are hidden by default: the inbox is a to-do list, and a closed
            conversation has nothing left to do in it. */}
        <Link
          href={buildHref({ source: activeSource, handled: !showHandled })}
          className={`ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
            showHandled
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {showHandled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {showHandled ? 'Hiding nothing' : 'Show handled'}
          {!showHandled && inbox.handledCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold text-muted-foreground">
              {inbox.handledCount}
            </span>
          )}
        </Link>
      </div>

      {inbox.privateHidden && (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          Product enquiries and contact-form messages contain personal information and are
          visible to admins only. You are seeing reviews and comments.
        </p>
      )}

      {isAdmin && !smtpConfigured && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            Email sending isn&rsquo;t configured, so nobody is notified when a message
            arrives and replies can&rsquo;t reach the sender — but everything is still
            recorded here. Set up SMTP in CMS Settings → Configuration → Email.
          </span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* List */}
        <section className="space-y-3">
          {inbox.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <Inbox className="mx-auto h-8 w-8 text-muted-foreground" />
              <h3 className="mt-3 text-sm font-semibold">Nothing here yet</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {inbox.handledCount > 0 && !showHandled
                  ? `Nothing needs your attention. ${inbox.handledCount} handled ${
                      inbox.handledCount === 1 ? 'item is' : 'items are'
                    } hidden.`
                  : activeSource
                    ? 'No messages in this category.'
                    : 'Messages from your site will appear here.'}
              </p>
            </div>
          ) : (
            inbox.items.map((item) => (
              <article
                key={`${item.kind}-${item.id}`}
                className={`rounded-lg border bg-card p-4 ${
                  openThread?.id === item.id ? 'border-primary' : 'border-border'
                } ${item.unread ? '' : 'opacity-80'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      {item.unread && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-label="Unread" />
                      )}
                      {item.subjectLabel}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.senderName || 'Anonymous'}
                      {item.senderEmail ? ` · ${item.senderEmail}` : ''} ·{' '}
                      <LocalDateTime value={item.lastActivityAt} />
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.rating !== null && (
                      <span className="flex items-center gap-0.5 text-xs text-amber-500">
                        <Star className="h-3.5 w-3.5 fill-amber-500" />
                        {item.rating}
                      </span>
                    )}
                    {item.emailDelivered === false && (
                      <span
                        className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                        title="No notification was sent — this page is the only record"
                      >
                        <MailWarning className="h-3.5 w-3.5" />
                        Not emailed
                      </span>
                    )}
                    {item.emailDelivered === true && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Mail className="h-3.5 w-3.5" />
                        Emailed
                      </span>
                    )}
                    {item.targetHref && (
                      <a
                        href={item.targetHref}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="View on the site"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-sm">{item.preview}</p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {item.kind === 'thread' ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => openThreadPane(item)}>
                        {openThread?.id === item.id ? 'Open' : 'Read & reply'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === item.id}
                        onClick={() =>
                          run(item.id, () =>
                            setThreadStatus(item.id, item.status === 'closed' ? 'open' : 'closed')
                          )
                        }
                      >
                        {busyId === item.id ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                        )}
                        {item.status === 'closed' ? 'Reopen' : 'Mark handled'}
                      </Button>
                    </>
                  ) : (
                    isAdmin && (
                      <>
                        {item.status !== 'approved' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === item.id}
                            onClick={() =>
                              run(item.id, async () => {
                                const result = await updateInteractionStatus(item.id, 'approved');
                                return result.error
                                  ? { success: false, message: result.error }
                                  : { success: true, message: 'Published.' };
                              })
                            }
                          >
                            Approve
                          </Button>
                        )}
                        {item.status !== 'denied' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === item.id}
                            onClick={() =>
                              run(item.id, async () => {
                                const result = await updateInteractionStatus(item.id, 'denied');
                                return result.error
                                  ? { success: false, message: result.error }
                                  : { success: true, message: 'Hidden from the site.' };
                              })
                            }
                          >
                            Deny
                          </Button>
                        )}
                        <PublicReplyBox
                          parentId={item.id}
                          busy={busyId === item.id}
                          onReply={(body) =>
                            run(item.id, async () => {
                              const result = await replyToInteraction(item.id, body);
                              return result.error
                                ? { success: false, message: result.error }
                                : { success: true, message: 'Reply published.' };
                            })
                          }
                        />
                      </>
                    )
                  )}
                </div>
              </article>
            ))
          )}

          {inbox.hasMore && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the most recent {inbox.items.length}. Older messages are still stored.
            </p>
          )}
        </section>

        {/* Detail pane */}
        <section className="space-y-4">
          {openThread ? (
            <div className="rounded-lg border border-border bg-card p-4">
              <header className="mb-3">
                <h2 className="text-base font-semibold">{openThread.subjectLabel}</h2>
                <p className="text-xs text-muted-foreground">
                  {openThread.senderName || 'Anonymous'}
                  {openThread.senderEmail ? ` · ${openThread.senderEmail}` : ' · no email address'}
                </p>
              </header>

              {openThread.fields.length > 0 && (
                <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-dashed p-3 text-xs">
                  {openThread.fields.map((field) => (
                    <div key={field.label} className="contents">
                      <dt className="font-semibold text-muted-foreground">{field.label}</dt>
                      <dd className="whitespace-pre-wrap break-words">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <ol className="space-y-3">
                {openThread.messages.map((message) => (
                  <li
                    key={message.id}
                    className={`rounded-lg border p-3 ${
                      message.direction === 'outbound'
                        ? 'border-primary/30 bg-primary/5'
                        : 'border-border bg-background'
                    }`}
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold">
                        {message.direction === 'outbound'
                          ? message.author_name || 'You'
                          : openThread.senderName || 'Visitor'}
                      </span>
                      <LocalDateTime className="text-[10px] text-muted-foreground" value={message.created_at} />
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{message.body}</p>
                    {/*
                      An undelivered row means one of two very different things, and
                      conflating them is what made a working reply look broken: with an
                      error recorded the send genuinely failed, without one it simply has
                      not been attempted yet (the visitor and form paths notify after the
                      response). Only the first is a failure.
                    */}
                    {message.direction === 'outbound' &&
                      !message.email_delivered &&
                      !message.email_error && (
                        <p className="mt-2 text-[11px] text-muted-foreground">Sending…</p>
                      )}

                    {message.direction === 'outbound' && !message.email_delivered && message.email_error && (
                      <div className="mt-2 space-y-1">
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                          Not delivered: {message.email_error}
                        </p>
                        {openThread.senderEmail && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={busyId === message.id}
                            onClick={() => run(message.id, () => retryThreadDelivery(message.id))}
                          >
                            {busyId === message.id ? (
                              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-1.5 h-3 w-3" />
                            )}
                            Try sending again
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>

              {!openThread.senderEmail && (
                <p className="mt-3 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                  This sender left no email address, so a reply will be recorded here but
                  cannot be delivered to them.
                </p>
              )}

              <div className="mt-4 space-y-2">
                <Textarea
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  placeholder="Write your reply…"
                  className="min-h-[110px]"
                  maxLength={5000}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    They get an email with a private link to read and reply on your site.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === openThread.id}
                      title="Copy a link to this conversation, to send however you like"
                      onClick={() =>
                        run(openThread.id, async () => {
                          const result = await createVisitorLink(openThread.id);
                          if (result.success && result.url) {
                            try {
                              await navigator.clipboard.writeText(result.url);
                            } catch {
                              // Clipboard blocked (insecure origin, denied permission):
                              // show the link so it can still be copied by hand.
                              window.prompt('Copy this link for the visitor:', result.url);
                            }
                          }
                          return result;
                        })
                      }
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      Copy visitor link
                    </Button>
                    {openThread.hasLiveLink && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === openThread.id}
                        onClick={() => run(openThread.id, () => revokeThreadLink(openThread.id))}
                        title="Invalidate the link you already sent"
                      >
                        <Link2Off className="mr-2 h-3.5 w-3.5" />
                        Revoke link
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={busyId === openThread.id || !replyBody.trim()}
                      onClick={() =>
                        run(openThread.id, async () => {
                          const result = await replyToThread(openThread.id, replyBody);
                          if (result.success) setReplyBody('');
                          return result;
                        })
                      }
                    >
                      {busyId === openThread.id ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="mr-2 h-3.5 w-3.5" />
                      )}
                      Send reply
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            isAdmin && (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Choose a conversation to read the full history and reply.
              </div>
            )
          )}

          {/* Where enquiries go */}
          {isAdmin && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Where messages are sent</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                <strong>Every form on your site sends here by default</strong> — product
                enquiries and contact forms alike. Leave it blank and notifications go to
                the first admin account. An individual form can still be pointed somewhere
                else in its block settings.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Visitors never see this address: forms post to your server, which looks up
                where to deliver. Messages are recorded here either way.
              </p>

              <form action={settingsAction} className="mt-3 flex flex-wrap items-end gap-3">
                <div className="min-w-[220px] flex-1 space-y-1.5">
                  <label
                    htmlFor="contact_email"
                    className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Contact email
                  </label>
                  <Input
                    id="contact_email"
                    name="contact_email"
                    type="email"
                    defaultValue={storeContactEmail}
                    placeholder="sales@yourcompany.com"
                  />
                </div>
                <SaveButton />
              </form>

              {settingsState.message && (
                <p
                  className={`mt-2 text-xs ${
                    settingsState.success ? 'text-emerald-600' : 'text-destructive'
                  }`}
                >
                  {settingsState.message}
                </p>
              )}

              {!storeContactEmail && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Nothing set, so messages currently go to{' '}
                  <strong>
                    {SOURCE_LABELS[resolvedFallback.source] ?? resolvedFallback.source}
                  </strong>
                  {resolvedFallback.source === 'none'
                    ? '. Set an address so notifications reach someone.'
                    : '. That works — set an address above to send them somewhere else.'}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * A staff answer published under a review or comment. Kept visually distinct from the
 * private reply box, and labelled, because this one appears on the public site.
 */
function PublicReplyBox({
  parentId,
  busy,
  onReply,
}: {
  parentId: string;
  busy: boolean;
  onReply: (body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Reply publicly
      </Button>
    );
  }

  return (
    <div className="mt-2 w-full space-y-2 rounded-md border border-dashed p-3">
      <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
        This reply will be published on your site, under the original.
      </p>
      <Textarea
        id={`reply-${parentId}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write a public reply…"
        className="min-h-[80px]"
        maxLength={5000}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !body.trim()}
          onClick={() => {
            onReply(body);
            setBody('');
            setOpen(false);
          }}
        >
          {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Publish reply
        </Button>
      </div>
    </div>
  );
}
