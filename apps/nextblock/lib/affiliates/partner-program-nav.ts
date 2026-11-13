/**
 * The partner program's two seeded navigation links (migration 02034): "Become a partner" in the
 * header and "Partner program" in the footer, in English and French. The EN and FR rows of each
 * menu share one fixed translation group, so the CMS pairs them and deletes them together, and the
 * code below recognises them whatever label, URL or order an operator gave them in /cms/navigation.
 *
 * - The root layout drops both groups, and every row nested under them, while the program is
 *   inactive (`hideDormantPartnerProgramNav` with `isAffiliatesProgramActive()`), so a site without
 *   Affiliates and Commerce Pro never links a /partners page that would 404.
 * - ResponsiveNav renders the header row as a highlighted pill with a "New" badge, and
 *   FooterNavigation gives the footer row the same badge.
 *
 * Keyed on the groups, never on the URL: a site's own `/partners` CMS page keeps its own plain
 * link, shown whatever the package state. Dependency-free on purpose (no imports at all), like
 * `partners-paths.ts`: the layout (server) and the header and footer (client) share it.
 * `partner-program-nav.test.ts` pins the ids, URLs and labels to the migration.
 */

/** The fixed `navigation_items.translation_group_id` of each seeded partner program link (02034). */
export const PARTNER_PROGRAM_NAV_GROUP_IDS = {
  header: 'e130cf70-04d2-4201-ba44-f8ac22fc071b',
  footer: '78a4685e-c6ee-4065-9e8b-b257887256f9',
} as const;

/** The part of a navigation row the helpers below read. */
export interface PartnerProgramNavRow {
  readonly translation_group_id?: string | null;
}

/** A navigation row with what the dormant filter needs to follow its children. */
export interface PartnerProgramNavTreeRow extends PartnerProgramNavRow {
  readonly id: number | string;
  readonly parent_id?: number | string | null;
}

function groupOf(item: PartnerProgramNavRow | null | undefined): string {
  const group = item?.translation_group_id;
  return typeof group === 'string' ? group.trim().toLowerCase() : '';
}

/** True for either seeded partner program link (the header or the footer group), in any language. */
export function isPartnerProgramNavItem(item: PartnerProgramNavRow | null | undefined): boolean {
  const group = groupOf(item);
  return group === PARTNER_PROGRAM_NAV_GROUP_IDS.header || group === PARTNER_PROGRAM_NAV_GROUP_IDS.footer;
}

/** True for the seeded header link ("Become a partner" / "Devenir partenaire"), in any language. */
export function isPartnerProgramHeaderItem(item: PartnerProgramNavRow | null | undefined): boolean {
  return groupOf(item) === PARTNER_PROGRAM_NAV_GROUP_IDS.header;
}

/**
 * One menu's rows as visitors may see them: every row while the program runs. While it does not,
 * the seeded partner program rows go, and so does every row nested under them, at any depth:
 * ResponsiveNav's `buildHierarchy` promotes a row whose parent is missing to the top level, so a
 * child left behind would show up as a link of its own. Order is kept; the input is not changed.
 */
export function hideDormantPartnerProgramNav<T extends PartnerProgramNavTreeRow>(items: readonly T[], active: boolean): T[] {
  if (active) return [...items];

  const hidden = new Set<string>();
  for (const item of items) {
    if (isPartnerProgramNavItem(item)) hidden.add(String(item.id));
  }
  if (hidden.size === 0) return [...items];

  // Each pass hides the children of the rows hidden so far. A pass that hides nothing ends the
  // loop, so a parent_id cycle cannot spin forever.
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      const parentId = item.parent_id;
      if (parentId === null || parentId === undefined) continue;
      const id = String(item.id);
      if (!hidden.has(id) && hidden.has(String(parentId))) {
        hidden.add(id);
        grew = true;
      }
    }
  }

  return items.filter((item) => !hidden.has(String(item.id)));
}
