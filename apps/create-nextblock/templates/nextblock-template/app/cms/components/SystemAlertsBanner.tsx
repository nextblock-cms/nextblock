'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  ClipboardCheck,
  ExternalLink,
  Info,
  Landmark,
  Undo2,
  UserCheck,
  UserPlus,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { isSafeInternalPath } from '../../../lib/auth-redirects';
import { resolveSystemAlert } from './system-alerts-actions';

export interface SystemAlertItem {
  id: string;
  alert_type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
}

export type SystemAlertTone = 'amber' | 'indigo' | 'violet' | 'rose' | 'orange' | 'sky' | 'slate';

/** Literal class strings per tone (Tailwind only generates utilities it finds verbatim). */
const TONE_CLASSES: Readonly<Record<SystemAlertTone, { box: string; cta: string }>> = {
  amber: {
    box: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200',
    cta: 'border-amber-400 dark:border-amber-600',
  },
  indigo: {
    box: 'border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-700/60 dark:bg-indigo-900/20 dark:text-indigo-200',
    cta: 'border-indigo-400 dark:border-indigo-600',
  },
  violet: {
    box: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700/60 dark:bg-violet-900/20 dark:text-violet-200',
    cta: 'border-violet-400 dark:border-violet-600',
  },
  rose: {
    box: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700/60 dark:bg-rose-900/20 dark:text-rose-200',
    cta: 'border-rose-400 dark:border-rose-600',
  },
  orange: {
    box: 'border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-700/60 dark:bg-orange-900/20 dark:text-orange-200',
    cta: 'border-orange-400 dark:border-orange-600',
  },
  sky: {
    box: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700/60 dark:bg-sky-900/20 dark:text-sky-200',
    cta: 'border-sky-400 dark:border-sky-600',
  },
  slate: {
    box: 'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700/60 dark:bg-slate-900/20 dark:text-slate-200',
    cta: 'border-slate-400 dark:border-slate-600',
  },
};

/**
 * How an alert type renders. `external` types (the developer tracks) link out to GitHub and the
 * release downloads, https only, in a new tab. `internal` types (affiliates) link to a CMS screen
 * with `next/link`: their `metadata.action_url` is used only when it is a site-relative `/cms/`
 * path that passes `isSafeInternalPath`, and `metadata.action_label` names the button.
 */
type SystemAlertTypeConfig =
  | {
      kind: 'external';
      tone: SystemAlertTone;
      icon: LucideIcon;
      primary: { key: string; label: string };
      secondary: { key: string; label: string };
    }
  | { kind: 'internal'; tone: SystemAlertTone; icon: LucideIcon; label: string };

export const SYSTEM_ALERT_TYPE_CONFIG: Readonly<Record<string, SystemAlertTypeConfig>> = {
  // Track A: the upstream sync hit a merge conflict.
  merge_conflict: {
    kind: 'external',
    tone: 'amber',
    icon: AlertTriangle,
    primary: { key: 'action_url', label: 'Resolve on GitHub' },
    secondary: { key: 'run_url', label: 'View workflow run' },
  },
  // Track B: a new NextBlock release is out.
  runtime_update_available: {
    kind: 'external',
    tone: 'indigo',
    icon: ArrowUpCircle,
    primary: { key: 'download_url', label: 'Download latest' },
    secondary: { key: 'html_url', label: 'Release notes' },
  },
  // Affiliates (migration 02030). The three actionable types reach the banner; the layout keeps
  // the informational ones on /cms/affiliates, but they still render sensibly if they arrive.
  affiliate_page_submitted: { kind: 'internal', tone: 'violet', icon: ClipboardCheck, label: 'Review storefronts' },
  affiliate_payout_failed: { kind: 'internal', tone: 'rose', icon: Wallet, label: 'Review payouts' },
  affiliate_refund_after_payout: { kind: 'internal', tone: 'orange', icon: Undo2, label: 'Review payouts' },
  affiliate_signed_up: { kind: 'internal', tone: 'sky', icon: UserPlus, label: 'View partners' },
  affiliate_profile_completed: { kind: 'internal', tone: 'sky', icon: UserCheck, label: 'View partners' },
  affiliate_payout_configured: { kind: 'internal', tone: 'sky', icon: Landmark, label: 'View partners' },
};

/** Unknown types: neutral, and no link (nothing vouches for their metadata). */
const FALLBACK_CONFIG: SystemAlertTypeConfig = { kind: 'internal', tone: 'slate', icon: Info, label: 'Open' };

const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 60;
/** Parsing base for in-app paths (a reserved TLD: never fetched, only compared). */
const INTERNAL_BASE = 'https://cms.invalid';

function readString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** An absolute https URL without credentials, normalized; anything else is dropped. */
export function safeExternalAlertUrl(value: string | undefined): string | null {
  if (!value || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return url.href;
}

/**
 * A site-relative CMS path (`/cms/...`) that passes the shared redirect rule, with dot segments
 * resolved first (`/cms/../partners` is `/partners` to a browser); else null.
 */
export function safeCmsAlertPath(value: string | undefined): string | null {
  if (!value || value.length > MAX_URL_LENGTH) return null;
  if (!isSafeInternalPath(value)) return null;
  let url: URL;
  try {
    url = new URL(value, INTERNAL_BASE);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_BASE || !url.pathname.startsWith('/cms/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A button label from metadata: one trimmed line of at most 60 characters, else the default. */
function readLabel(metadata: Record<string, unknown> | null, fallback: string): string {
  const raw = readString(metadata, 'action_label');
  if (!raw) return fallback;
  let clean = '';
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    clean += code < 32 || (code >= 127 && code < 160) ? ' ' : character;
  }
  clean = clean.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > MAX_LABEL_LENGTH ? `${clean.slice(0, MAX_LABEL_LENGTH - 1)}…` : clean;
}

export interface SystemAlertCta {
  href: string;
  label: string;
  /** True: external https link opened in a new tab. False: an in-app link. */
  external: boolean;
}

export interface SystemAlertPresentation {
  tone: SystemAlertTone;
  icon: LucideIcon;
  primary: SystemAlertCta | null;
  secondary: SystemAlertCta | null;
}

/** Tone, icon and calls to action of one alert (pure; the banner renders the result). */
export function resolveSystemAlertPresentation(alert: SystemAlertItem): SystemAlertPresentation {
  const config = Object.prototype.hasOwnProperty.call(SYSTEM_ALERT_TYPE_CONFIG, alert.alert_type)
    ? SYSTEM_ALERT_TYPE_CONFIG[alert.alert_type]
    : FALLBACK_CONFIG;

  if (config.kind === 'external') {
    const primaryHref = safeExternalAlertUrl(readString(alert.metadata, config.primary.key));
    const secondaryHref = safeExternalAlertUrl(readString(alert.metadata, config.secondary.key));
    return {
      tone: config.tone,
      icon: config.icon,
      primary: primaryHref ? { href: primaryHref, label: config.primary.label, external: true } : null,
      secondary: secondaryHref ? { href: secondaryHref, label: config.secondary.label, external: true } : null,
    };
  }

  const href = config === FALLBACK_CONFIG ? null : safeCmsAlertPath(readString(alert.metadata, 'action_url'));
  return {
    tone: config.tone,
    icon: config.icon,
    primary: href ? { href, label: readLabel(alert.metadata, config.label), external: false } : null,
    secondary: null,
  };
}

/**
 * Banner for unresolved system_alerts above every CMS page:
 *   - merge_conflict           -> amber, links to GitHub to resolve the sync (Track A).
 *   - runtime_update_available -> indigo, links to the release download (Track B).
 *   - affiliate_*              -> per-type tone, links to the affiliates screen that handles it.
 * Dismissing persists is_resolved=true (ADMIN-only via RLS) and hides the alert.
 */
export default function SystemAlertsBanner({ alerts }: { alerts: SystemAlertItem[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  const dismiss = (id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
    startTransition(() => {
      void resolveSystemAlert(id);
    });
  };

  return (
    <div className="mb-6 flex flex-col gap-3">
      {visible.map((alert) => {
        const presentation = resolveSystemAlertPresentation(alert);
        const Icon = presentation.icon;
        const tone = TONE_CLASSES[presentation.tone];
        const { primary, secondary } = presentation;

        return (
          <div
            key={alert.id}
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${tone.box}`}
            role="alert"
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{alert.title}</p>
              <p className="text-xs opacity-90">{alert.message}</p>
              {(primary || secondary) && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {primary && primary.external ? (
                    <Button asChild size="sm" variant="outline" className={tone.cta}>
                      <a href={primary.href} target="_blank" rel="noopener noreferrer">
                        {primary.label}
                        <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    </Button>
                  ) : null}
                  {primary && !primary.external ? (
                    <Button asChild size="sm" variant="outline" className={tone.cta}>
                      <Link href={primary.href}>
                        {primary.label}
                        <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </Button>
                  ) : null}
                  {secondary && (
                    <a
                      href={secondary.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
                    >
                      {secondary.label}
                    </a>
                  )}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => dismiss(alert.id)}
              disabled={isPending}
              aria-label="Dismiss alert"
              className="h-8 w-8 shrink-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
