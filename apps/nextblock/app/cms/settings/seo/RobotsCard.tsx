'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Separator,
} from '@nextblock-cms/ui';
import {
  formatPathList,
  parsePathList,
  type RobotsSettings,
  type RobotsUserAgentRule,
} from '@nextblock-cms/utils/seo';
import { AlertTriangle, Info, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { buildRobotsTxt, listUnservedCustomRuleLines } from '../../../../lib/seo/robots-txt';
import { robotsSettingsSignature } from '../../../../lib/seo/robots-settings-signature';
import { saveRobotsSettings } from './actions';

/** Matches the textarea styling used by the other settings screens. */
const textareaClass =
  'flex min-h-[92px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/**
 * One user-agent block as the form holds it.
 *
 * The two path lists are kept as raw textarea TEXT rather than as parsed arrays, and
 * that is the whole reason this type exists alongside `RobotsUserAgentRule`. Parsing
 * on every keystroke would fight the operator: `parsePathList` drops blank entries, so
 * the newline they just pressed would vanish before they could type the next path, and
 * a leading slash would appear under their cursor mid-word. The text is therefore
 * authoritative while the form is open and is parsed once, on the way out — which is
 * also exactly when the preview re-derives it, so what is previewed is what is saved.
 *
 * `key` is a render key, not data. Rules have no identity in the stored jsonb, so
 * removing the second of three rules would otherwise make React re-use the wrong DOM
 * nodes and move an operator's half-typed text into a different block.
 */
interface DraftUserAgentRule {
  allowText: string;
  disallowText: string;
  key: number;
  userAgent: string;
}

let nextRuleKey = 0;

function toDraftRules(rules: RobotsUserAgentRule[]): DraftUserAgentRule[] {
  return rules.map((rule) => ({
    allowText: formatPathList(rule.allow),
    disallowText: formatPathList(rule.disallow),
    key: (nextRuleKey += 1),
    userAgent: rule.userAgent,
  }));
}

type RobotsCardProps = {
  isSandbox: boolean;
  isSiteUrlConfigured: boolean;
  settings: RobotsSettings;
  sitemapUrl: string;
};

/**
 * The robots.txt editor, with a preview that cannot lie.
 *
 * The preview is rendered by `buildRobotsTxt` — the same function that serialises the
 * file crawlers are served. It is not a rendering "of the settings"; it is the file.
 * That matters more here than on most screens because robots.txt is write-only from
 * the operator's side: a mistake in it does not break a page they would notice, it
 * quietly removes the site from search results, and the feedback loop is weeks long.
 * Any second formatter written to "show roughly what will happen" would eventually
 * disagree with the real one, and the disagreement would be discovered by traffic
 * disappearing.
 *
 * Everything is edited locally and committed in one save. Robots directives are read
 * as a set — an `Allow` means nothing without knowing which `Disallow` it is carving
 * an exception out of — so saving each field as it changes would publish a sequence of
 * intermediate files that the operator never intended and never saw.
 */
export function RobotsCard({
  isSandbox,
  isSiteUrlConfigured,
  settings,
  sitemapUrl,
}: RobotsCardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [customRules, setCustomRules] = useState(settings.customRules);
  const [isIndexingEnabled, setIsIndexingEnabled] = useState(settings.isIndexingEnabled);
  const [sitemapEnabled, setSitemapEnabled] = useState(settings.sitemapEnabled);
  const [draftRules, setDraftRules] = useState<DraftUserAgentRule[]>(() =>
    toDraftRules(settings.userAgentRules)
  );

  /**
   * Re-seed the form when the SERVER's settings genuinely change.
   *
   * The state above is seeded once, which was the whole bug: after a save the action
   * revalidates and the normalised row comes back down this prop — blank paths dropped,
   * missing leading slashes added — but the card kept its own copy. The Save button stayed
   * lit forever because `isDirty` was comparing the operator's draft against a value the
   * database no longer held, and the preview kept rendering custom rules that had been
   * tidied away server-side, i.e. showing a file nobody would ever be served.
   *
   * The reset is gated on the settings' CONTENT, not on the prop's identity. A server
   * component builds a fresh object on every render, so `settings` is a new reference after
   * every `router.refresh()` — including refreshes triggered by other cards on this screen.
   * An effect keyed on the object itself would therefore wipe out half-typed rules whenever
   * anything else revalidated. Comparing signatures means the state is only ever thrown
   * away when the stored value really moved, which is exactly the moment the local copy is
   * known to be obsolete.
   */
  const settingsSignature = useMemo(() => robotsSettingsSignature(settings), [settings]);
  const seededSignatureRef = useRef(settingsSignature);

  useEffect(() => {
    if (seededSignatureRef.current === settingsSignature) {
      return;
    }

    seededSignatureRef.current = settingsSignature;
    setCustomRules(settings.customRules);
    setIsIndexingEnabled(settings.isIndexingEnabled);
    setSitemapEnabled(settings.sitemapEnabled);
    // Fresh render keys are minted here, so the textareas remount rather than reusing
    // nodes across a rule list that may have changed length — the same identity problem
    // `DraftUserAgentRule.key` exists to solve.
    setDraftRules(toDraftRules(settings.userAgentRules));
  }, [settings, settingsSignature]);

  /**
   * The form's current value in the engine's shape.
   *
   * Derived rather than stored, so there is exactly one source of truth for what is
   * about to be saved — and the preview below and the payload sent to the server are
   * literally the same object.
   */
  const draftSettings: RobotsSettings = useMemo(
    () => ({
      customRules,
      isIndexingEnabled,
      sitemapEnabled,
      userAgentRules: draftRules.map((rule) => ({
        allow: parsePathList(rule.allowText),
        disallow: parsePathList(rule.disallowText),
        userAgent: rule.userAgent.trim(),
      })),
    }),
    [customRules, draftRules, isIndexingEnabled, sitemapEnabled]
  );

  /**
   * Whether anything has actually changed, which is what gates the Save button and
   * Ctrl+S.
   *
   * Compared through `robotsSettingsSignature`, which reads the fields explicitly. A raw
   * `JSON.stringify` of both sides worked only because the form's object literal and
   * `normalizeRobotsSettings`' object literal happen to list their keys in the same
   * (alphabetical, per the house convention) order; the day one of them was reordered the
   * form would have been born dirty with nothing pointing at why. The failure mode is
   * benign in one direction only — a false "dirty" costs a redundant write, a false
   * "clean" loses an edit — so this comparison is allowed to be conservative but must
   * never be clever enough to miss a real change.
   */
  const isDirty = useMemo(
    () => robotsSettingsSignature(draftSettings) !== settingsSignature,
    [draftSettings, settingsSignature]
  );

  // What crawlers would actually receive, produced by the public serialiser. In the
  // sandbox that answer is fixed, so the second preview shows what a real install
  // would serve from the same settings — otherwise a sandbox visitor edits the form,
  // watches the preview refuse to change, and concludes the screen is broken.
  const servedPreview = useMemo(
    () => buildRobotsTxt(draftSettings, { isSandbox, sitemapUrl }),
    [draftSettings, isSandbox, sitemapUrl]
  );
  const ownInstallPreview = useMemo(
    () => (isSandbox ? buildRobotsTxt(draftSettings, { isSandbox: false, sitemapUrl }) : null),
    [draftSettings, isSandbox, sitemapUrl]
  );

  // Lines from the "extra lines" box that the served file cannot carry — comments,
  // and anything without a `directive: value` shape. The public file is produced by
  // app/robots.txt/route.ts running the very same `buildRobotsTxt`, so every directive
  // the preview shows is served; what is listed here never made it into the preview
  // either. Showing the difference is the whole point: a preview an operator trusts
  // and that quietly drops a line is worse than no preview at all, because they walk
  // away believing a rule is live.
  const unservedCustomLines = useMemo(
    () => listUnservedCustomRuleLines(draftSettings, { isSandbox, sitemapUrl }),
    [draftSettings, isSandbox, sitemapUrl]
  );

  const save = useCallback(() => {
    startTransition(async () => {
      const result = await saveRobotsSettings(draftSettings);

      if (result.ok) {
        toast.success(result.message);
        // Pulls the canonical, normalised row back down — blank paths dropped, missing
        // leading slashes added — so the form stops showing a draft the database has
        // already tidied up.
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }, [draftSettings, router]);

  // Ctrl/Cmd+S saves, which is the reflex of anyone who has just edited a text file —
  // and this card is, to the operator, a text file. Hand-rolled rather than using a
  // `useHotkeys` hook because this workspace has no hotkey library; a listener on the
  // window is the whole of what such a hook would install anyway. The ref keeps the
  // handler stable so the listener is bound once instead of on every keystroke.
  const saveRef = useRef(save);
  saveRef.current = save;
  const canSaveRef = useRef(false);
  canSaveRef.current = isDirty && !isPending;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
        return;
      }

      // Prevented unconditionally: the browser's "save this page" dialog is never what
      // somebody wants on a settings screen, and swallowing it while there is nothing
      // to save is less surprising than opening it.
      event.preventDefault();

      if (canSaveRef.current) {
        saveRef.current();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const updateRule = (key: number, patch: Partial<DraftUserAgentRule>) => {
    setDraftRules((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule))
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search engines &amp; robots.txt</CardTitle>
        <CardDescription>
          <span className="font-mono">/robots.txt</span> is the first file a crawler asks for. It
          says which parts of the site may be fetched — it is a request, honoured by the major
          search engines and ignored by anything malicious, so it is a traffic-shaping tool and
          never a security control. Never list a private path here expecting it to be hidden:
          this file is public, and naming a URL in it is the most reliable way to advertise it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {isSandbox && (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium">This sandbox always serves the same robots.txt.</p>
              <p className="text-muted-foreground">
                The demo is a copy of a real site and must stay out of Google&apos;s index, which it
                does by allowing crawling and answering every request with a{' '}
                <span className="font-mono">noindex</span> header — a crawler can only obey a
                noindex it is allowed to fetch. Blocking the crawl would leave the demo&apos;s URLs
                stranded in the index instead. Edit freely: the second preview below shows what your
                own install would serve.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <label className="flex items-start gap-3 text-sm" htmlFor="robots-indexing">
            <Checkbox
              checked={isIndexingEnabled}
              className="mt-0.5"
              id="robots-indexing"
              onCheckedChange={(checked) => setIsIndexingEnabled(checked === true)}
            />
            <span>
              <span className="font-medium">Allow search engines to index this site</span>
              <span className="block text-muted-foreground">
                Turning this off replaces every rule below with a site-wide{' '}
                <span className="font-mono">Disallow: /</span>, asking every crawler to stay away
                from the entire site. Your rules are kept and reappear the moment you switch it back
                on. Use it for a site that is not ready to be public — and expect pages already in
                the index to take weeks to drop out.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm" htmlFor="robots-sitemap">
            <Checkbox
              checked={sitemapEnabled}
              className="mt-0.5"
              id="robots-sitemap"
              onCheckedChange={(checked) => setSitemapEnabled(checked === true)}
            />
            <span>
              <span className="font-medium">Include a sitemap reference</span>
              <span className="block text-muted-foreground">
                Adds <span className="font-mono">Sitemap: {sitemapUrl}</span>, which is how a crawler
                discovers pages nothing links to. It is dropped automatically while indexing is off,
                because inviting a crawler to a sitemap you have just told it not to fetch is a
                contradiction.
              </span>
            </span>
          </label>

          {sitemapEnabled && !isSiteUrlConfigured && (
            <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p>
                No public site URL is configured, so the sitemap line would point at{' '}
                <span className="font-mono">{sitemapUrl}</span> — an address no crawler can reach.
                Set <span className="font-mono">NEXT_PUBLIC_URL</span> for this deployment.
              </p>
            </div>
          )}
        </div>

        <Separator />

        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Crawler rules</h3>
            <p className="text-sm text-muted-foreground">
              One block per crawler. <span className="font-mono">*</span> means every crawler that
              has no block of its own. Put one path per line — a path is matched as a prefix, so{' '}
              <span className="font-mono">/admin</span> also covers{' '}
              <span className="font-mono">/admin/anything</span>.
            </p>
          </div>

          {draftRules.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No blocks. A robots.txt with no rules at all is meaningless rather than strict, so one
              permissive <span className="font-mono">User-agent: *</span> block is served instead —
              see the preview.
            </p>
          )}

          {draftRules.map((rule, index) => (
            <div className="space-y-4 rounded-lg border bg-muted/30 p-4" key={rule.key}>
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-2">
                  <Label htmlFor={`robots-agent-${rule.key}`}>Crawler (user agent)</Label>
                  <Input
                    className="font-mono"
                    id={`robots-agent-${rule.key}`}
                    onChange={(event) => updateRule(rule.key, { userAgent: event.target.value })}
                    placeholder="*"
                    spellCheck={false}
                    value={rule.userAgent}
                  />
                </div>
                <Button
                  aria-label={`Remove the ${rule.userAgent || 'unnamed'} block`}
                  onClick={() =>
                    setDraftRules((current) => current.filter((entry) => entry.key !== rule.key))
                  }
                  size="sm"
                  variant="outline"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {rule.userAgent.trim() === '' && (
                <p className="text-xs text-destructive">
                  A block with no crawler name is dropped when you save — a bare{' '}
                  <span className="font-mono">User-agent:</span> line would apply to nobody and
                  silently orphan the rules under it.
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`robots-allow-${rule.key}`}>Allow</Label>
                  <textarea
                    className={textareaClass}
                    id={`robots-allow-${rule.key}`}
                    onChange={(event) => updateRule(rule.key, { allowText: event.target.value })}
                    placeholder={'/'}
                    spellCheck={false}
                    value={rule.allowText}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`robots-disallow-${rule.key}`}>Disallow</Label>
                  <textarea
                    className={textareaClass}
                    id={`robots-disallow-${rule.key}`}
                    onChange={(event) => updateRule(rule.key, { disallowText: event.target.value })}
                    placeholder={'/cms\n/api'}
                    spellCheck={false}
                    value={rule.disallowText}
                  />
                </div>
              </div>

              {index === 0 && (
                <p className="text-xs text-muted-foreground">
                  Paths are tidied on save: a missing leading slash is added and blank lines are
                  dropped. A pattern starting with <span className="font-mono">*</span> is left
                  alone, because <span className="font-mono">*.pdf$</span> would mean something else
                  with a slash in front of it.
                </p>
              )}
            </div>
          ))}

          <Button
            onClick={() =>
              setDraftRules((current) => [
                ...current,
                { allowText: '', disallowText: '', key: (nextRuleKey += 1), userAgent: '' },
              ])
            }
            size="sm"
            variant="outline"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add a crawler block
          </Button>
        </div>

        <Separator />

        <div className="space-y-2">
          <Label htmlFor="robots-custom">Extra lines</Label>
          <textarea
            className={`${textareaClass} min-h-[120px]`}
            id="robots-custom"
            onChange={(event) => setCustomRules(event.target.value)}
            placeholder={'# Anything valid in robots.txt\nUser-agent: GPTBot\nDisallow: /'}
            spellCheck={false}
            value={customRules}
          />
          <p className="text-xs text-muted-foreground">
            Appended to the file exactly as typed, after the blocks above and before the sitemap
            line. Use it for directives this form does not model — a{' '}
            <span className="font-mono">Crawl-delay</span>, a comment, an AI-crawler block. These
            lines survive the indexing switch, so an exception you need to keep working stays here.
            Nothing validates them; the preview is the check.
          </p>
        </div>

        <Separator />

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {isSandbox ? 'What this sandbox serves at /robots.txt' : 'What crawlers will receive'}
          </h3>
          <p className="text-sm text-muted-foreground">
            Generated by the same code that serves the file, so this is the file — not a
            description of it.
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
            <code>{servedPreview}</code>
          </pre>

          {unservedCustomLines.length > 0 && (
            <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-medium">
                  {unservedCustomLines.length === 1
                    ? 'One extra line will not appear in the served file:'
                    : `${unservedCustomLines.length} extra lines will not appear in the served file:`}
                </p>
                <ul className="mt-2 space-y-1">
                  {unservedCustomLines.map((line) => (
                    <li key={line} className="font-mono text-xs">
                      {line}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs">
                  {isSandbox
                    ? 'Sandbox deployments serve a fixed robots.txt, so extra lines are inert here. They will apply on your own install.'
                    : 'robots.txt is served through the Next.js metadata route, which emits only recognised directives — so comments and lines without a "Directive: value" shape are dropped. No crawler acts on those lines, so nothing is lost, but they will not be in the file.'}
                </p>
              </div>
            </div>
          )}
        </div>

        {ownInstallPreview !== null && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">What your own install would serve</h3>
            <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
              <code>{ownInstallPreview}</code>
            </pre>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button disabled={!isDirty || isPending} onClick={save}>
            <Save className="mr-2 h-4 w-4" />
            {isPending ? 'Saving…' : 'Save robots settings'}
          </Button>
          {isDirty && !isPending && (
            <span className="text-xs text-muted-foreground">
              Unsaved changes — Ctrl+S also saves.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
