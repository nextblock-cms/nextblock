'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { AFFILIATE_CMS_PATH, AFFILIATE_TIER_GOAL_MAX_LENGTH, type AffiliateBadgeColor } from '@nextblock-cms/affiliates';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmationDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { deleteAffiliateTier, upsertAffiliateTier } from '../actions';
import { AFFILIATE_BADGE_COLOR_LABEL, AFFILIATE_TIER_BADGE_CLASS, AFFILIATE_TIER_SWATCH_CLASS } from './labels';
import { useAffiliateAdminAction } from './use-admin-action';

export interface TierManagerRow {
  id: string;
  name: string;
  nameFr: string;
  /** The goal shown under the tier on /partners (English); '' = no goal line. Display only. */
  goal: string;
  /** Its French translation; '' = French pages show the English goal. */
  goalFr: string;
  slug: string;
  commissionPercentage: number;
  cookieDurationDays: number;
  clearanceHoldDays: number;
  maxAmbassadorsCap: number | null;
  memberCount: number;
  sortOrder: number;
  badgeColor: AffiliateBadgeColor;
  isLimitedTimePromo: boolean;
  isDefaultSignupTier: boolean;
  isActive: boolean;
}

/** The badge colours, in the order of the 02030 CHECK constraint. */
const BADGE_COLORS: readonly AffiliateBadgeColor[] = ['violet', 'indigo', 'blue', 'sky', 'emerald', 'amber', 'orange', 'rose', 'slate'];

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

interface TierDraft {
  name: string;
  nameFr: string;
  goal: string;
  goalFr: string;
  slug: string;
  commissionPercentage: string;
  cookieDurationDays: string;
  clearanceHoldDays: string;
  maxAmbassadorsCap: string;
  sortOrder: string;
  badgeColor: AffiliateBadgeColor;
  isLimitedTimePromo: boolean;
  isDefaultSignupTier: boolean;
  isActive: boolean;
}

function draftFrom(tier: TierManagerRow | null, nextSortOrder: number): TierDraft {
  if (!tier) {
    return {
      name: '',
      nameFr: '',
      goal: '',
      goalFr: '',
      slug: '',
      commissionPercentage: '10',
      cookieDurationDays: '30',
      clearanceHoldDays: '30',
      maxAmbassadorsCap: '',
      sortOrder: String(nextSortOrder),
      badgeColor: 'violet',
      isLimitedTimePromo: false,
      isDefaultSignupTier: false,
      isActive: true,
    };
  }
  return {
    name: tier.name,
    nameFr: tier.nameFr,
    goal: tier.goal,
    goalFr: tier.goalFr,
    slug: tier.slug,
    commissionPercentage: String(tier.commissionPercentage),
    cookieDurationDays: String(tier.cookieDurationDays),
    clearanceHoldDays: String(tier.clearanceHoldDays),
    maxAmbassadorsCap: tier.maxAmbassadorsCap === null ? '' : String(tier.maxAmbassadorsCap),
    sortOrder: String(tier.sortOrder),
    badgeColor: tier.badgeColor,
    isLimitedTimePromo: tier.isLimitedTimePromo,
    isDefaultSignupTier: tier.isDefaultSignupTier,
    isActive: tier.isActive,
  };
}

function whole(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function formatRate(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

interface TierPartnersSummary {
  full: boolean;
  /** The first line, joined with " · ": "12 of 50 spots taken", "3 partners · No cap", "No partners yet". */
  counts: string[];
  /** The spots left under a cap, or the tier new partners join once this one is full. */
  note: string | null;
  /** The whole cell as one phrase for screen readers: "12 of 50 spots taken, 38 left". */
  label: string;
}

/**
 * The Partners cell. `memberCount` is live (a trigger on `affiliate_profiles` keeps it) and counts
 * every partner in the tier, paused (SUSPENDED) ones included. A full tier names the tier new partners join
 * instead: the signup tier, picked by `selectAffiliateSignupTier` as the signup RPC does.
 */
function describeTierPartners(tier: TierManagerRow, signupTierName: string | null): TierPartnersSummary {
  const count = Math.max(0, tier.memberCount);
  const cap = tier.maxAmbassadorsCap;
  const full = cap !== null && count >= cap;

  let counts: string[];
  let note: string | null = null;
  if (cap === null) {
    counts = [count === 0 ? 'No partners yet' : `${count} ${count === 1 ? 'partner' : 'partners'}`, 'No cap'];
  } else {
    counts = [count === 0 ? 'No partners yet' : `${count} of ${cap} spots taken`];
    if (full) note = signupTierName ? `New partners join ${signupTierName}` : null;
    else note = count === 0 ? `${cap} ${cap === 1 ? 'spot' : 'spots'} left` : `${cap - count} left`;
  }

  const phrases = [full ? 'Full' : null, ...counts, note].filter((phrase): phrase is string => Boolean(phrase));
  const label = phrases
    .map((phrase, index) => (index === 0 ? phrase : `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`))
    .join(', ');
  return { full, counts, note, label };
}

function TierFormDialog({
  open,
  onOpenChange,
  tier,
  nextSortOrder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tier: TierManagerRow | null;
  nextSortOrder: number;
}) {
  const { run, isPending } = useAffiliateAdminAction();
  const [draft, setDraft] = useState<TierDraft>(() => draftFrom(tier, nextSortOrder));
  const baseId = useId();
  const id = (name: string) => `${baseId}-${name}`;

  const set = <K extends keyof TierDraft>(key: K, value: TierDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const capValue = draft.maxAmbassadorsCap.trim();
  const capBelowMembers = tier !== null && capValue !== '' && Number(capValue) < tier.memberCount;
  // The action refuses a French goal without the English one (it would show on French pages only).
  const goalFrAlone = draft.goalFr.trim() !== '' && draft.goal.trim() === '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                upsertAffiliateTier({
                  tierIdToUpdate: tier?.id ?? null,
                  name: draft.name,
                  nameFr: draft.nameFr,
                  goal: draft.goal,
                  goalFr: draft.goalFr,
                  slug: draft.slug,
                  commissionPercentage: Number(draft.commissionPercentage),
                  cookieDurationDays: whole(draft.cookieDurationDays),
                  clearanceHoldDays: whole(draft.clearanceHoldDays),
                  maxAmbassadorsCap: capValue === '' ? null : Number(capValue),
                  isLimitedTimePromo: draft.isLimitedTimePromo,
                  isDefaultSignupTier: draft.isDefaultSignupTier,
                  badgeColor: draft.badgeColor,
                  sortOrder: whole(draft.sortOrder),
                  isActive: draft.isActive,
                }),
              { onSuccess: () => onOpenChange(false) }
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{tier ? `Edit ${tier.name}` : 'New tier'}</DialogTitle>
            <DialogDescription>
              Rate and hold changes apply to orders paid from now on; commissions already recorded keep the rate they were
              earned at.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={id('name')}>Name (English)</Label>
              <Input id={id('name')} value={draft.name} maxLength={80} required onChange={(event) => set('name', event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('name-fr')}>Name (French)</Label>
              <Input
                id={id('name-fr')}
                lang="fr"
                value={draft.nameFr}
                maxLength={80}
                aria-describedby={id('name-fr-help')}
                onChange={(event) => set('nameFr', event.target.value)}
              />
              <p id={id('name-fr-help')} className="text-xs text-muted-foreground">
                Shown on French pages. Empty uses the English name.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('goal')}>Goal (English)</Label>
              <Textarea
                id={id('goal')}
                rows={2}
                className="min-h-0"
                value={draft.goal}
                maxLength={AFFILIATE_TIER_GOAL_MAX_LENGTH}
                aria-describedby={id('goal-help')}
                onChange={(event) => set('goal', event.target.value)}
              />
              <p id={id('goal-help')} className="text-xs text-muted-foreground">
                Shown under the tier on the partners page. Empty hides it. Display only: reaching a goal moves nobody. You change a
                partner’s tier yourself.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('goal-fr')}>Goal (French)</Label>
              <Textarea
                id={id('goal-fr')}
                lang="fr"
                rows={2}
                className="min-h-0"
                value={draft.goalFr}
                maxLength={AFFILIATE_TIER_GOAL_MAX_LENGTH}
                aria-describedby={id('goal-fr-help')}
                onChange={(event) => set('goalFr', event.target.value)}
              />
              <p
                id={id('goal-fr-help')}
                className={cn('text-xs', goalFrAlone ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}
              >
                {goalFrAlone
                  ? 'Write the English goal too: a French goal alone would show on French pages only.'
                  : 'Shown on French pages. Empty uses the English goal.'}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('slug')}>Slug</Label>
              <Input
                id={id('slug')}
                value={draft.slug}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                spellCheck={false}
                autoComplete="off"
                aria-describedby={id('slug-help')}
                placeholder={tier ? undefined : 'Derived from the name'}
                onChange={(event) => set('slug', event.target.value.toLowerCase())}
              />
              <p id={id('slug-help')} className="text-xs text-muted-foreground">
                Lowercase letters, digits and dashes. Unique.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('rate')}>Commission (%)</Label>
              <Input
                id={id('rate')}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="0.01"
                required
                value={draft.commissionPercentage}
                onChange={(event) => set('commissionPercentage', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('cookie')}>Referral window (days)</Label>
              <Input
                id={id('cookie')}
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                step={1}
                required
                value={draft.cookieDurationDays}
                aria-describedby={id('cookie-help')}
                onChange={(event) => set('cookieDurationDays', event.target.value)}
              />
              <p id={id('cookie-help')} className="text-xs text-muted-foreground">
                How long a referral link or storefront visit keeps crediting the partner.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('hold')}>Clearance hold (days)</Label>
              <Input
                id={id('hold')}
                type="number"
                inputMode="numeric"
                min={0}
                max={365}
                step={1}
                required
                value={draft.clearanceHoldDays}
                aria-describedby={id('hold-help')}
                onChange={(event) => set('clearanceHoldDays', event.target.value)}
              />
              <p id={id('hold-help')} className="text-xs text-muted-foreground">
                Refund protection: a commission is paid out only after this many days.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('cap')}>Partner cap</Label>
              <Input
                id={id('cap')}
                type="number"
                inputMode="numeric"
                min={0}
                max={1000000}
                step={1}
                value={draft.maxAmbassadorsCap}
                placeholder="Unlimited"
                aria-describedby={id('cap-help')}
                onChange={(event) => set('maxAmbassadorsCap', event.target.value)}
              />
              <p id={id('cap-help')} className={cn('text-xs', capBelowMembers ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                {capBelowMembers
                  ? `Below the ${tier?.memberCount ?? 0} partners already in this tier: it will be full. Nobody is removed.`
                  : 'Empty means unlimited. When the tier is full, new partners join the next tier.'}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('sort')}>Sort order</Label>
              <Input
                id={id('sort')}
                type="number"
                inputMode="numeric"
                min={-10000}
                max={10000}
                step={1}
                required
                value={draft.sortOrder}
                aria-describedby={id('sort-help')}
                onChange={(event) => set('sortOrder', event.target.value)}
              />
              <p id={id('sort-help')} className="text-xs text-muted-foreground">
                Lower comes first on the tier ladder; among default signup tiers, new partners fill the highest first.
              </p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={id('color')}>Badge colour</Label>
              <div className="flex items-center gap-3">
                <select
                  id={id('color')}
                  className={SELECT_CLASS}
                  value={draft.badgeColor}
                  onChange={(event) => set('badgeColor', event.target.value as AffiliateBadgeColor)}
                >
                  {BADGE_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {AFFILIATE_BADGE_COLOR_LABEL[color]}
                    </option>
                  ))}
                </select>
                <Badge variant="outline" className={cn('shrink-0', AFFILIATE_TIER_BADGE_CLASS[draft.badgeColor])}>
                  {draft.name.trim() || 'Preview'}
                </Badge>
              </div>
            </div>
          </div>

          <fieldset className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium text-foreground">Options</legend>
            {(
              [
                ['isActive', 'Active', 'Inactive tiers take no new partners and are hidden on the partners page.'],
                [
                  'isDefaultSignupTier',
                  'Default signup tier',
                  'New partners join the default tier with the highest sort order that still has room, then the next one.',
                ],
                [
                  'isLimitedTimePromo',
                  'Limited-time promo',
                  'Featured with an urgency badge and the spots left on the partners page while it is the tier new partners join.',
                ],
              ] as const
            ).map(([key, label, help]) => (
              <div key={key} className="flex items-start gap-3">
                <Checkbox
                  id={id(key)}
                  checked={draft[key]}
                  onCheckedChange={(checked) => set(key, checked === true)}
                  aria-describedby={id(`${key}-help`)}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label htmlFor={id(key)}>{label}</Label>
                  <p id={id(`${key}-help`)} className="text-xs text-muted-foreground">
                    {help}
                  </p>
                </div>
              </div>
            ))}
          </fieldset>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : tier ? 'Save tier' : 'Create tier'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The tiers table with create / edit / delete. `signupTierId` is the tier a new partner joins
 * (`selectAffiliateSignupTier` on the server, the rule `/partners` and the signup RPC use), or null
 * when no active tier has room.
 */
export function TiersManager({ tiers, signupTierId }: { tiers: TierManagerRow[]; signupTierId: string | null }) {
  const { run, isPending } = useAffiliateAdminAction();
  const [editing, setEditing] = useState<{ tier: TierManagerRow | null; key: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TierManagerRow | null>(null);
  const nextSortOrder = tiers.reduce((max, tier) => Math.max(max, tier.sortOrder), 0) + 1;
  const signupTierName = tiers.find((tier) => tier.id === signupTierId)?.name ?? null;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing({ tier: null, key: Date.now() })}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New tier
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <caption className="sr-only">Commission tiers</caption>
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Tier</th>
              <th scope="col" className="px-4 py-3 font-medium">Commission</th>
              <th scope="col" className="px-4 py-3 font-medium">Referral window</th>
              <th scope="col" className="px-4 py-3 font-medium">Clearance hold</th>
              <th scope="col" className="px-4 py-3 font-medium">Partners</th>
              <th scope="col" className="px-4 py-3 font-medium">Sort</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tiers.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No tiers yet. Create one so partners can sign up.
                </td>
              </tr>
            ) : (
              tiers.map((tier) => {
                const partners = describeTierPartners(tier, signupTierName);
                return (
                  <tr key={tier.id} className={cn(!tier.isActive && 'bg-muted/30')}>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', AFFILIATE_TIER_SWATCH_CLASS[tier.badgeColor])} aria-hidden="true" />
                        <span className="font-medium text-foreground">{tier.name}</span>
                        {tier.isDefaultSignupTier ? (
                          <Badge variant="outline" className="border-transparent bg-primary/10 text-primary">Default</Badge>
                        ) : null}
                        {tier.isLimitedTimePromo ? (
                          <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-700/30 dark:text-amber-200">
                            Promo
                          </Badge>
                        ) : null}
                        {tier.id === signupTierId ? (
                          <Badge
                            variant="outline"
                            className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-700/30 dark:text-emerald-200"
                          >
                            New partners join here
                          </Badge>
                        ) : null}
                        {!tier.isActive ? (
                          <Badge variant="outline" className="border-transparent bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200">
                            Inactive
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">{tier.slug}</span>
                        {tier.nameFr ? (
                          <>
                            {' · '}
                            <span lang="fr">{tier.nameFr}</span>
                          </>
                        ) : null}
                      </div>
                      {tier.goal ? (
                        <p className="mt-1 max-w-xs truncate text-xs text-muted-foreground" title={tier.goal}>
                          Goal: {tier.goal}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top font-medium tabular-nums">{formatRate(tier.commissionPercentage)}</td>
                    <td className="px-4 py-3 align-top tabular-nums">{tier.cookieDurationDays} days</td>
                    <td className="px-4 py-3 align-top tabular-nums">{tier.clearanceHoldDays} days</td>
                    <td className="px-4 py-3 align-top" aria-label={partners.label}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {partners.full ? (
                          <Badge variant="outline" className="border-transparent bg-red-100 text-red-800 dark:bg-red-700/30 dark:text-red-200">
                            Full
                          </Badge>
                        ) : null}
                        <span className="tabular-nums text-foreground">{partners.counts.join(' · ')}</span>
                      </div>
                      {partners.note ? <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{partners.note}</div> : null}
                      {tier.memberCount > 0 ? (
                        <Link
                          href={`${AFFILIATE_CMS_PATH}?tier=${encodeURIComponent(tier.id)}`}
                          className="mt-1 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
                        >
                          View partners<span className="sr-only"> in {tier.name}</span>
                        </Link>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top tabular-nums">{tier.sortOrder}</td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEditing({ tier, key: Date.now() })}
                          aria-label={`Edit ${tier.name}`}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={isPending || tier.memberCount > 0}
                          title={tier.memberCount > 0 ? 'Tiers with partners cannot be deleted. Deactivate the tier instead.' : undefined}
                          onClick={() => setPendingDelete(tier)}
                          aria-label={
                            tier.memberCount > 0
                              ? `Delete ${tier.name} (unavailable: the tier has partners; deactivate it instead)`
                              : `Delete ${tier.name}`
                          }
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Partner counts are live: they change as partners join, move or leave. Paused partners keep their spot, and count toward the
        cap, until you move them to another tier or remove them. A tier with partners cannot be deleted: deactivate it to stop new
        signups, or move its partners from the Overview first.
      </p>

      {editing ? (
        <TierFormDialog
          key={editing.key}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          tier={editing.tier}
          nextSortOrder={nextSortOrder}
        />
      ) : null}

      <ConfirmationDialog
        isOpen={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : 'Delete tier?'}
        description="The tier has no partners. Deleting it cannot be undone; deactivating keeps it for later."
        confirmText="Delete tier"
        isDestructive
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) run(() => deleteAffiliateTier({ tierIdToDelete: target.id }));
        }}
      />
    </div>
  );
}
