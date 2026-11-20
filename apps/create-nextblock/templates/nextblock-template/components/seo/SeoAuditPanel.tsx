'use client';

/**
 * The live SEO audit that sits beside the Tiptap canvas.
 *
 * Three constraints shaped everything in this file.
 *
 * First, **the audit is deterministic and local**. Every number on screen comes
 * from `@nextblock-cms/utils/seo`, a pure dependency-free engine that runs in
 * the browser. No model is consulted to produce a score, which is what makes it
 * safe to re-run while someone is typing: it costs nothing, it cannot fail, and
 * it cannot disagree with itself between two runs over the same text. The only
 * network call in this component is the explicit, user-initiated "Fix with
 * Cortex AI" click.
 *
 * Second, **typing must never stutter**. `NotionEditor` calls `useEditor`
 * without `shouldRerenderOnTransaction`, so Tiptap does not re-render this
 * subtree on keystrokes; what does change on every keystroke is the `content`
 * prop, arriving through the block editor's own state. Auditing on each of those
 * would parse the whole document per character. The recompute is therefore on a
 * trailing 300 ms debounce, and documents past `SEO_LIVE_AUDIT_MAX_CHARACTERS`
 * are not audited live at all — a 400k-character document is pathological, and
 * freezing the tab to grade it would be a worse outcome than declining to.
 *
 * Third, **the panel knows nothing about how it is mounted**. It receives the
 * content string, an optional editor instance and the Cortex AI activation flag
 * as props, because `libs/editor` cannot import application code and the CMS
 * cannot reach into the editor's internals. The editor arrives via the
 * `onEditorReady` prop added to `NotionEditor` rather than through the legacy
 * `window.__nextblockEditor` global, which races whenever two editors mount.
 *
 * Note on metadata: `metaTitle` and `metaDescription` are forwarded to the
 * engine exactly as received, because the engine distinguishes `undefined`
 * ("this caller is not auditing metadata") from `null` or `''` ("the field
 * exists and is blank", which is a finding). Defaulting them here would invent
 * two failures every caller that only edits body copy is powerless to fix.
 *
 * Fourth, added after the first release: **the panel has a scope, and it says so
 * out loud**. The original version was only ever mounted inside a rich-text
 * block, where it graded one paragraph as though it were the whole page and
 * reported "no H1" and "fewer than 300 words" — neither of which is a property a
 * single block can have. The engine now takes a `scope`, and this component
 * takes two mutually exclusive sources for the text it grades: `content`, one
 * block's stored string, or `document`, a `SeoDocument` the caller has already
 * assembled from every block on the page. Whichever arrives is passed straight
 * through with the scope, and the header names the scope so a block score can
 * never be mistaken for the page score.
 */

import * as React from 'react';

import { Input, Label } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import {
  auditSeo,
  buildSeoDocument,
  KEYWORD_DENSITY_MAXIMUM,
  KEYWORD_DENSITY_MINIMUM,
  type SeoAuditResult,
  type SeoAuditScope,
  type SeoDocument,
  type SeoIssue,
} from '@nextblock-cms/utils/seo';
import { Check, FileWarning, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { buildCortexAiRequestHeaders } from '../../lib/cortex-ai/sandbox-headers';
import {
  buildSeoFixContext,
  buildSeoFixPrompt,
  type SeoFixInsertionMode,
} from '../../lib/seo/fix-prompts';
import { SeoIssueList } from './SeoIssueList';
import { SeoScoreDial } from './SeoScoreDial';

/**
 * How long to wait after the last keystroke before re-grading the document.
 *
 * 300 ms is the usual "the author paused" threshold: long enough that a normal
 * typing burst produces one audit rather than forty, short enough that the panel
 * still feels like it is watching the document rather than reporting on it.
 */
export const SEO_LIVE_AUDIT_DEBOUNCE_MS = 300;

/**
 * Above this many characters the live audit is skipped entirely.
 *
 * The engine is linear in document length, but "linear" over 400k characters is
 * still tens of milliseconds of main-thread work on every pause, and the
 * documents that reach this size are pasted archives rather than pages anyone is
 * optimising for search. Declining, visibly, beats freezing the tab.
 */
export const SEO_LIVE_AUDIT_MAX_CHARACTERS = 400_000;

/** Matches the abort budget the editor's own Cortex AI prompt bar uses. */
const SEO_FIX_TIMEOUT_MS = 150_000;

/**
 * The slice of Tiptap's `Editor` this panel actually touches.
 *
 * Declared structurally rather than imported so the CMS does not take a hard
 * dependency on `@tiptap/core` for the sake of one optional prop, and so the
 * panel can be handed a stub in any future test. A real `Editor` satisfies this
 * shape, so `onEditorReady`'s value can be passed straight in.
 */
export interface TiptapEditorLike {
  chain(): TiptapChainLike;
  commands: { setContent(content: string): boolean };
  getText(): string;
  isEmpty: boolean;
  off(event: string, handler: () => void): unknown;
  on(event: string, handler: () => void): unknown;
  state: {
    doc: {
      content: { size: number };
      textBetween(from: number, to: number, separator?: string): string;
    };
    selection: { empty: boolean; from: number; to: number };
  };
}

/** The fluent command subset used by the three insertion branches below. */
export interface TiptapChainLike {
  focus(): TiptapChainLike;
  insertContentAt(
    position: number | { from: number; to: number },
    content: string
  ): TiptapChainLike;
  run(): boolean;
}

export interface SeoAuditPanelProps {
  className?: string;
  /**
   * One block's stored content. Not necessarily HTML — a text block may hold a
   * JSON-stringified Tiptap document instead — which is why it is handed to
   * `buildSeoDocument` raw: that function detects and handles both.
   *
   * Ignored when `document` is supplied, because a caller that has already
   * assembled the whole page cannot express it as a single string.
   */
  content?: string | null;
  /**
   * A pre-assembled document, used by the page-level mount.
   *
   * The page audit has to merge standalone `heading` blocks, the h1-h6 nodes
   * inside a text block's HTML, and blocks nested in a section's columns into
   * one ordered document; `buildPageSeoDocument` does that walk, and the result
   * arrives here already normalised. Building it is the caller's job rather than
   * this component's so that the panel keeps knowing nothing about the block
   * union — see the module docblock's third constraint.
   *
   * Pass a referentially stable value (a `useMemo`): its identity is a debounce
   * dependency, so a fresh object on every render would restart the timer
   * forever and the score would never settle.
   */
  document?: SeoDocument;
  /**
   * The live editor, when the host has one. Without it the panel is a read-only
   * report: it can still grade the document, but it has nowhere to write a fix.
   * The page-level mount never has one — there is no single editor behind a
   * dozen blocks — which is precisely why the Fix button is tied to this prop
   * rather than to the Cortex AI flag alone.
   */
  editor?: TiptapEditorLike | null;
  /** Whether the premium Cortex AI package is activated on this install. */
  isCortexAiActive?: boolean;
  keyword?: string;
  metaDescription?: string | null;
  metaTitle?: string | null;
  /**
   * Fires with each completed audit, and with `null` while one is pending or
   * refused. It exists so a collapsed host can show a live summary — a score and
   * an issue count — without running a second, competing analysis of its own.
   */
  onAuditChange?: (audit: SeoAuditResult | null) => void;
  onKeywordChange?: (keyword: string) => void;
  /**
   * Which checks apply. Defaults to `'page'` so that a caller who forgets to
   * think about scope gets the complete, honest audit rather than a silently
   * narrowed one.
   */
  scope?: SeoAuditScope;
}

/**
 * The header, per scope.
 *
 * This wording is load-bearing rather than decorative: the bug that prompted the
 * page-level audit was an author reading a block's score as the page's score, so
 * both headings name their subject and the block description points at where the
 * page-wide checks actually live.
 */
const SCOPE_HEADING: Record<SeoAuditScope, string> = {
  block: 'Block SEO analysis',
  page: 'Page SEO analysis',
};

const SCOPE_DESCRIPTION: Record<SeoAuditScope, string> = {
  block:
    'Scored on this block alone. Page-wide checks — one H1, total word count, meta title and description — are on the page editor’s SEO panel.',
  page: 'Scored across every block on this page, together with the meta title and description.',
};

/** Bar colours for the density meter, matching the CMS pass/warn convention. */
const DENSITY_STATE_STYLE: Record<'high' | 'low' | 'ok', string> = {
  high: 'bg-amber-500',
  low: 'bg-amber-500',
  ok: 'bg-emerald-500',
};

const DENSITY_STATE_LABEL: Record<'high' | 'low' | 'ok', string> = {
  high: 'Above the target range',
  low: 'Below the target range',
  ok: 'In the target range',
};

/**
 * Upper bound of the density meter's scale, in percent.
 *
 * The target band is 1.0%-2.5%, so a 5% scale puts it across the middle of the
 * track where it is legible, while still leaving room to show a genuinely
 * over-stuffed page as pinned near the end rather than silently clipped.
 */
const DENSITY_SCALE_MAXIMUM = 5;

export function SeoAuditPanel({
  className,
  content,
  // Renamed on the way in: an unqualified `document` inside a component body
  // shadows the global one, and a later reader would have to check which was
  // meant on every line that mentions it.
  document: providedDocument,
  editor,
  isCortexAiActive = false,
  keyword,
  metaDescription,
  metaTitle,
  onAuditChange,
  onKeywordChange,
  scope = 'page',
}: SeoAuditPanelProps) {
  /**
   * The keyphrase field's id.
   *
   * Generated rather than hard-coded because both scopes can be on screen at
   * once — the page-level panel sits on the edit screen while a block editor
   * opens over it in a dialog — and two elements sharing an id would send every
   * click on one panel's `<Label>` to the other panel's input.
   */
  const keywordInputId = React.useId();

  /**
   * The keyphrase is controlled by the host so it can be persisted with the
   * content. When no handler is supplied the panel keeps its own copy instead of
   * rendering an input that silently refuses every keystroke — a dead field is a
   * bug report waiting to happen, and an ephemeral one is still useful for a
   * quick "what would this score for…" check.
   */
  const [internalKeyword, setInternalKeyword] = React.useState(keyword ?? '');
  const isKeywordControlled = typeof onKeywordChange === 'function';
  const activeKeyword = isKeywordControlled ? keyword ?? '' : internalKeyword;

  const [audit, setAudit] = React.useState<SeoAuditResult | null>(null);
  const [isRecomputePending, setIsRecomputePending] = React.useState(true);
  const [isDocumentTooLarge, setIsDocumentTooLarge] = React.useState(false);

  const [fixingIssueId, setFixingIssueId] = React.useState<string | null>(null);
  const [fixErrors, setFixErrors] = React.useState<Record<string, string>>({});
  const [hasSelection, setHasSelection] = React.useState(false);

  /**
   * How much text is on the table, measured before any parsing happens.
   *
   * For a raw `content` string this is the unparsed source length, which is the
   * only number available before `buildSeoDocument` runs and therefore the only
   * one that can keep a pathological paste from being parsed at all. For a
   * pre-assembled `document` the caller has already paid for the walk, so the
   * normalised text length is both available and the more honest measure.
   */
  const sourceLength = providedDocument ? providedDocument.text.length : (content ?? '').length;

  // The trailing debounce. Every dependency here is a value the score depends
  // on, so changing the keyphrase re-grades on the same 300 ms delay as typing
  // does rather than on a separate, faster path that could interleave results.
  React.useEffect(() => {
    if (sourceLength > SEO_LIVE_AUDIT_MAX_CHARACTERS) {
      setIsDocumentTooLarge(true);
      setIsRecomputePending(false);
      setAudit(null);
      return;
    }

    setIsDocumentTooLarge(false);
    setIsRecomputePending(true);

    const timeoutId = window.setTimeout(() => {
      setAudit(
        auditSeo({
          // A supplied document wins over `content`: the page-level caller has
          // merged many blocks into one document and has no single string left
          // to hand over, so there is nothing sensible to fall back to.
          document: providedDocument ?? buildSeoDocument(content ?? ''),
          keyword: activeKeyword,
          metaDescription,
          metaTitle,
          scope,
        })
      );
      setIsRecomputePending(false);
    }, SEO_LIVE_AUDIT_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [activeKeyword, content, metaDescription, metaTitle, providedDocument, scope, sourceLength]);

  /**
   * Republish each result to the host.
   *
   * Reporting from an effect rather than from inside the debounce callback keeps
   * the "who owns this state" story simple — the panel owns the audit, the host
   * only observes it — and it means a host that collapses the panel still sees
   * every recomputation, including the `null` the panel publishes while one is
   * pending or when the document was too large to grade.
   */
  React.useEffect(() => {
    onAuditChange?.(audit);
  }, [audit, onAuditChange]);

  /**
   * Track whether the author has text selected.
   *
   * Subscribing to editor events is the only way to know: `useEditor` was called
   * without `shouldRerenderOnTransaction`, so nothing in this subtree re-renders
   * when the selection moves. It is worth knowing because it decides where a fix
   * lands — with a selection the rewrite replaces it, without one the rewrite is
   * appended — and telling the author that before they click is the difference
   * between a fix and a surprise.
   */
  React.useEffect(() => {
    if (!editor) {
      setHasSelection(false);
      return;
    }

    const sync = () => setHasSelection(!editor.state.selection.empty);

    sync();
    editor.on('selectionUpdate', sync);
    editor.on('transaction', sync);

    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('transaction', sync);
    };
  }, [editor]);

  const canOfferFixes = isCortexAiActive && Boolean(editor);

  const handleFix = React.useCallback(
    async (issue: SeoIssue) => {
      if (!editor || fixingIssueId !== null) {
        return;
      }

      setFixingIssueId(issue.id);
      setFixErrors((previous) => {
        const next = { ...previous };
        delete next[issue.id];
        return next;
      });

      // Everything about the target is captured before the await: the document
      // can change while the request is in flight, and applying the answer to a
      // position derived from the post-response state would drop the fragment
      // somewhere the author never asked for.
      const abortController = new AbortController();
      const timeoutId = window.setTimeout(() => abortController.abort(), SEO_FIX_TIMEOUT_MS);
      const wasEditorEmpty = editor.isEmpty;
      const selectionBefore = editor.state.selection;
      const selectionHadRange = !selectionBefore.empty;
      const selectionFrom = selectionBefore.from;
      const selectionTo = selectionBefore.to;
      const selectedText = selectionHadRange
        ? editor.state.doc.textBetween(selectionFrom, selectionTo, ' ').trim()
        : '';
      const insertionMode: SeoFixInsertionMode = wasEditorEmpty
        ? 'replace-empty-document'
        : selectionHadRange
          ? 'replace-selection'
          : 'append-to-end';

      try {
        // Sandbox installs have no server-side Cortex AI credentials, so the
        // browser forwards the visitor's own OpenRouter key from localStorage.
        // `NotionEditor.handleAiGenerate` still inlines this — it cannot import
        // app code — but every call site inside the CMS goes through the shared
        // builder, which is the whole reason that module exists: a header name
        // or storage key that changes in one copy and not the other fails
        // silently, authenticating one AI button and not the next.
        const headers = buildCortexAiRequestHeaders();

        const context = buildSeoFixContext({
          documentText: editor.getText().trim(),
          headingOutline: audit?.headings.map((heading) => `H${heading.level} ${heading.text}`),
          insertionMode,
          selectedText,
          wordCount: audit?.readability.wordCount ?? null,
        });
        const prompt = buildSeoFixPrompt({
          issue,
          keyword: activeKeyword,
          wordCount: audit?.readability.wordCount ?? null,
        });

        // The body carries `context` and `prompt` and nothing else: the route
        // validates with a `z.strictObject`, so one stray key is a flat 400.
        const response = await fetch('/api/ai/generate-blocks', {
          body: JSON.stringify({ context, prompt }),
          headers,
          method: 'POST',
          signal: abortController.signal,
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload?.error || 'Cortex AI could not generate content.');
        }

        if (!payload || typeof payload.html !== 'string' || !payload.html.trim()) {
          throw new Error('Cortex AI returned an invalid HTML fragment.');
        }

        if (wasEditorEmpty || editor.isEmpty) {
          editor.commands.setContent(payload.html);
        } else if (selectionHadRange) {
          // The document may have shrunk while the request was outstanding, so
          // both ends are clamped: ProseMirror throws on an out-of-range
          // position, which would lose the generated fragment entirely.
          const docEnd = editor.state.doc.content.size;
          const from = Math.min(selectionFrom, docEnd);
          const to = Math.min(selectionTo, docEnd);

          editor.chain().focus().insertContentAt({ from, to }, payload.html).run();
        } else {
          editor.chain().focus().insertContentAt(editor.state.doc.content.size, payload.html).run();
        }

        toast.success('Cortex AI applied a fix. Review it before publishing.');
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'Cortex AI took too long to respond. Please try again.'
            : error instanceof Error
              ? error.message
              : 'Cortex AI could not generate content.';

        setFixErrors((previous) => ({ ...previous, [issue.id]: message }));
      } finally {
        window.clearTimeout(timeoutId);
        setFixingIssueId(null);
      }
    },
    [activeKeyword, audit, editor, fixingIssueId]
  );

  const keywordStats = audit?.keyword ?? null;
  const densityState: 'high' | 'low' | 'ok' = !keywordStats
    ? 'low'
    : keywordStats.density < KEYWORD_DENSITY_MINIMUM
      ? 'low'
      : keywordStats.density > KEYWORD_DENSITY_MAXIMUM
        ? 'high'
        : 'ok';

  return (
    <div className={cn('flex flex-col gap-4 p-4 text-sm', className)}>
      <header className="space-y-1">
        <h3 className="text-sm font-semibold">{SCOPE_HEADING[scope]}</h3>
        <p className="text-xs text-muted-foreground">{SCOPE_DESCRIPTION[scope]}</p>
        <p className="text-xs text-muted-foreground">
          Updates automatically as you write. Nothing here is sent anywhere until you ask Cortex
          AI to fix something.
        </p>
      </header>

      <div className="space-y-2">
        <Label className="text-xs" htmlFor={keywordInputId}>
          Focus keyphrase
        </Label>
        <Input
          className="h-8 text-sm"
          id={keywordInputId}
          onChange={(event) => {
            const value = event.target.value;
            if (isKeywordControlled) {
              onKeywordChange?.(value);
            } else {
              setInternalKeyword(value);
            }
          }}
          placeholder="e.g. organic green tea"
          value={activeKeyword}
        />
        <p className="text-xs text-muted-foreground">
          The phrase this page should rank for. Leave it blank to skip the keyphrase checks.
        </p>
      </div>

      {/* A polite live region rather than an assertive one: the score changing
          while you type is information, not an interruption. */}
      <div aria-live="polite" className="sr-only">
        {audit ? `SEO score ${audit.score} out of 100.` : 'Analysing the document.'}
      </div>

      {isDocumentTooLarge ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <FileWarning
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <p>
            This document is too large for the live audit ({sourceLength.toLocaleString('en-US')}{' '}
            characters). Grading it on every pause would freeze the editor, so the analysis is
            paused until there is less text to read.
          </p>
        </div>
      ) : !audit ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Analysing the document…
        </div>
      ) : (
        <>
          <SeoScoreDial band={audit.scoreBand} score={audit.score} scope={scope} />

          {isRecomputePending && (
            <p className="text-xs text-muted-foreground">Recalculating…</p>
          )}

          {audit.checks.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Checks
              </h4>
              <ul className="space-y-1">
                {audit.checks.map((check) => (
                  <li key={check.id} className="flex items-start gap-2 text-xs">
                    {check.passed ? (
                      <Check
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                      />
                    ) : (
                      <X
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400"
                      />
                    )}
                    <span className={cn('flex-1', check.passed ? '' : 'font-medium')}>
                      {/* Spelled out for screen readers, because the tick and
                          the cross are the only visual difference between a
                          passing and a failing row. */}
                      <span className="sr-only">{check.passed ? 'Passed: ' : 'Failed: '}</span>
                      {check.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {check.weight} pts
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <SeoIssueList
            busyIssueId={fixingIssueId}
            errors={fixErrors}
            issues={audit.issues}
            onFix={canOfferFixes ? (issue) => void handleFix(issue) : undefined}
          />

          {canOfferFixes && (
            <p className="text-xs text-muted-foreground">
              {hasSelection
                ? 'A fix will rewrite the text you have selected.'
                : 'Nothing is selected, so a fix will be added at the end of the block. Select a passage first to rewrite it in place.'}
            </p>
          )}

          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Readability
            </h4>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Flesch reading ease</dt>
              <dd className="text-right font-medium tabular-nums">
                {audit.readability.fleschReadingEase}
              </dd>
              <dt className="text-muted-foreground">Grade</dt>
              <dd className="text-right font-medium">{audit.readability.grade}</dd>
              <dt className="text-muted-foreground">Average sentence length</dt>
              <dd className="text-right font-medium tabular-nums">
                {audit.readability.averageSentenceLength} words
              </dd>
              <dt className="text-muted-foreground">Syllables per word</dt>
              <dd className="text-right font-medium tabular-nums">
                {audit.readability.averageSyllablesPerWord}
              </dd>
              <dt className="text-muted-foreground">Sentences</dt>
              <dd className="text-right font-medium tabular-nums">
                {audit.readability.sentenceCount}
              </dd>
              <dt className="text-muted-foreground">Words</dt>
              <dd className="text-right font-medium tabular-nums">
                {audit.readability.wordCount}
              </dd>
              <dt className="text-muted-foreground">Syllables</dt>
              <dd className="text-right font-medium tabular-nums">
                {audit.readability.syllableCount}
              </dd>
            </dl>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Keyphrase
            </h4>

            {!keywordStats ? (
              <p className="text-xs text-muted-foreground">
                Set a focus keyphrase above to see how often and where it appears.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">Density</span>
                    <span className="font-medium tabular-nums">
                      {keywordStats.density}% &middot; {keywordStats.count}{' '}
                      {keywordStats.count === 1 ? 'match' : 'matches'}
                    </span>
                  </div>

                  {/*
                    Hand-drawn rather than the shared `Progress` primitive: that
                    component ignores its `max` and positions the indicator from
                    `value` as a raw percentage, so a 0-5% scale would render at
                    a twentieth of its true width. Drawing it here also lets the
                    1.0%-2.5% target band be shaded into the track, which is the
                    one thing a bare bar cannot tell you.
                  */}
                  <div
                    aria-label="Keyphrase density"
                    aria-valuemax={DENSITY_SCALE_MAXIMUM}
                    aria-valuemin={0}
                    aria-valuenow={keywordStats.density}
                    aria-valuetext={`${keywordStats.density} percent. ${DENSITY_STATE_LABEL[densityState]} of ${KEYWORD_DENSITY_MINIMUM} to ${KEYWORD_DENSITY_MAXIMUM} percent.`}
                    className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
                    role="meter"
                  >
                    <div
                      aria-hidden="true"
                      className="absolute inset-y-0 bg-emerald-500/20"
                      style={{
                        left: `${(KEYWORD_DENSITY_MINIMUM / DENSITY_SCALE_MAXIMUM) * 100}%`,
                        width: `${((KEYWORD_DENSITY_MAXIMUM - KEYWORD_DENSITY_MINIMUM) / DENSITY_SCALE_MAXIMUM) * 100}%`,
                      }}
                    />
                    <div
                      aria-hidden="true"
                      className={cn(
                        'absolute inset-y-0 left-0 rounded-full transition-[width]',
                        DENSITY_STATE_STYLE[densityState]
                      )}
                      style={{
                        width: `${Math.min(100, (keywordStats.density / DENSITY_SCALE_MAXIMUM) * 100)}%`,
                      }}
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {DENSITY_STATE_LABEL[densityState]} — aim for {KEYWORD_DENSITY_MINIMUM}% to{' '}
                    {KEYWORD_DENSITY_MAXIMUM}%.
                  </p>
                </div>

                <ul className="space-y-1 text-xs">
                  <KeywordPlacement label="Appears in the H1" present={keywordStats.inHeading1} />
                  <KeywordPlacement
                    label="Appears in a subheading"
                    present={keywordStats.inSubheadings}
                  />
                  <KeywordPlacement
                    label="Appears in the first 100 words"
                    present={keywordStats.inFirst100Words}
                  />
                </ul>
              </div>
            )}
          </section>

          {/*
            Two different reasons for the same missing button, and they need
            different sentences. At block scope the editor is merely late — it is
            loaded with `ssr: false` behind a fetch — so the button really will
            appear. At page scope there is no editor and never will be: a page is
            a dozen blocks and a fix has to land in one of them, so the honest
            instruction is to open that block. Rendering a Fix button here that
            had nowhere to write would be worse than rendering none.
          */}
          {isCortexAiActive && !editor && (
            <p className="text-xs text-muted-foreground">
              {scope === 'page'
                ? 'One-click fixes live in the block editors. Open the block a finding refers to and use its own SEO panel to have Cortex AI rewrite it.'
                : 'One-click fixes appear once the editor has finished loading.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One yes/no keyphrase placement row.
 *
 * The tick or cross is paired with an off-screen word so the state is never
 * conveyed by the glyph and its colour alone.
 */
function KeywordPlacement({ label, present }: { label: string; present: boolean }) {
  return (
    <li className="flex items-center gap-2">
      {present ? (
        <Check
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <span>
        <span className="sr-only">{present ? 'Yes: ' : 'No: '}</span>
        {label}
      </span>
    </li>
  );
}

export default SeoAuditPanel;
