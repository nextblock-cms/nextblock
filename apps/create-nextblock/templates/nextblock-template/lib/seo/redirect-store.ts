/**
 * The database side of managed redirects: reading `public.cms_redirects` and
 * turning its rows into the pure `RedirectRule` shape the SEO engine understands.
 *
 * This module exists as its own file, separate from `proxy.ts`, for one reason:
 * the proxy cannot be unit tested. It is a Next.js entry point that receives a
 * real `NextRequest` and returns a `NextResponse`, and everything interesting it
 * does about redirects — deciding whether a path is even worth a lookup, deciding
 * what a malformed row should become, deciding whether a read failure means "no
 * redirects" or "we could not tell" — is ordinary logic that deserves ordinary
 * tests. So all of that logic lives here, behind plain functions over plain
 * values, and `proxy.ts` keeps only the request/response plumbing plus the cache.
 *
 * WHY THE ROW TYPE IS HAND-WRITTEN. `libs/db`'s generated `Database` type is
 * produced by `npm run db:types` against a live Supabase project. The migration
 * that created `cms_redirects` (originally 00000000000030_seo_redirects_and_robots.sql,
 * now part of 02001_baseline_schema.sql) was
 * committed before it was applied, so the generated type did not contain
 * the table and `Database['public']['Tables']['cms_redirects']` would not compile.
 * Writing the row shape by hand from the migration's DDL keeps this file building
 * today; once the migration is applied and the types are regenerated, this
 * interface becomes a redundant-but-harmless restatement of the generated one, and
 * the columns it names are exactly the columns the SELECT below asks for, so a
 * drift between the two would show up as a failing query rather than as silently
 * wrong data.
 *
 * NOTHING HERE THROWS. Every export is either pure or wrapped in a try/catch that
 * degrades to a safe value. The only caller on the hot path is the Next.js proxy,
 * which runs in front of every request on the site: an exception escaping into it
 * does not produce a broken redirect, it produces a 500 for every page, every
 * asset and every API route at once. "Fail open, serve the page" is the only
 * acceptable failure mode for a redirect lookup.
 */

import {
  normalizeRedirectPath,
  type RedirectRule,
  type RedirectStatusCode,
} from '@nextblock-cms/utils/seo';

/** The table the proxy and the admin screen both read. */
export const CMS_REDIRECTS_TABLE = 'cms_redirects';

/**
 * The columns fetched for a proxy lookup. `created_at` / `updated_at` are
 * deliberately not selected: the proxy never shows them, and a redirect lookup
 * sits in front of every page render, so there is no reason to move bytes that
 * nothing on this path reads.
 */
const REDIRECT_LOOKUP_COLUMNS = 'id, source_path, destination_path, status_code, is_active';

/**
 * A row of `public.cms_redirects`, transcribed from the migration's DDL.
 *
 * Every column is NOT NULL in Postgres, which is why none of these are optional —
 * but `mapRedirectRow` still validates each one at runtime rather than trusting
 * this declaration, because the value actually arriving here came over the wire
 * from PostgREST and a TypeScript interface asserts nothing about it.
 */
export interface CmsRedirectRow {
  created_at: string;
  destination_path: string;
  id: string;
  is_active: boolean;
  source_path: string;
  status_code: number;
  updated_at: string;
}

/**
 * The minimal shape `fetchActiveRedirects` needs from a Supabase client.
 *
 * Typing the parameter structurally rather than as `SupabaseClient` is what makes
 * this function testable without a network or a running database: a test passes an
 * object literal with a `from` method. It also keeps the module honest about how
 * little it actually uses — one table, one filter, no auth, no realtime.
 */
export interface RedirectQueryClient {
  from: (table: string) => any;
}

/**
 * Coerces whatever the `status_code` column produced into one of the two codes
 * the redirect engine models.
 *
 * The database already constrains this to 301 or 302, so in practice the fallback
 * never fires. It exists because the alternative — returning `null` and dropping
 * the rule — would mean a single unexpected value silently un-publishes a redirect
 * an operator can plainly see in the admin list. Defaulting to 301 keeps the rule
 * working, and permanent-rather-than-temporary matches what every row in the table
 * already is by default.
 *
 * Numeric strings are accepted because a jsonb round trip or a hand-written import
 * can turn `301` into `"301"`, and refusing that would be pedantry rather than
 * safety.
 */
function coerceRedirectStatusCode(value: unknown): RedirectStatusCode {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return numeric === 302 ? 302 : 301;
}

/**
 * Maps one database row onto the engine's camelCase `RedirectRule`, or returns
 * `null` when the row cannot be trusted.
 *
 * Malformed means "a field the redirect cannot work without is missing or is not a
 * string": an id we could not report in an error, a source we could not match, or a
 * destination we could not send anyone to. Those rows are dropped individually
 * rather than failing the whole load, so one bad row cannot take every other
 * redirect on the site offline with it.
 *
 * `is_active` is read as "anything other than an explicit `false` counts as active".
 * The query already filters on `is_active = true`, so this only decides the outcome
 * for a row that arrived through some other path (a test, or a future admin-side
 * reader that wants inactive rules too), and treating an absent flag as active
 * matches the column's `DEFAULT true`.
 */
export function mapRedirectRow(row: unknown): RedirectRule | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return null;
  }

  const candidate = row as Record<string, unknown>;
  const id = candidate['id'];
  const sourcePath = candidate['source_path'];
  const destinationPath = candidate['destination_path'];

  if (typeof id !== 'string' || id.trim() === '') {
    return null;
  }
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    return null;
  }
  if (typeof destinationPath !== 'string' || destinationPath.trim() === '') {
    return null;
  }

  return {
    destinationPath: destinationPath.trim(),
    id,
    isActive: candidate['is_active'] !== false,
    sourcePath: sourcePath.trim(),
    statusCode: coerceRedirectStatusCode(candidate['status_code']),
  };
}

/**
 * A Supabase/PostgREST error that means the table itself is absent — i.e. the
 * schema was never applied.
 *
 * This is NOT a transient hiccup: it is the signature of a fresh, unprovisioned
 * deploy (env injected, migrations not yet run), or — for `cms_redirects`
 * specifically — of an existing install that has pulled the code but not yet run
 * `npm run db:migrate`. Both are steady states that can last for days, so a caller
 * must be able to tell them apart from a database that is merely busy and back off
 * accordingly instead of hammering a table that does not exist.
 *
 * 42P01 = undefined_table (Postgres); PGRST205 = PostgREST "table not in schema
 * cache". The message sniffing underneath is there because PostgREST does not
 * always populate `code` on a schema-cache miss, and a wrong answer here is cheap
 * in both directions: at worst we negative-cache a transient failure for a few
 * seconds.
 *
 * This lives here rather than in `proxy.ts` because both the redirect lookup and
 * the proxy's existing `is_admin_created` probe need exactly this test, and two
 * copies of a predicate that decides whether a site funnels all its traffic to
 * /setup is one copy too many.
 */
export function isSchemaMissingError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) {
    return false;
  }

  const code = error.code ?? '';
  if (code === '42P01' || code === 'PGRST205') {
    return true;
  }

  const message = (error.message ?? '').toLowerCase();
  return (
    message.includes('does not exist') ||
    message.includes('schema cache') ||
    message.includes('could not find the table')
  );
}

/**
 * Loads every active redirect rule.
 *
 * The three-valued return is the whole point of this function, so it is worth
 * being explicit about it:
 *
 *  - `[]` means "the table is readable and there are no active redirects". Almost
 *    every site is in this state, and it is a *positive* answer: the caller may
 *    cache it for as long as it caches a real rule set.
 *  - `null` means "we could not read". The table may be missing (migration not yet
 *    applied), the database may be down, PostgREST may have hiccuped. The caller
 *    must NOT treat this as "no redirects, and here is a nice long cache entry" —
 *    it should negative-cache briefly and retry, so redirects start working within
 *    seconds of the migration landing rather than a minute later.
 *  - A non-empty array is the rule set.
 *
 * Collapsing those two empty-ish cases into one would be the classic bug: an
 * unmigrated install would look identical to a migrated one with no rules, and the
 * moment a real outage began the site would cheerfully cache "no redirects" for
 * the full success TTL.
 *
 * The function never throws. A PostgREST error object, a rejected promise and a
 * client that blows up mid-chain all become `null`.
 */
export async function fetchActiveRedirects(
  supabase: RedirectQueryClient,
): Promise<RedirectRule[] | null> {
  try {
    const { data, error } = await supabase
      .from(CMS_REDIRECTS_TABLE)
      .select(REDIRECT_LOOKUP_COLUMNS)
      .eq('is_active', true);

    // A missing table and a transient failure land in the same place on purpose:
    // this caller's only question is "can I trust an empty result?", and the answer
    // is no either way. `isSchemaMissingError` is exported for the callers that DO
    // need to distinguish (the proxy's provisioning gate), not for this one.
    if (error) {
      return null;
    }

    // A null/undefined `data` with no error is not something PostgREST does for a
    // list query — it returns `[]` — so if it happens, something has gone wrong
    // enough that "I could not read this" is the truthful answer.
    if (!Array.isArray(data)) {
      return null;
    }

    const rules: RedirectRule[] = [];
    for (const row of data) {
      const rule = mapRedirectRow(row);
      if (rule !== null) {
        rules.push(rule);
      }
    }

    return rules;
  } catch {
    return null;
  }
}

/**
 * Path prefixes that can never be a redirect source, checked before any database
 * work happens.
 *
 * This guard is doing far more work than it looks like it is. The proxy matcher is
 * `/((?!_next/static|_next/image|favicon.ico|auth/.*|api/auth/.*|api/revalidate|api/revalidate-log).*)`,
 * which is an exclusion list of six specific paths — meaning the proxy runs on
 * essentially EVERYTHING else: every API route, every dynamically served image,
 * every font, every `.map` file a browser asks for. Without this filter a single
 * page view would fire a redirect lookup for the document and then again for each
 * of its subresources, and while the module-level cache in `proxy.ts` absorbs most
 * of that, the cold-start burst on every new worker would not be absorbed at all.
 *
 * It is also a correctness guard, not only a performance one. `/cms` and `/setup`
 * are administrative surfaces where an operator-authored redirect could lock an
 * admin out of the very screen they would use to delete it, and `/api` routes are
 * called by code that follows redirects blindly.
 */
const REDIRECT_SKIP_PREFIXES = [
  '/cms',
  '/api',
  '/_next',
  '/setup',
  '/auth',
  '/images',
  '/favicon',
  '/robots.txt',
  '/sitemap',
] as const;

/**
 * True when a request path must not be looked up in the redirect table at all.
 *
 * Prefix matching is deliberately boundary-aware (`/setup` and `/setup/...`, never
 * `/setup-guide`): the skip list is a list of reserved namespaces, not a list of
 * string prefixes, and swallowing `/images-of-our-team` because it starts with
 * `/images` would make a legitimate content URL permanently unredirectable for a
 * reason no operator could ever guess.
 *
 * The final rule catches the long tail of static assets (`/logo.png`,
 * `/site.webmanifest`, `/anything.js.map`) by matching a known asset EXTENSION —
 * deliberately not "the last segment contains a dot".
 *
 * That distinction is the whole point of this rule, and getting it wrong would
 * quietly break the feature's single most common use case. A redirect's source is
 * almost never a NextBlock slug; it is a URL from the site that existed BEFORE
 * NextBlock, and those end in `.html`, `.php`, `.aspx`, `.htm`, `.jsp` far more
 * often than not. Skipping every dotted path would mean an operator could save
 * `/about-us.html -> /about`, see it listed in the admin screen, and watch it never
 * fire — with no error anywhere to explain why. So page-ish extensions are
 * explicitly NOT in this list, and neither is anything unrecognised: a slug like
 * `/widget-2.0` stays redirectable because `0` is not an asset extension.
 */
const REDIRECT_SKIP_EXTENSIONS = new Set([
  'avif', 'bmp', 'css', 'eot', 'gif', 'ico', 'jpeg', 'jpg', 'js', 'json', 'map',
  'mjs', 'mp3', 'mp4', 'ogg', 'otf', 'pdf', 'png', 'svg', 'ttf', 'txt', 'wasm',
  'webm', 'webmanifest', 'webp', 'woff', 'woff2', 'xml', 'zip',
]);

export function shouldSkipRedirectLookup(pathname: string): boolean {
  // A non-string or empty path is not something a rule could match anyway, and
  // "skip" is the fail-open answer.
  if (typeof pathname !== 'string' || pathname === '') {
    return true;
  }

  for (const prefix of REDIRECT_SKIP_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  const lastSegment = pathname.split('/').pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
    return false;
  }

  return REDIRECT_SKIP_EXTENSIONS.has(lastSegment.slice(dotIndex + 1).toLowerCase());
}

/**
 * Whether a resolved destination would send the visitor straight back to the path
 * they asked for.
 *
 * The database refuses `source_path = destination_path`, but that constraint
 * compares raw strings while matching compares *normalised* ones, so `/about` →
 * `/about/` satisfies the CHECK and would still loop forever in a browser. Both
 * sides go through `normalizeRedirectPath` here — the same function the match
 * used — so this comparison cannot disagree with the lookup that produced the rule.
 *
 * BOTH ARGUMENTS ARE PATHNAMES, AND THAT IS LOAD-BEARING. The proxy calls this with
 * `request.nextUrl.pathname` and the resolved target's `.pathname`, neither of which
 * can ever contain a query string, which is what keeps `resolveRedirectTarget`'s
 * query carrying from being able to move this decision: a rule caught as a loop
 * before the query was carried is still caught after it. Feeding a full URL or a
 * path-plus-query in here would break that — `/about` → `/about/?ref=x` would stop
 * looking like the loop it is, and the visitor's browser would bounce until it gave
 * up.
 */
export function isSelfRedirect(requestPathname: string, destinationPathname: string): boolean {
  return normalizeRedirectPath(requestPathname) === normalizeRedirectPath(destinationPathname);
}

/**
 * The parts of the incoming request `resolveRedirectTarget` needs.
 *
 * Taking two plain strings rather than a `NextRequest` is what keeps the function
 * testable: everything else in the managed-redirect path is exercised by the tests
 * beside this file, and building the destination URL is the one step that was
 * silently wrong in production precisely because it lived in the untestable proxy
 * body.
 */
export interface RedirectTargetRequest {
  /**
   * The incoming query string, leading `?` included, or `''` when there is none —
   * i.e. exactly what `request.nextUrl.search` yields.
   */
  search: string;
  /** The absolute URL of the incoming request; the base a relative destination resolves against. */
  url: string;
}

/**
 * Resolves a matched rule's destination into the absolute URL to send the visitor
 * to, carrying the incoming query string when the destination does not define one
 * of its own.
 *
 * WHY THE QUERY IS CARRIED. The first version of this built the destination from
 * `rule.destinationPath` alone, on the assumption that a redirect's destination is
 * the whole story — that the path an operator typed fully identifies where the
 * visitor should land. That assumption is wrong twice over. A visitor arriving at
 * `/old-page?utm_source=newsletter&utm_campaign=spring` was forwarded to
 * `/new-page` with the campaign parameters gone, which silently destroys attribution
 * for exactly the inbound links redirects exist to rescue; and a legacy URL whose
 * meaning lives in its query (`/product.php?id=42`) arrived at the new page having
 * lost the only part of itself that said which product it was. The query is part of
 * the request the visitor made, not decoration on it, so it travels with them.
 *
 * A DESTINATION THAT DEFINES ITS OWN QUERY WINS OUTRIGHT, and nothing is merged.
 * `?page=2` on the destination is an operator being explicit about where this rule
 * leads; appending a visitor's parameters to it would produce a URL the operator
 * never wrote and cannot predict, and for a key present on both sides there is no
 * defensible answer about which value the application should read.
 *
 * WHY AN OFF-SITE DESTINATION IS GIVEN NOTHING. Forwarding the query only happens
 * when the resolved target lands on the same origin as the request. Off-site it is
 * suppressed, deliberately, for three reasons. First, a query string on an inbound
 * legacy link is scoped to this site and routinely carries more than campaign tags —
 * order numbers, the email address in an unsubscribe link, one-time tokens — and
 * copying it into a `Location:` pointed at a third party discloses all of it to a
 * host the operator merely named as a destination, on every hit, with no way for a
 * visitor to opt out. Second, this proxy already sends
 * `Referrer-Policy: strict-origin-when-cross-origin` on the very same response,
 * which is a standing decision that another origin does not get this site's paths
 * and query strings; putting the query in the Location would contradict that policy
 * one header away from where it is declared. Third, the benefit does not transfer:
 * attribution is a first-party concern, and the receiving property has its own
 * campaign parameters rather than a use for ours. Being wrong is asymmetric — the
 * cost of not forwarding is at worst a lost parameter on an off-site hop, which an
 * operator who genuinely wants it can simply write into the destination URL, while
 * the cost of forwarding is a leak nobody asked for.
 *
 * Same origin is tested against the resolved target rather than against the
 * destination's syntax, so an operator who writes their own site out in full
 * (`https://example.com/new` on example.com) gets the same treatment as one who
 * writes `/new`, which is what they would expect.
 *
 * RETURNING NULL RATHER THAN THROWING is the other half of this function's job. The
 * `URL` constructor throws on input it cannot parse, and a saved rule can hold such
 * input: `//example.com/x` passes `validateRedirectRule` as an external destination,
 * yet `new URL('//example.com/x')` with no base is a `TypeError`. Inside the proxy
 * that throw is caught, but only by the block-wide handler that also catches real
 * database failures, so a permanently broken rule would log an error on every
 * matching request forever. Resolving every destination against the request URL
 * fixes that case outright — a protocol-relative destination now picks up the
 * request's scheme, exactly as a browser resolves one — and anything still
 * unparseable becomes `null`, which the proxy reads as "serve the page".
 */
export function resolveRedirectTarget(
  destinationPath: string,
  request: RedirectTargetRequest,
): URL | null {
  const destination = typeof destinationPath === 'string' ? destinationPath.trim() : '';
  if (destination === '') {
    return null;
  }

  let base: URL;
  let target: URL;
  try {
    base = new URL(request.url);
    // The base is ignored for an absolute destination and used for every other
    // shape, so one call covers site-relative, protocol-relative and absolute
    // destinations without branching on which one this is.
    target = new URL(destination, base);
  } catch {
    return null;
  }

  const incomingSearch = typeof request.search === 'string' ? request.search : '';

  // `target.search` is `''` both for a destination with no query and for one written
  // with a bare trailing `?`, and treating those the same is right: neither expresses
  // an intent to arrive with an empty query.
  if (incomingSearch !== '' && target.search === '' && target.origin === base.origin) {
    target.search = incomingSearch;
  }

  return target;
}
