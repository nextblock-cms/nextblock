import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AFFILIATE_TIER_GOAL_MAX_LENGTH } from './constants';

/**
 * Migration 02033 (per-tier goals) against the contract the CMS relies on: the goal CHECK uses
 * AFFILIATE_TIER_GOAL_MAX_LENGTH (the tier action's zod limit and the textareas' maxLength), and the
 * seed fills only the launch tiers of 02030, in English and French, without ever overwriting a goal
 * an operator wrote. Same approach as sql-parity.test.ts (02030).
 */
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/src/supabase/migrations');

function readMigration(file: string): string {
  const full = path.join(MIGRATIONS, file);
  return existsSync(full) ? readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : '';
}

const sql = readMigration('02033_affiliate_tier_goals.sql');
const schema = readMigration('02030_affiliates_schema.sql');

/** A SQL string literal's body ('' unescaped). */
const SQL_STRING = "'((?:[^']|'')*)'";
const unquote = (body: string) => body.replace(/''/g, "'");

/** The slugs 02030 seeds (its `INSERT INTO public.affiliate_tiers … ON CONFLICT`). */
function launchSlugs(): string[] {
  const insert = schema.match(/INSERT INTO public\.affiliate_tiers[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/)?.[1] ?? '';
  return [...insert.matchAll(/'\{[^']*\}'::jsonb,\s*'([^']+)'/g)].map((match) => match[1] as string);
}

/** The `(slug, goal_en, goal_fr)` rows of the seed UPDATE. */
function seededGoals(): Array<{ slug: string; en: string; fr: string }> {
  const values = sql.match(/FROM \(VALUES([\s\S]*?)\) AS s \(slug, goal_en, goal_fr\)/)?.[1] ?? '';
  const row = new RegExp(`\\(${SQL_STRING},\\s*${SQL_STRING},\\s*${SQL_STRING}\\)`, 'g');
  return [...values.matchAll(row)].map(([, slug, en, fr]) => ({
    slug: unquote(slug as string),
    en: unquote(en as string),
    fr: unquote(fr as string),
  }));
}

describe.skipIf(!sql || !schema)('02033_affiliate_tier_goals.sql', () => {
  it('caps the goal at AFFILIATE_TIER_GOAL_MAX_LENGTH characters', () => {
    const check = sql.match(
      /ADD CONSTRAINT affiliate_tiers_goal_check\s+CHECK \(goal IS NULL OR char_length\(btrim\(goal\)\) BETWEEN 1 AND (\d+)\)/
    );
    expect(check?.[1]).toBe(String(AFFILIATE_TIER_GOAL_MAX_LENGTH));
  });

  it('seeds a non-empty English and French goal for launch tiers of 02030 only', () => {
    const slugs = launchSlugs();
    expect(slugs).toEqual(['starter-partner', 'growth-partner', 'elite-partner', 'founding-ambassador']);

    const goals = seededGoals();
    expect(goals.length).toBeGreaterThan(0);
    expect(new Set(goals.map((goal) => goal.slug)).size).toBe(goals.length);
    for (const goal of goals) {
      expect(slugs, goal.slug).toContain(goal.slug);
      for (const text of [goal.en, goal.fr]) {
        expect(text.trim(), goal.slug).not.toBe('');
        expect(text.length, goal.slug).toBeLessThanOrEqual(AFFILIATE_TIER_GOAL_MAX_LENGTH);
        // Plain spaces only (the display helper adds the no-break spaces) and no backslash: the
        // bundles embed this SQL in TS strings.
        expect(text, goal.slug).not.toMatch(/[^\S ]|\\/);
      }
    }
  });

  it('never overwrites a goal: the seed matches a tier by slug, and only while its goal is NULL', () => {
    const update = sql.match(/UPDATE public\.affiliate_tiers AS t[\s\S]*?;/)?.[0] ?? '';
    expect(update).toMatch(/WHERE t\.slug = s\.slug\s+AND t\.goal IS NULL;$/);
    expect(update).not.toMatch(/\bt\.id\b/);
    // The French goal is added only where none is set yet.
    expect(update).toContain("WHEN nullif(btrim(t.goal_translations ->> 'fr'), '') IS NULL");
  });

  it('seeds generic wording for every store: no product name and no person', () => {
    for (const goal of seededGoals()) {
      expect(`${goal.en} ${goal.fr}`, goal.slug).not.toMatch(/\b(?:CEO|PDG|modules?|packages?|NextBlock)\b/i);
    }
  });

  it("gives nextblock.dev its own wording only, and only from the exact seeded text", () => {
    const block = sql.match(/DO \$nb_02033_vendor_goals\$([\s\S]*?)\$nb_02033_vendor_goals\$;/)?.[1] ?? '';
    // Vendor only: returns unless the store carries the Commerce Pro license product (as 02032).
    expect(block).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.products WHERE freemius_product_id = '24851'\) THEN\s+RETURN;/);
    // Both languages must still read exactly as seeded.
    expect(block).toMatch(/AND t\.goal = v\.seeded_en\s+AND t\.goal_translations ->> 'fr' = v\.seeded_fr;/);
    expect(block).not.toMatch(/\bt\.id\b/);

    // Each vendor row starts from the generic seed of the same tier.
    const seeded = new Map(seededGoals().map((goal) => [goal.slug, goal]));
    const row = new RegExp(`\\(${SQL_STRING},\\s*${SQL_STRING},\\s*${SQL_STRING},\\s*${SQL_STRING},\\s*${SQL_STRING}\\)`, 'g');
    const rows = [...block.matchAll(row)].map((match) => match.slice(1).map((body) => unquote(body as string)));
    expect(rows.map(([slug]) => slug)).toEqual(['growth-partner', 'elite-partner']);
    for (const [slug, seededEn, seededFr, goalEn, goalFr] of rows) {
      expect(seededEn).toBe(seeded.get(slug as string)?.en);
      expect(seededFr).toBe(seeded.get(slug as string)?.fr);
      for (const text of [goalEn as string, goalFr as string]) {
        expect(text.length).toBeLessThanOrEqual(AFFILIATE_TIER_GOAL_MAX_LENGTH);
        expect(text).not.toMatch(/[^\S ]|\\/);
      }
    }
  });
});
