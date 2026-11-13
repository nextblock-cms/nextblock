'use client';

import React, { useMemo, useState, useTransition } from 'react';
import { Button, Input, Label } from '@nextblock-cms/ui';
import { reviewScriptCode, type ScriptReview } from '@nextblock-cms/utils/script-safety';
import { toast } from 'sonner';

import {
  SITE_SCRIPT_LOAD_STRATEGIES,
  SITE_SCRIPT_PLACEMENTS,
  type SiteScript,
} from '../../../../../lib/site-scripts/types';
import {
  describeSiteScriptRevision,
  type SiteScriptRevision,
} from '../../../../../lib/site-scripts/revisions';
import {
  createSiteScript,
  deleteSiteScript,
  revertSiteScript,
  setSiteScriptActive,
  updateSiteScript,
  type SiteScriptInput,
} from '../actions';
import { SITE_SCRIPTS_SANDBOX_MESSAGE } from '../sandbox-lock';

/** The sandbox note every write control points at there (each site-scripts action refuses). */
const SANDBOX_NOTE_ID = 'site-scripts-sandbox-note';

const REVISION_LABELS: Record<string, string> = {
  create: 'Created',
  delete: 'Deleted',
  revert: 'Restored',
  update: 'Edited',
};

const PLACEMENT_LABELS: Record<string, string> = {
  body_end: 'End of <body> — after the markup (recommended)',
  body_start: 'Start of <body>',
  head: '<head> — before first paint (blocking)',
};

const EMPTY_DRAFT: SiteScriptInput = {
  code: '',
  description: '',
  is_active: false,
  load_strategy: 'default',
  name: '',
  placement: 'body_end',
  sort_order: 0,
  src: '',
};

const textareaClass =
  'w-full flex min-h-[220px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const selectClass =
  'w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const LEVEL_STYLES: Record<string, string> = {
  info: 'bg-muted text-muted-foreground',
  notice: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  warning: 'bg-destructive/10 text-destructive',
};

/**
 * What the code can actually reach, scanned from the source.
 *
 * Shown wherever a script is read or edited so the reviewer judges the code rather
 * than its description — the description may have been written by an AI agent that
 * read a hostile page.
 */
function SafetyReview({ review }: { review: ScriptReview }) {
  if (review.clean) {
    return (
      <p className="text-xs text-muted-foreground">
        No notable capabilities detected. {review.disclaimer}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {review.capabilities.map((capability) => (
          <span
            key={capability.id}
            title={capability.label}
            className={`rounded-full px-2 py-0.5 text-xs ${LEVEL_STYLES[capability.level] ?? ''}`}
          >
            {capability.id}
          </span>
        ))}
      </div>

      {review.capabilities
        .filter((capability) => capability.level === 'warning')
        .map((capability) => (
          <p key={capability.id} className="text-xs text-destructive">
            {capability.label}
          </p>
        ))}

      {review.externalHosts.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Contacts: <span className="font-mono">{review.externalHosts.join(', ')}</span>
        </p>
      )}

      <p className="text-xs text-muted-foreground">{review.disclaimer}</p>
    </div>
  );
}

function ScriptEditor({
  draft,
  locked = false,
  onCancel,
  onChange,
  onSave,
  saving,
  title,
}: {
  draft: SiteScriptInput;
  /** On the sandbox: Save is disabled and described by the sandbox note. */
  locked?: boolean;
  onCancel: () => void;
  onChange: (next: SiteScriptInput) => void;
  onSave: () => void;
  saving: boolean;
  title: string;
}) {
  const set = (patch: Partial<SiteScriptInput>) => onChange({ ...draft, ...patch });
  // Recomputed as the author types, so the consequences are visible before saving.
  const review = useMemo(
    () => reviewScriptCode({ code: draft.code, src: draft.src }),
    [draft.code, draft.src]
  );

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="script-name">Name</Label>
          <Input
            id="script-name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Scroll reveal animations"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="script-placement">Placement</Label>
          <select
            id="script-placement"
            className={selectClass}
            value={draft.placement}
            onChange={(e) => set({ placement: e.target.value })}
          >
            {SITE_SCRIPT_PLACEMENTS.map((placement) => (
              <option key={placement} value={placement}>
                {PLACEMENT_LABELS[placement] ?? placement}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="script-description">Description</Label>
        <Input
          id="script-description"
          value={draft.description ?? ''}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="What this script does, and which pages rely on it"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="script-code">JavaScript</Label>
        <textarea
          id="script-code"
          className={textareaClass}
          value={draft.code ?? ''}
          onChange={(e) => set({ code: e.target.value })}
          placeholder={"document.querySelectorAll('.nb-reveal').forEach((el) => {\n  // ...\n});"}
        />
        <p className="text-xs text-muted-foreground">
          Written without the surrounding &lt;script&gt; tag — NextBlock adds it, along with the
          page&apos;s CSP nonce.
        </p>
        <p className="text-xs text-muted-foreground">
          Pages are React-hydrated. Do <strong>not</strong> change the text, classes, or attributes
          of existing markup — React reconciles afterwards and reverts your change (a counter
          animates, then snaps back). Waiting for the <code>load</code> event is not enough;
          hydration can still be running. Animate with the Web Animations API instead, which writes
          no attributes:
        </p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          <code>{`el.animate(
  [{ opacity: 0 }, { opacity: 1 }],
  { duration: 600, fill: 'both' }
);`}</code>
        </pre>
        <p className="text-xs text-muted-foreground">
          Appending your own new elements is always safe — React does not own those. So is anything
          you can express in CSS.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="script-src">External URL (optional)</Label>
          <Input
            id="script-src"
            value={draft.src ?? ''}
            onChange={(e) => set({ src: e.target.value })}
            placeholder="https://example.com/widget.js"
          />
          <p className="text-xs text-muted-foreground">
            When set, this file is loaded instead of the JavaScript above. Must be https.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="script-strategy">Loading (external only)</Label>
          <select
            id="script-strategy"
            className={selectClass}
            value={draft.load_strategy}
            onChange={(e) => set({ load_strategy: e.target.value })}
          >
            {SITE_SCRIPT_LOAD_STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(draft.is_active)}
          onChange={(e) => set({ is_active: e.target.checked })}
        />
        Enabled — run this on the public site
      </label>

      <div className="rounded-md border bg-background p-3">
        <p className="mb-2 text-xs font-medium">What this code can reach</p>
        <SafetyReview review={review} />
      </div>

      <div className="flex gap-2">
        <Button
          onClick={onSave}
          disabled={saving || locked}
          aria-describedby={locked ? SANDBOX_NOTE_ID : undefined}
        >
          {saving ? 'Saving…' : 'Save script'}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RevisionHistory({
  locked = false,
  onRestore,
  pending,
  revisions,
}: {
  /** On the sandbox: Restore is disabled and described by the sandbox note. */
  locked?: boolean;
  onRestore: (revisionId: string, label: string) => void;
  pending: boolean;
  revisions: SiteScriptRevision[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium"
        onClick={() => setOpen((value) => !value)}
      >
        <span>History &amp; audit log</span>
        <span className="text-xs text-muted-foreground">
          {revisions.length} {revisions.length === 1 ? 'entry' : 'entries'} {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="border-t">
          {revisions.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              Nothing recorded yet. Every change to a site script is logged here.
            </p>
          ) : (
            <ul className="divide-y">
              {revisions.map((revision) => (
                <li key={revision.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">
                        {REVISION_LABELS[revision.revision_type] ?? revision.revision_type}
                      </span>
                      <span className="truncate">{revision.script_name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          revision.source === 'mcp'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground'
                        }`}
                        title={
                          revision.source === 'mcp'
                            ? 'Made by an AI client through an MCP token'
                            : 'Made in the CMS dashboard'
                        }
                      >
                        {revision.source === 'mcp' ? 'MCP' : 'Dashboard'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(revision.created_at).toLocaleString()}
                      {' — '}
                      {describeSiteScriptRevision(revision)}
                    </p>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || locked}
                    aria-describedby={locked ? SANDBOX_NOTE_ID : undefined}
                    onClick={() =>
                      onRestore(
                        revision.id,
                        `${revision.script_name} (${new Date(revision.created_at).toLocaleString()})`
                      )
                    }
                  >
                    Restore this version
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function SiteScriptManager({
  initialRevisions,
  initialScripts,
}: {
  initialRevisions: SiteScriptRevision[];
  initialScripts: SiteScript[];
}) {
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SiteScriptInput>(EMPTY_DRAFT);
  // Read-only on the sandbox, whose admin login is public (every site-scripts action refuses there).
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const describedBySandboxNote = isSandbox ? SANDBOX_NOTE_ID : undefined;

  const run = (action: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(result.message ?? 'Saved.');
        setCreating(false);
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
      } else {
        toast.error(result.error ?? 'Something went wrong.');
      }
    });
  };

  const startEdit = (script: SiteScript) => {
    setCreating(false);
    setEditingId(script.id);
    setDraft({
      code: script.code,
      description: script.description ?? '',
      is_active: script.is_active,
      load_strategy: script.load_strategy,
      name: script.name,
      placement: script.placement,
      sort_order: script.sort_order,
      src: script.src ?? '',
    });
  };

  return (
    <div className="space-y-6">
      {isSandbox ? (
        <p id={SANDBOX_NOTE_ID} className="text-sm text-muted-foreground">
          {SITE_SCRIPTS_SANDBOX_MESSAGE}
        </p>
      ) : null}

      {!creating && !editingId && (
        <Button
          disabled={isSandbox}
          aria-describedby={describedBySandboxNote}
          onClick={() => {
            setCreating(true);
            setDraft(EMPTY_DRAFT);
          }}
        >
          Add script
        </Button>
      )}

      {creating && (
        <ScriptEditor
          draft={draft}
          locked={isSandbox}
          onCancel={() => setCreating(false)}
          onChange={setDraft}
          onSave={() => run(() => createSiteScript(draft))}
          saving={isPending}
          title="New script"
        />
      )}

      {initialScripts.length === 0 && !creating && (
        <p className="text-sm text-muted-foreground">
          No site scripts yet. Add one to run JavaScript on every page — or ask Cortex AI to create
          it for you.
        </p>
      )}

      <ul className="space-y-3">
        {initialScripts.map((script) =>
          editingId === script.id ? (
            <li key={script.id}>
              <ScriptEditor
                draft={draft}
                locked={isSandbox}
                onCancel={() => setEditingId(null)}
                onChange={setDraft}
                onSave={() => run(() => updateSiteScript(script.id, draft))}
                saving={isPending}
                title={`Editing “${script.name}”`}
              />
            </li>
          ) : (
            <li
              key={script.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{script.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      script.is_active
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {script.is_active ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {script.placement}
                  </span>
                </div>
                {script.description && (
                  <p className="text-sm text-muted-foreground">{script.description}</p>
                )}
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {script.src || `${script.code.slice(0, 90)}${script.code.length > 90 ? '…' : ''}`}
                </p>
                <SafetyReview review={reviewScriptCode({ code: script.code, src: script.src })} />
              </div>

              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPending || isSandbox}
                  aria-describedby={describedBySandboxNote}
                  onClick={() => run(() => setSiteScriptActive(script.id, !script.is_active))}
                >
                  {script.is_active ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => startEdit(script)}>
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isPending || isSandbox}
                  aria-describedby={describedBySandboxNote}
                  onClick={() => {
                    if (!window.confirm(`Delete “${script.name}”? This cannot be undone.`)) return;
                    run(() => deleteSiteScript(script.id));
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          )
        )}
      </ul>

      <RevisionHistory
        locked={isSandbox}
        pending={isPending}
        revisions={initialRevisions}
        onRestore={(revisionId, label) => {
          if (!window.confirm(`Restore “${label}”? The current version is kept in the history.`)) return;
          run(() => revertSiteScript(revisionId));
        }}
      />
    </div>
  );
}
