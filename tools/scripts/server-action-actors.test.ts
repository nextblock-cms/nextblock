import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  FREEMIUS_COUPON_PUSHES,
  ROUTE_HANDLER_SCOPES,
  SECOND_FACTOR_HELPERS,
  SECOND_FACTOR_SCOPES,
  STAFF_ROUTES,
  STAFF_ROUTE_SCOPES,
  STAFF_UPLOAD_ROUTES,
  STAFF_UPLOAD_ROUTE_SCOPES,
  analyzeCouponPushActions,
  analyzeRoleReadsBeforeServiceRole,
  analyzeRouteRoleReadsBeforeServiceRole,
  analyzeStaffRouteGates,
  classifyName,
  findCallerSuppliedActors,
  findCallerSuppliedActorsInSource,
  findCouponPushExports,
  findRoleReadsBeforeServiceRole,
  findRouteRoleReadsBeforeServiceRole,
  findStaffRouteGates,
  findStaffUploadRouteGates,
  findUnauthorizedCouponPushes,
  listServerActions,
  selectedColumns,
} = require('./lib/server-action-actors.js');
const { scanRepository } = require('./lib/service-role-boundary.js');

type Problem = { action: string; file: string; line: number; param: string; problem: string };

// Scanned once at collection time and shared by every repository-wide check below: under a full
// parallel run one scan alone outlasts a test's default timeout.
const repositoryModules = scanRepository();

function flagged(source: string, resolveImport: ((from: string, spec: string) => string | null) | null = null, file = 'fixture.ts') {
  return (findCallerSuppliedActorsInSource('fixture.ts', source, resolveImport, file) as Problem[]).map(
    (p) => `${p.action}:${p.param}`
  );
}

describe('server-action actor check', () => {
  it('classifies identity and client names, ignoring case and underscores', () => {
    for (const name of ['actorUserId', 'actor_user_id', 'uploaderId', 'uploader_id', 'authorId', 'author_id', 'userId', 'user_id', 'createdBy', 'ownerId']) {
      expect(classifyName(name)).toBe('an identity');
    }
    for (const name of ['client', 'supabase', 'serviceClient', 'supabaseClient']) {
      expect(classifyName(name)).toBe('a database client');
    }
    for (const name of ['userIdToUpdate', 'userIdToDelete', 'mediaId', 'formData', 'payload', 'email']) {
      expect(classifyName(name)).toBeNull();
    }
  });

  it('treats a partner id as an identity (Affiliates portal actions act for the session partner)', () => {
    for (const name of ['affiliateId', 'affiliate_id', 'AffiliateID', 'retailerId', 'retailer_id']) {
      expect(classifyName(name)).toBe('an identity');
    }
    for (const name of ['affiliateIdToUpdate', 'affiliateIdToSuspend', 'retailerIdToReview', 'pageIdToApprove', 'payoutIdToRetry', 'tierIdToUpdate']) {
      expect(classifyName(name)).toBeNull();
    }
  });

  it('fails an action that takes affiliateId, and passes one that names its admin target', () => {
    const source = `"use server";
      export async function saveStorefrontDraft(affiliateId: string, formData: FormData) {}
      export async function submitForReview(input: { retailer_id: string; note: string }) {}
      export const approvePage = async (pageIdToApprove: string, affiliateIdToUpdate: string) => {};
      export async function updateTier(tierIdToUpdate: string, input: { affiliateIdToUpdate: string }) {}`;
    expect(flagged(source)).toEqual(['saveStorefrontDraft:affiliateId', 'submitForReview:input.retailer_id']);
  });

  it('catches the pre-2026-10-21 recordMediaUpload (actorUserId in an inline payload type)', () => {
    const source = `"use server";
      export async function recordMediaUpload(payload: {
        fileName: string;
        r2Variants: ImageVariant[];
        actorUserId?: string;
      }, returnJustData?: boolean) {}`;
    expect(flagged(source)).toEqual(['recordMediaUpload:payload.actorUserId']);
  });

  it('catches the pre-2026-10-21 importExternalImageToMedia (actorUserId beside the url)', () => {
    const source = `"use server";
      import "server-only";
      export async function importExternalImageToMedia(input: { url: string; altText?: string; actorUserId?: string }) {}`;
    expect(flagged(source)).toEqual(['importExternalImageToMedia:input.actorUserId']);
  });

  it('catches positional author ids and injected clients', () => {
    const source = `"use server";
      export async function restorePageToVersion(pageId: number, targetVersion: number, authorId: string | null) {}
      export async function captureRevisionBaseline(parentType: string, parentId: number, client?: unknown) {}`;
    expect(flagged(source)).toEqual(['restorePageToVersion:authorId', 'captureRevisionBaseline:client']);
  });

  it('follows destructuring, arrow exports, wrapped exports, export lists and default exports', () => {
    const source = `'use server';
      export const a = async ({ url, actorUserId }: { url: string; actorUserId: string }) => {};
      export const b = cache(async (uploader_id: string) => {});
      async function c(userId: string) {}
      export { c as renamed };
      export default async function (supabase: unknown) {}`;
    expect(flagged(source)).toEqual(['a:actorUserId', 'b:uploader_id', 'renamed:userId', 'default:supabase']);
  });

  it('reads types declared in the module, their extends chain, aliases, and Omit/Pick', () => {
    const source = `"use server";
      interface Base { authorId: string }
      interface Input extends Base { title: string }
      type Alias = Partial<{ meta: { createdBy: string } }>;
      type Clean = Omit<{ title: string; userId: string }, 'userId'>;
      export async function one(input: Input) {}
      export async function two(input: Alias) {}
      export async function three(input: Clean) {}
      export async function four(input: Pick<{ title: string; userId: string }, 'title'>) {}`;
    expect(flagged(source)).toEqual(['one:input.authorId', 'two:input.meta.createdBy']);
  });

  it('follows a parameter type imported from another module', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-action-actors-'));
    try {
      fs.writeFileSync(path.join(dir, 'types.ts'), 'export type ImportInput = { url: string; actorUserId?: string };\n');
      fs.writeFileSync(path.join(dir, 'barrel.ts'), "export type { ImportInput as Input } from './types';\n");
      const resolveImport = (from: string, spec: string) => path.join(path.dirname(from), `${spec.replace(/^\.\//, '')}.ts`);
      const source = `"use server";
        import type { Input } from './barrel';
        export async function importIt(input: Input) {}`;
      expect(flagged(source, resolveImport, path.join(dir, 'action.ts'))).toEqual(['importIt:input.actorUserId']);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it('checks inline actions in server components, and only the actions', () => {
    const source = `import { createClient } from 'db';
      export async function helper(actorUserId: string) {}
      export default function Page() {
        const save = async (formData: FormData, userId: string) => {
          'use server';
        };
        return null;
      }`;
    expect(flagged(source)).toEqual(['save:userId']);
  });

  it('leaves non-action modules alone: the server-only actor helpers live there', () => {
    const source = `import "server-only";
      export async function recordMediaUploadAsActor(payload: { fileName: string }, actorUserId: string) {}`;
    expect(flagged(source)).toEqual([]);
  });

  it('passes session-derived actions and named target ids', () => {
    const source = `"use server";
      export async function recordMediaUpload(payload: { fileName: string; description?: string }) {}
      export async function updateUserProfile(userIdToUpdate: string, formData: FormData) {}
      export async function validateCheckoutEligibility(..._ignoredArgs: unknown[]) {}`;
    expect(flagged(source)).toEqual([]);
  });
});

describe('no server action in the repository takes its principal from the caller', () => {
  const modules = repositoryModules;

  it('sees the server actions of the app and the libraries', () => {
    const actions: string[] = listServerActions(modules);
    expect(actions.length).toBeGreaterThan(200);
    expect(actions).toContain('libs/db/src/lib/media-actions.ts#recordMediaUpload');
    expect(actions).toContain('apps/nextblock/app/cms/media/actions.ts#recordMediaUpload');
    expect(actions).toContain('apps/nextblock/app/cms/media/import-external-image.ts#importExternalImageToMedia');
    expect(actions).toContain('apps/nextblock/app/cms/media/[id]/edit/page.tsx#updateMediaFormAction');
  });

  it('takes no actor, author, uploader or user id and no database client from a parameter', () => {
    expect((findCallerSuppliedActors(modules) as Problem[]).map((p) => p.problem)).toEqual([]);
  });
});

describe('server actions take the service-role client only from a verified helper', () => {
  // 2026-10-27: app/cms/orders/actions.ts#markOrderAsPaid read the role with the cookie client,
  // then built a service-role client from the env keys itself, so a first factor alone could
  // mark an order paid (and, since 02030, record a partner's commission). The ecommerce lib's
  // order status actions had the same shape. A CMS action takes the service client from
  // requireCmsAdmin / requireCmsStaff (app) or requireEcomAdmin / requireEcomStaff (libs), which
  // refuse a session that has not passed its enrolled second factor.
  //
  // 2026-11-13: app/actions/package-actions.ts, outside the CMS trees this check used to scan, did
  // the same (a cookie-client role read, then its own client from resolveSupabaseServiceKey()), so
  // an ADMIN password alone activated, deactivated and re-sent licenses. The check now fails on any
  // module in the app or the libraries that has a 'use server' directive and mints the client
  // itself, unless OWN_SERVICE_CLIENT_ALLOWED says why it may.
  const USE_SERVER_ANYWHERE = /['"]use server['"]/;
  const RAW_SERVICE_ROLE: ReadonlyArray<readonly [RegExp, string]> = [
    [/^\s*import\s+(?!type\b)[^;]*\bcreateClient\b[^;]*\bfrom\s+['"]@supabase\/supabase-js['"]/m, 'builds its own supabase-js client'],
    [/process\.env(?:\.|\[\s*['"])(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\b/, 'reads the secret key from process.env'],
    [/\bresolveSupabaseServiceKey\b/, 'resolves the secret key itself'],
  ];

  /** 'use server' modules that may mint the client themselves, each with why (an entry that no longer does fails). */
  const OWN_SERVICE_CLIENT_ALLOWED = new Map<string, string>([
    [
      'apps/nextblock/lib/setup/actions.ts',
      '/setup probes the Supabase URL and secret key the operator just typed, before any env holds them; every mutating action refuses once an admin exists (assertNotProvisioned).',
    ],
  ]);

  function rawServiceRoleUses(source: string): string[] {
    return RAW_SERVICE_ROLE.filter(([re]) => re.test(source)).map(([, what]) => what);
  }

  // Read at collection time from the shared scan, like the repository-wide check above.
  const serverActionModules = [...repositoryModules.values()]
    .map((mod: { repoPath: string; absolute: string }) => [mod.repoPath, fs.readFileSync(mod.absolute, 'utf8')] as const)
    .filter(([, source]) => USE_SERVER_ANYWHERE.test(source));

  it('recognises the pre-2026-10-27 markOrderAsPaid shape, and not a type-only import', () => {
    const before = [
      "'use server';",
      "import { createClient } from '@nextblock-cms/db/server';",
      "import { createClient as createSupabaseClient } from '@supabase/supabase-js';",
      'export async function markOrderAsPaid(orderId: string) {',
      '  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;',
      '}',
    ].join('\n');
    expect(rawServiceRoleUses(before)).toEqual(['builds its own supabase-js client', 'reads the secret key from process.env']);
    expect(rawServiceRoleUses("import { resolveSupabaseServiceKey } from '../../lib/setup/service-key';")).toEqual([
      'resolves the secret key itself',
    ]);
    expect(rawServiceRoleUses("import type { SupabaseClient } from '@supabase/supabase-js';")).toEqual([]);
    expect(rawServiceRoleUses("const { supabase } = await requireCmsAdmin();")).toEqual([]);
  });

  it('recognises the pre-2026-11-13 package-actions shape', () => {
    const before = [
      "'use server';",
      "import { createClient } from '@supabase/supabase-js';",
      "import { createClient as createCookieClient } from '@nextblock-cms/db/server';",
      "import { resolveSupabaseServiceKey } from '../../lib/setup/service-key';",
      'async function requireAdminActor() { const { data: profile } = await createCookieClient().from("profiles").select("role"); }',
      'const getServiceRoleClient = () => createClient(resolveSupabaseUrl(), resolveSupabaseServiceKey());',
    ].join('\n');
    expect(rawServiceRoleUses(before)).toEqual(['builds its own supabase-js client', 'resolves the secret key itself']);
    expect(rawServiceRoleUses("const { supabase } = await requireCmsAdmin();\nawait activateLicenseKey(key, supabase);")).toEqual([]);
  });

  it('finds none in the app or the libraries outside the reviewed list', () => {
    // Coverage: the scan must actually see the server action modules, inside the CMS trees and out.
    const paths = serverActionModules.map(([repoPath]) => repoPath);
    expect(paths.length).toBeGreaterThan(80);
    expect(paths).toContain('apps/nextblock/app/cms/orders/actions.ts');
    expect(paths).toContain('libs/ecommerce/src/lib/pages/cms/orders/server-actions.ts');
    expect(paths).toContain('apps/nextblock/app/cms/affiliates/actions.ts');
    expect(paths).toContain('apps/nextblock/app/actions/package-actions.ts');

    const offenders = serverActionModules
      .filter(([repoPath]) => !OWN_SERVICE_CLIENT_ALLOWED.has(repoPath))
      .flatMap(([repoPath, source]) => rawServiceRoleUses(source).map((what) => repoPath + ': ' + what));
    expect(offenders).toEqual([]);

    // A listed module that no longer mints the client leaves the list.
    const stale = [...OWN_SERVICE_CLIENT_ALLOWED.keys()].filter(
      (repoPath) => !serverActionModules.some(([path, source]) => path === repoPath && rawServiceRoleUses(source).length > 0)
    );
    expect(stale).toEqual([]);
  });
});

describe('Freemius coupon pushes need requireEcomAdmin() or requireCmsAdmin() first', () => {
  // 2026-11-13: a coupon push is signed with the Freemius developer key pair (every product of the
  // account), and four server-action paths reached one with an ADMIN password and no second
  // factor: the coupon actions (a role-only getAdminClient()), the promotions CSV import (a
  // role-only assertAdmin()), createProductAction (no check) and the visual-editing product
  // publish (role only). The fixtures stand in for the coupons module and the two helpers.

  type CouponPushProblem = { action: string; callSite: string | null; file: string; line: number; push: string | null; problem: string };

  /** 1-based line of the first occurrence of `needle` in a fixture. */
  function lineOf(source: string, needle: string) {
    const index = source.indexOf(needle);
    if (index < 0) throw new Error(`fixture has no ${needle}`);
    return source.slice(0, index).split('\n').length;
  }

  const COUPONS_MODULE = `
    async function freemiusCouponRequest(input: unknown) { return fetch('https://api.freemius.com', { method: 'POST' }); }
    async function pushTo(productId: string) { return freemiusCouponRequest({ productId }); }
    export async function syncCouponToFreemius(input: unknown) { return pushTo('1'); }
    export async function syncProductSaleCouponToFreemius(input: unknown) { return freemiusCouponRequest(input); }
    export async function deleteCouponFromFreemius(input: unknown) { return freemiusCouponRequest(input); }
    export function couponCode(code: string) { return code.toUpperCase(); }
    export const SANDBOX_MESSAGE = 'not sent';`;

  /** Writes the fixture (plus stand-ins) into a fresh directory and runs the check over `entries`. */
  function couponPushes(files: Record<string, string>, entries = Object.keys(files), pushes: string[] = FREEMIUS_COUPON_PUSHES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-push-'));
    const all: Record<string, string> = {
      'freemius-coupons.ts': COUPONS_MODULE,
      'require-ecom-role.ts': 'export async function requireEcomAdmin() { return {}; }\nexport async function requireEcomStaff() { return {}; }\n',
      'cms-actor.ts': 'export async function requireCmsAdmin() { return { supabase: {} }; }\nexport async function requireCmsStaff() { return { supabase: {} }; }\n',
      'payment-config.ts': 'export function readPaymentConfig() { return {}; }\n',
      'server.ts': "export * from './payment-config';\nexport * from './freemius-coupons';\n",
      ...files,
    };
    try {
      for (const [name, source] of Object.entries(all)) fs.writeFileSync(path.join(dir, name), source);
      const resolveImport = (from: string, spec: string) => {
        const base = spec === '@fixture/server' ? path.join(dir, 'server') : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
        return base === null ? null : (['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)) ?? null);
      };
      const result = analyzeCouponPushActions(
        entries.map((name) => path.join(dir, name)),
        {
          resolveImport,
          root: dir,
          pushes: pushes.map((name) => [path.join(dir, 'freemius-coupons.ts'), name]),
          authorizers: [
            [path.join(dir, 'require-ecom-role.ts'), 'requireEcomAdmin'],
            [path.join(dir, 'cms-actor.ts'), 'requireCmsAdmin'],
          ],
        }
      );
      const problems = result.problems as CouponPushProblem[];
      return {
        reaching: result.reaching as string[],
        flagged: problems.map((p) => `${p.file}#${p.action} -> ${p.push}`),
        problems,
        pushExports: findCouponPushExports(path.join(dir, 'freemius-coupons.ts')) as string[],
      };
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }

  it('catches the pre-2026-11-13 coupon actions (a role-only getAdminClient())', () => {
    const { flagged, reaching } = couponPushes({
      'actions.ts': `'use server';
        import 'server-only';
        import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
        import { deleteCouponFromFreemius, syncCouponToFreemius } from './freemius-coupons';
        async function getAdminClient() {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error('Unauthorized');
          return getServiceRoleSupabaseClient();
        }
        export async function createCouponAction(formData: FormData) {
          const client = await getAdminClient();
          await syncCouponToFreemius({ couponId: 'c', client });
        }
        export async function deleteCouponAction(couponId: string) {
          const client = await getAdminClient();
          await deleteCouponFromFreemius({ couponId, client });
        }
        export async function listCouponsAction() {
          return getAdminClient();
        }`,
    });
    expect(flagged).toEqual([
      'actions.ts#createCouponAction -> syncCouponToFreemius',
      'actions.ts#deleteCouponAction -> deleteCouponFromFreemius',
    ]);
    expect(reaching).toEqual(['actions.ts#createCouponAction', 'actions.ts#deleteCouponAction']);
  });

  it('passes them once each calls requireEcomAdmin() first: directly, renamed, or through a wrapper', () => {
    const { flagged, reaching } = couponPushes({
      'actions.ts': `'use server';
        import { requireEcomAdmin, requireEcomAdmin as verifiedAdmin } from './require-ecom-role';
        import { deleteCouponFromFreemius, syncCouponToFreemius } from './freemius-coupons';
        async function getAdminClient() { return verifiedAdmin(); }
        export async function createCouponAction(formData: FormData) {
          const client = await requireEcomAdmin();
          await syncCouponToFreemius({ couponId: 'c', client });
        }
        export async function deleteCouponAction(couponId: string) {
          const client = await getAdminClient();
          await deleteCouponFromFreemius({ couponId, client });
        }`,
    });
    expect(flagged).toEqual([]);
    expect(reaching).toEqual(['actions.ts#createCouponAction', 'actions.ts#deleteCouponAction']);
  });

  it('fails a check after the push, a staff helper, and a local function that only shares the name', () => {
    const { flagged } = couponPushes({
      'actions.ts': `'use server';
        import { requireEcomAdmin, requireEcomStaff } from './require-ecom-role';
        import { requireCmsStaff } from './cms-actor';
        import { syncCouponToFreemius } from './freemius-coupons';
        async function requireCmsAdmin() { return {}; }
        export async function late() { await syncCouponToFreemius({}); await requireEcomAdmin(); }
        export async function ecomStaff() { await requireEcomStaff(); await syncCouponToFreemius({}); }
        export async function cmsStaff() { await requireCmsStaff(); await syncCouponToFreemius({}); }
        export async function lookalike() { await requireCmsAdmin(); await syncCouponToFreemius({}); }`,
    });
    expect(flagged).toEqual([
      'actions.ts#late -> syncCouponToFreemius',
      'actions.ts#ecomStaff -> syncCouponToFreemius',
      'actions.ts#cmsStaff -> syncCouponToFreemius',
      'actions.ts#lookalike -> syncCouponToFreemius',
    ]);
  });

  it('follows a helper module through an alias and an export * barrel (the pre-2026-11-13 promotions import)', () => {
    const helper = `import { syncProductSaleCouponToFreemius } from '@fixture/server';
      export async function applyPromotionsImport(kind: string, csv: string) {
        for (const productId of csv.split(',')) await syncProductSaleCouponToFreemius({ productId, client: {} });
      }
      export async function dryRunPromotionsImport(kind: string, csv: string) { return csv.length; }`;
    const before = couponPushes(
      {
        'promotions-server.ts': helper,
        'actions.ts': `"use server";
          import { applyPromotionsImport, dryRunPromotionsImport } from './promotions-server';
          async function assertAdmin() {}
          export async function applyPromotionsImportAction(params: { kind: string; content: string }) {
            try { await assertAdmin(); return await applyPromotionsImport(params.kind, params.content); } catch { return null; }
          }
          export async function dryRunPromotionsImportAction(params: { kind: string; content: string }) {
            await assertAdmin();
            return dryRunPromotionsImport(params.kind, params.content);
          }`,
      },
      ['actions.ts']
    );
    expect(before.flagged).toEqual(['actions.ts#applyPromotionsImportAction -> syncProductSaleCouponToFreemius']);
    expect(before.problems[0].problem).toContain(
      '(applyPromotionsImportAction -> applyPromotionsImport (promotions-server.ts) -> syncProductSaleCouponToFreemius)'
    );

    const after = couponPushes(
      {
        'promotions-server.ts': helper,
        'actions.ts': `"use server";
          import { requireCmsAdmin } from './cms-actor';
          import { applyPromotionsImport } from './promotions-server';
          export async function applyPromotionsImportAction(params: { kind: string; content: string }) {
            try { await requireCmsAdmin(); return await applyPromotionsImport(params.kind, params.content); } catch { return null; }
          }`,
      },
      ['actions.ts']
    );
    expect(after.flagged).toEqual([]);
    expect(after.reaching).toEqual(['actions.ts#applyPromotionsImportAction']);
  });

  it('accepts a helper that authorizes before its own push, and fails one that checks the role only (the visual-editing publish)', () => {
    const { flagged, reaching } = couponPushes(
      {
        'product-drafts.ts': `import { requireCmsAdmin } from './cms-actor';
          import { syncProductSaleCouponToFreemius } from './freemius-coupons';
          async function requireVisualEditingEditableUser() { return { canEdit: true }; }
          export async function publishChecked(productId: string, fullForm: boolean) {
            await requireVisualEditingEditableUser();
            if (fullForm) {
              let admin;
              try {
                admin = await requireCmsAdmin();
              } catch (authError) {
                throw new Error('refused');
              }
              await syncProductSaleCouponToFreemius({ productId, client: admin.supabase });
            }
          }
          export async function publishRoleOnly(productId: string) {
            await requireVisualEditingEditableUser();
            await syncProductSaleCouponToFreemius({ productId, client: {} });
          }`,
        'visualEditingActions.ts': `"use server";
          import { publishChecked, publishRoleOnly } from './product-drafts';
          export async function publishA(productId: string) { return publishChecked(productId, true); }
          export async function publishB(productId: string) { return publishRoleOnly(productId); }`,
      },
      // product-drafts.ts has no 'use server': not an entry point, only a module the actions call.
      ['visualEditingActions.ts', 'product-drafts.ts']
    );
    expect(flagged).toEqual(['visualEditingActions.ts#publishB -> syncProductSaleCouponToFreemius']);
    expect(reaching).toEqual(['visualEditingActions.ts#publishA', 'visualEditingActions.ts#publishB']);
  });

  it('follows dynamic imports (destructured and namespace), import * as, and a function passed as a callback', () => {
    const { flagged, reaching } = couponPushes({
      'actions.ts': `'use server';
        import * as coupons from './freemius-coupons';
        export async function viaDynamic() {
          const { deleteCouponFromFreemius: drop } = await import('./freemius-coupons');
          await drop({});
        }
        export async function viaDynamicNamespace() {
          const mod = await import('./freemius-coupons');
          await mod.syncCouponToFreemius({});
        }
        export async function viaNamespace() { await coupons.syncCouponToFreemius({}); }
        async function pushOne(productId: string) { await coupons.syncProductSaleCouponToFreemius({ productId }); }
        export async function viaCallback(ids: string[]) { await Promise.all(ids.map(pushOne)); }
        export async function formatOnly(code: string) { return coupons.couponCode(code); }`,
    });
    expect(flagged).toEqual([
      'actions.ts#viaDynamic -> deleteCouponFromFreemius',
      'actions.ts#viaDynamicNamespace -> syncCouponToFreemius',
      'actions.ts#viaNamespace -> syncCouponToFreemius',
      'actions.ts#viaCallback -> syncProductSaleCouponToFreemius',
    ]);
    expect(reaching).not.toContain('actions.ts#formatOnly');
  });

  it('checks inline actions in server components, and only the actions', () => {
    const { flagged } = couponPushes({
      'Page.tsx': `import { syncCouponToFreemius } from './freemius-coupons';
        import { requireEcomAdmin } from './require-ecom-role';
        export async function helperThatIsNotAnAction() { await syncCouponToFreemius({}); }
        export default function Page() {
          const unchecked = async () => { 'use server'; await syncCouponToFreemius({}); };
          async function checked() { 'use server'; await requireEcomAdmin(); await syncCouponToFreemius({}); }
          return null;
        }`,
    });
    expect(flagged).toEqual(['Page.tsx#unchecked -> syncCouponToFreemius']);
  });

  it('finds the exports of the coupons module that reach its request, and reports a listed push that is gone', () => {
    expect(couponPushes({}, []).pushExports).toEqual(['deleteCouponFromFreemius', 'syncCouponToFreemius', 'syncProductSaleCouponToFreemius']);
    expect(couponPushes({}, [], [...FREEMIUS_COUPON_PUSHES, 'syncEveryCouponToFreemius']).problems.map((p) => p.problem)).toEqual([
      'freemius-coupons.ts no longer exports the coupon push syncEveryCouponToFreemius(); update FREEMIUS_COUPON_PUSHES',
    ]);
  });

  // 2026-11-13 re-review of the first version of this check: it compared source positions only, so
  // a helper written anywhere before the push passed, even when its refusal could never stop it.
  it('fails the re-review bypasses: a swallowed refusal, a try whose catch falls through, one branch only, and void', () => {
    const { flagged, reaching } = couponPushes({
      'actions.ts': `'use server';
        import { requireEcomAdmin } from './require-ecom-role';
        import { syncCouponToFreemius } from './freemius-coupons';
        export async function swallowed(id: string) { await requireEcomAdmin().catch(() => null); await syncCouponToFreemius({ id }); }
        export async function tried(id: string) { try { await requireEcomAdmin(); } catch {} await syncCouponToFreemius({ id }); }
        export async function strictOnly(id: string, strict: boolean) { if (strict) { await requireEcomAdmin(); } await syncCouponToFreemius({ id }); }
        export async function floating(id: string) { void requireEcomAdmin(); await syncCouponToFreemius({ id }); }`,
    });
    expect(flagged).toEqual([
      'actions.ts#swallowed -> syncCouponToFreemius',
      'actions.ts#tried -> syncCouponToFreemius',
      'actions.ts#strictOnly -> syncCouponToFreemius',
      'actions.ts#floating -> syncCouponToFreemius',
    ]);
    expect(reaching).toHaveLength(4);
  });

  it('passes a check that every later call toward the push depends on', () => {
    const { flagged, reaching } = couponPushes({
      'actions.ts': `'use server';
        import { requireCmsAdmin } from './cms-actor';
        import { requireEcomAdmin } from './require-ecom-role';
        import { deleteCouponFromFreemius, syncCouponToFreemius, syncProductSaleCouponToFreemius } from './freemius-coupons';
        export async function topLevel(id: string) {
          await requireEcomAdmin();
          await syncCouponToFreemius({ id });
          await deleteCouponFromFreemius({ id });
        }
        export async function destructured(id: string) {
          const { supabase } = await requireCmsAdmin();
          await syncCouponToFreemius({ id, client: supabase });
        }
        export async function assignedAfterLet(id: string) {
          let admin;
          admin = await requireCmsAdmin();
          await syncCouponToFreemius({ id, client: admin.supabase });
        }
        export async function catchReturns(id: string) {
          try {
            await requireCmsAdmin();
          } catch (error) {
            return { error: 'Unauthorized' };
          }
          await syncCouponToFreemius({ id });
          return { success: true };
        }
        export async function sameBranch(id: string, fullForm: boolean) {
          if (fullForm) {
            await requireEcomAdmin();
            await syncProductSaleCouponToFreemius({ id });
          }
        }
        export async function catchRethrows(id: string) {
          let admin: { supabase: unknown };
          try {
            admin = await requireCmsAdmin();
          } catch (authError) {
            throw new Error('Complete two-factor verification, then publish again.');
          }
          try {
            await syncProductSaleCouponToFreemius({ id, client: admin.supabase });
          } catch (couponError) {
            console.error(couponError);
          }
        }
        export async function insideTheTry(id: string) {
          try {
            await requireCmsAdmin();
            return await syncCouponToFreemius({ id });
          } catch (error) {
            return { error: String(error) };
          }
        }
        export async function wrapped(id: string) {
          const admin = (await (requireCmsAdmin())) as { supabase: unknown };
          await syncCouponToFreemius({ id, client: admin.supabase });
        }
        export async function deeperLater(ids: string[]) {
          await requireEcomAdmin();
          if (ids.length > 0) {
            for (const id of ids) await syncCouponToFreemius({ id });
          }
          await Promise.all(ids.map(async (id) => syncProductSaleCouponToFreemius({ id })));
        }`,
    });
    expect(flagged).toEqual([]);
    expect(reaching).toEqual([
      'actions.ts#assignedAfterLet',
      'actions.ts#catchRethrows',
      'actions.ts#catchReturns',
      'actions.ts#deeperLater',
      'actions.ts#destructured',
      'actions.ts#insideTheTry',
      'actions.ts#sameBranch',
      'actions.ts#topLevel',
      'actions.ts#wrapped',
    ]);
  });

  it('fails a check that some call toward the push can skip, and names that call', () => {
    const source = `'use server';
        import { requireEcomAdmin } from './require-ecom-role';
        import { syncCouponToFreemius } from './freemius-coupons';
        export async function checkedInBranch(id: string, strict: boolean) {
          if (strict) {
            await requireEcomAdmin();
          }
          await syncCouponToFreemius({ id });
        }
        export async function pushFirst(id: string) {
          await syncCouponToFreemius({ id });
          await requireEcomAdmin();
        }
        export async function secondPushOutside(id: string, fullForm: boolean) {
          if (fullForm) {
            await requireEcomAdmin();
            await syncCouponToFreemius({ id });
          }
          await syncCouponToFreemius({ id, again: true });
        }`;
    const { flagged, problems } = couponPushes({ 'actions.ts': source });
    expect(flagged).toEqual([
      'actions.ts#checkedInBranch -> syncCouponToFreemius',
      'actions.ts#pushFirst -> syncCouponToFreemius',
      'actions.ts#secondPushOutside -> syncCouponToFreemius',
    ]);
    // Every call toward a push is checked, not only the first: the protected push inside the branch
    // does not cover the one after it.
    const second = problems.find((p) => p.action === 'secondPushOutside');
    const secondLine = lineOf(source, 'syncCouponToFreemius({ id, again: true })');
    expect(second?.callSite).toBe(`actions.ts:${secondLine}`);
    expect(second?.problem).toContain(`through the call at actions.ts:${secondLine}`);
  });

  it('fails other shapes where the refusal can be skipped, swallowed or never awaited', () => {
    const { flagged } = couponPushes({
      'actions.ts': `'use server';
        import { requireEcomAdmin } from './require-ecom-role';
        import { syncCouponToFreemius } from './freemius-coupons';
        export async function thenOnCall(id: string) { await requireEcomAdmin().then(() => null, () => null); await syncCouponToFreemius({ id }); }
        export async function logicalAssignment(id: string) { let admin = null; admin ??= await requireEcomAdmin(); await syncCouponToFreemius({ id, admin }); }
        export async function conditional(id: string, strict: boolean) { strict ? await requireEcomAdmin() : null; await syncCouponToFreemius({ id }); }
        export async function unbracedIf(id: string, strict: boolean) { if (strict) await requireEcomAdmin(); await syncCouponToFreemius({ id }); }
        // inCatch checks only when the try failed. inFinally and catchLogs are refused by rule: a
        // check never counts inside a catch or a finally, or inside a try whose catch can fall
        // through (it turns a refusal into ordinary control flow), even where the push follows it.
        export async function inCatch(id: string) { try { JSON.parse(id); } catch { await requireEcomAdmin(); } await syncCouponToFreemius({ id }); }
        export async function inFinally(id: string) { try { JSON.parse(id); } finally { await requireEcomAdmin(); } await syncCouponToFreemius({ id }); }
        export async function catchLogs(id: string) { try { await requireEcomAdmin(); await syncCouponToFreemius({ id }); } catch (error) { console.error(error); } }
        export async function labeledTry(id: string, skip: boolean) { checked: try { if (skip) break checked; await requireEcomAdmin(); } catch { return; } await syncCouponToFreemius({ id }); }
        export async function passedNotCalled(id: string) { await Promise.resolve(requireEcomAdmin); await syncCouponToFreemius({ id }); }
        export async function uncalledCallback(id: string) { const check = async () => { await requireEcomAdmin(); }; void check; await syncCouponToFreemius({ id }); }
        export async function hoisted(id: string) {
          await pushEarly();
          await requireEcomAdmin();
          async function pushEarly() { await syncCouponToFreemius({ id }); }
        }`,
    });
    expect(flagged).toEqual([
      'actions.ts#thenOnCall -> syncCouponToFreemius',
      'actions.ts#logicalAssignment -> syncCouponToFreemius',
      'actions.ts#conditional -> syncCouponToFreemius',
      'actions.ts#unbracedIf -> syncCouponToFreemius',
      'actions.ts#inCatch -> syncCouponToFreemius',
      'actions.ts#inFinally -> syncCouponToFreemius',
      'actions.ts#catchLogs -> syncCouponToFreemius',
      'actions.ts#labeledTry -> syncCouponToFreemius',
      'actions.ts#passedNotCalled -> syncCouponToFreemius',
      'actions.ts#uncalledCallback -> syncCouponToFreemius',
      'actions.ts#hoisted -> syncCouponToFreemius',
    ]);
  });

  it('counts a wrapper only when every way it returns normally passes the check', () => {
    const { flagged } = couponPushes({
      'actions.ts': `'use server';
        import { requireCmsAdmin } from './cms-actor';
        import { requireEcomAdmin } from './require-ecom-role';
        import { syncCouponToFreemius } from './freemius-coupons';
        async function swallowing() { await requireEcomAdmin().catch(() => null); }
        async function catchReturnsNull() { try { return await requireEcomAdmin(); } catch { return null; } }
        async function oneBranch(strict: boolean) { if (strict) { return requireEcomAdmin(); } return null; }
        async function checked() { const admin = await requireEcomAdmin(); return admin; }
        const arrow = () => requireCmsAdmin();
        async function nested() { await checked(); }
        export async function viaSwallowing(id: string) { await swallowing(); await syncCouponToFreemius({ id }); }
        export async function viaCatchReturnsNull(id: string) { await catchReturnsNull(); await syncCouponToFreemius({ id }); }
        export async function viaOneBranch(id: string) { await oneBranch(false); await syncCouponToFreemius({ id }); }
        export async function notAwaited(id: string) { void checked(); await syncCouponToFreemius({ id }); }
        export async function viaChecked(id: string) { const admin = await checked(); await syncCouponToFreemius({ id, admin }); }
        export async function viaArrow(id: string) { await arrow(); await syncCouponToFreemius({ id }); }
        export async function viaNested(id: string) { await nested(); await syncCouponToFreemius({ id }); }`,
    });
    expect(flagged).toEqual([
      'actions.ts#viaSwallowing -> syncCouponToFreemius',
      'actions.ts#viaCatchReturnsNull -> syncCouponToFreemius',
      'actions.ts#viaOneBranch -> syncCouponToFreemius',
      'actions.ts#notAwaited -> syncCouponToFreemius',
    ]);
  });

  it('does not count a call through a name the function rebinds, and still counts a dynamic import of the helper', () => {
    const { flagged, reaching } = couponPushes({
      'actions.ts': `'use server';
        import { requireCmsAdmin } from './cms-actor';
        import { requireEcomAdmin } from './require-ecom-role';
        import { syncCouponToFreemius } from './freemius-coupons';
        export async function shadowedByLocal(id: string) {
          const requireEcomAdmin = async () => null;
          await requireEcomAdmin();
          await syncCouponToFreemius({ id });
        }
        async function withChecker(requireCmsAdmin: () => Promise<unknown>, id: string) {
          await requireCmsAdmin();
          await syncCouponToFreemius({ id });
        }
        export async function shadowedByParameter(id: string) { return withChecker(async () => null, id); }
        export async function dynamicHelper(id: string) {
          const { requireEcomAdmin: verified } = await import('./require-ecom-role');
          await verified();
          await syncCouponToFreemius({ id });
        }`,
    });
    expect(flagged).toEqual([
      'actions.ts#shadowedByLocal -> syncCouponToFreemius',
      'actions.ts#shadowedByParameter -> syncCouponToFreemius',
    ]);
    expect(reaching).toContain('actions.ts#dynamicHelper');
  });

  it('fails the first 0.23.4 visual-editing shape: a .catch() on the check, even one that rethrows', () => {
    // apps/nextblock/lib/visual-editing/product-drafts.ts had exactly this. The check cannot prove
    // what a handler does, so the helper is awaited bare and its refusal is reworded in a catch
    // that ends in throw or return (the passing shape in the visual-editing test above).
    const { flagged } = couponPushes(
      {
        'product-drafts.ts': `import { requireCmsAdmin } from './cms-actor';
          import { syncProductSaleCouponToFreemius } from './freemius-coupons';
          export async function publishProduct(productId: string, fullForm: boolean) {
            try {
              if (fullForm) {
                const admin = await requireCmsAdmin().catch((authError: unknown) => {
                  throw new Error(authError instanceof Error && authError.message === 'Forbidden' ? 'Only an administrator can publish product pricing.' : 'Complete two-factor verification, then publish again.');
                });
                await syncProductSaleCouponToFreemius({ productId, client: admin.supabase });
              }
              return { success: true };
            } catch (error) {
              return { error: String(error) };
            }
          }`,
        'visualEditingActions.ts': `"use server";
          import { publishProduct } from './product-drafts';
          export async function publishVisualEditingProductDraft(productId: string) { return publishProduct(productId, true); }`,
      },
      ['visualEditingActions.ts', 'product-drafts.ts']
    );
    expect(flagged).toEqual(['visualEditingActions.ts#publishVisualEditingProductDraft -> syncProductSaleCouponToFreemius']);
  });
});

describe('no server action in the repository reaches a Freemius coupon push without a second-factor admin check', () => {
  // Analyzed once at collection time from the shared scan.
  const { reaching, problems } = findUnauthorizedCouponPushes(repositoryModules) as {
    reaching: string[];
    problems: Array<{ problem: string }>;
  };

  it('sees every action that pushes coupons, through each kind of import they use', () => {
    expect(reaching).toEqual(
      expect.arrayContaining([
        'libs/ecommerce/src/lib/pages/cms/coupons/actions.ts#createCouponAction',
        'libs/ecommerce/src/lib/pages/cms/coupons/actions.ts#updateCouponAction',
        'libs/ecommerce/src/lib/pages/cms/coupons/actions.ts#toggleCouponActiveAction',
        'libs/ecommerce/src/lib/pages/cms/coupons/actions.ts#syncCouponAction',
        'libs/ecommerce/src/lib/pages/cms/coupons/actions.ts#deleteCouponAction',
        'libs/ecommerce/src/lib/pages/cms/products/server-actions.ts#createProductAction',
        // through lib/promotions/server.ts and the @nextblock-cms/ecommerce/server barrel
        'apps/nextblock/app/cms/promotions/actions.ts#applyPromotionsImportAction',
        // through lib/visual-editing/product-drafts.ts
        'apps/nextblock/app/actions/visualEditingActions.ts#publishVisualEditingProductDraft',
      ])
    );
  });

  it('knows every export of the coupons module that sends a coupon to Freemius', () => {
    expect(findCouponPushExports()).toEqual([...FREEMIUS_COUPON_PUSHES].sort());
  });

  it('finds none that skips requireEcomAdmin() / requireCmsAdmin()', () => {
    expect(problems.map((p) => p.problem)).toEqual([]);
  });
});

describe('a role read on the way to the service role needs a second-factor helper', () => {
  // 2026-11-13: replyToInteraction and updateInteractionStatus (getProfileWithRoleServerSide), the
  // language detection settings (a role-only verifyAdmin), getFormEndpointForEditor, sendTestEmail
  // (sendEmail reads the SMTP credentials with the service role) and pollGithubConnect
  // (markSyncWorkflowInstalled writes system_configuration) checked the role and then reached the
  // service role with no second factor. The fixtures stand in for @nextblock-cms/db/server, the
  // helpers and the library code those actions call.

  type RoleReadProblem = { action?: string; file: string; line?: number; roleRead?: string; serviceRole?: string; problem: string };

  const DB_SERVER = `
    export function createClient() { return {} as any; }
    export function getServiceRoleSupabaseClient() { return {} as any; }
    export async function getProfileWithRoleServerSide(id: string) {
      return createClient().from('profiles').select('id, full_name, role').eq('id', id).single();
    }`;

  /** Writes the fixture (plus stand-ins) into a fresh directory and runs the check over `entries`. */
  function roleReads(files: Record<string, string>, entries = Object.keys(files), helpers: string[] = ['getCmsActor', 'requireCmsAdmin', 'requireCmsStaff']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-read-'));
    const all: Record<string, string> = {
      'db-server.ts': DB_SERVER,
      'cms-actor.ts': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
        function cache<T>(fn: T) { return fn; }
        export const getCmsActor = cache(async () => {
          const { data } = await createClient().from('profiles').select('role').eq('id', 'u').maybeSingle();
          return data ? { userId: 'u', role: data.role } : null;
        });
        export async function requireCmsAdmin() { await getCmsActor(); return { supabase: getServiceRoleSupabaseClient() }; }
        export async function requireCmsStaff() { await getCmsActor(); return { supabase: getServiceRoleSupabaseClient() }; }`,
      'service-key.ts': 'export function resolveSupabaseServiceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }\n',
      // sendEmail reads the SMTP settings with the service role.
      'email.ts': `import { getServiceRoleSupabaseClient } from './db-server';
        async function readSmtpSettings() { return getServiceRoleSupabaseClient().from('site_settings').select('value'); }
        export async function sendEmail(input: unknown) { await readSmtpSettings(); return input; }`,
      // markSyncWorkflowInstalled writes system_configuration with the service role.
      'check-upstream.ts': `import { getServiceRoleSupabaseClient } from './db-server';
        async function setSystemConfigurationServiceRole(patch: unknown) { await getServiceRoleSupabaseClient().from('system_configuration').update(patch); }
        export async function markSyncWorkflowInstalled() { await setSystemConfigurationServiceRole({}); }`,
      // The key derives HMAC secrets and picks a storage backend; neither builds a client.
      'app-secrets.ts': `import { resolveSupabaseServiceKey } from './service-key';
        export function resolveRevalidateSecret() { return process.env.SUPABASE_SECRET_KEY ?? ''; }
        export function storageBackend() { return resolveSupabaseServiceKey() ? 'supabase' : 's3'; }`,
      ...files,
    };
    try {
      for (const [name, source] of Object.entries(all)) fs.writeFileSync(path.join(dir, name), source);
      const resolveImport = (from: string, spec: string) => {
        const base = spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
        return base === null ? null : (['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)) ?? null);
      };
      const result = analyzeRoleReadsBeforeServiceRole(
        entries.map((name) => path.join(dir, name)),
        {
          resolveImport,
          root: dir,
          helpers: helpers.map((name) => [path.join(dir, 'cms-actor.ts'), name]),
          sources: [[path.join(dir, 'db-server.ts'), 'getServiceRoleSupabaseClient']],
          keyReaders: [[path.join(dir, 'service-key.ts'), 'resolveSupabaseServiceKey']],
          roleReaders: [[path.join(dir, 'db-server.ts'), 'getProfileWithRoleServerSide']],
        }
      );
      const problems = result.problems as RoleReadProblem[];
      return { actions: result.actions as string[], flagged: problems.map((p) => (p.action ? `${p.file}#${p.action}` : p.problem)), problems };
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }

  it('reads the top-level columns of a select', () => {
    expect(selectedColumns('id, full_name, role')).toEqual(['id', 'full_name', 'role']);
    expect(selectedColumns('kind:role::text, author:profiles(role, full_name)')).toEqual(['role', 'profiles']);
    expect(selectedColumns('*')).toEqual(['*']);
    expect(selectedColumns('roles, role_label')).toEqual(['roles', 'role_label']);
  });

  it('catches the pre-2026-11-13 interaction actions (getProfileWithRoleServerSide, then the service role)', () => {
    const { flagged, problems } = roleReads({
      'interactions.ts': `"use server";
        import { createClient, getProfileWithRoleServerSide, getServiceRoleSupabaseClient } from './db-server';
        export async function replyToInteraction(parentId: string, content: string) {
          const { data: { user } } = await createClient().auth.getUser();
          const profile = await getProfileWithRoleServerSide(user.id);
          if (!profile || profile.role !== 'ADMIN') return { error: 'Unauthorized' };
          await getServiceRoleSupabaseClient().from('cms_interactions').insert({ parent_id: parentId, content });
        }
        export async function toggleReaction(interactionId: string) {
          const { data: { user } } = await createClient().auth.getUser();
          if (!user) return { error: 'Sign in' };
          await getServiceRoleSupabaseClient().from('cms_interactions').update({}).eq('id', interactionId);
        }`,
    });
    // toggleReaction is public by design (any signed-in user, no role read): not flagged.
    expect(flagged).toEqual(['interactions.ts#replyToInteraction']);
    expect(problems[0].roleRead).toBe('interactions.ts:5');
    expect(problems[0].serviceRole).toBe('interactions.ts:7');
  });

  it('catches a role-only helper of the module, an inline role read, and a select of *', () => {
    const { flagged } = roleReads({
      'actions.ts': `"use server";
        import { createClient, getServiceRoleSupabaseClient } from './db-server';
        async function verifyAdmin(supabase: ReturnType<typeof createClient>) {
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', 'u').single();
          return profile?.role === 'ADMIN';
        }
        export async function updateLanguageDetectionSettings(input: unknown) {
          if (!(await verifyAdmin(createClient()))) return { error: 'Unauthorized' };
          await getServiceRoleSupabaseClient().from('site_settings').upsert({ value: input });
        }
        export async function getFormEndpointForEditor(formKey: string) {
          const supabase = createClient();
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', 'u').maybeSingle();
          if (profile?.role !== 'ADMIN' && profile?.role !== 'WRITER') return null;
          return getServiceRoleSupabaseClient().from('form_endpoints').select('label').eq('form_key', formKey).maybeSingle();
        }
        export async function starProfile(formKey: string) {
          const { data: profile } = await (createClient() as any).from('profiles').select('*').eq('id', 'u').single();
          if (profile?.role !== 'ADMIN') return null;
          return getServiceRoleSupabaseClient().from('form_endpoints').delete().eq('form_key', formKey);
        }
        export async function updateLanguage(languageId: number) {
          if (!(await verifyAdmin(createClient()))) return { error: 'Unauthorized' };
          await createClient().from('languages').update({}).eq('id', languageId);
        }`,
    });
    // updateLanguage writes through the cookie client only (RLS decides): no service role, not flagged.
    expect(flagged).toEqual(['actions.ts#updateLanguageDetectionSettings', 'actions.ts#getFormEndpointForEditor', 'actions.ts#starProfile']);
  });

  it('follows calls into other modules that reach the service role (the pre-2026-11-13 test email and GitHub poll)', () => {
    const { flagged } = roleReads({
      'email-actions.ts': `'use server';
        import { createClient } from './db-server';
        import { sendEmail } from './email';
        async function adminCheck() {
          const supabase = createClient();
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', 'u').single();
          return profile?.role === 'ADMIN' ? null : { ok: false };
        }
        export async function sendTestEmail(formData: FormData) {
          const denied = await adminCheck();
          if (denied) return denied;
          await sendEmail({ to: formData.get('to') });
        }`,
      'github-connect-actions.ts': `'use server';
        import { createClient } from './db-server';
        import { markSyncWorkflowInstalled } from './check-upstream';
        async function isAdmin() {
          const { data: profile } = await createClient().from('profiles').select('role').eq('id', 'u').single();
          return profile?.role === 'ADMIN';
        }
        export async function pollGithubConnect() {
          if (!(await isAdmin())) return { status: 'error' };
          await markSyncWorkflowInstalled();
        }
        export async function startGithubConnect() {
          if (!(await isAdmin())) return { ok: false };
          return { ok: true };
        }`,
    });
    expect(flagged).toEqual(['email-actions.ts#sendTestEmail', 'github-connect-actions.ts#pollGithubConnect']);
  });

  it('catches a client the module builds from the secret key (the pre-2026-11-13 package actions and markOrderAsPaid)', () => {
    const { flagged } = roleReads({
      'package-actions.ts': `'use server';
        import { createClient as createSupabaseClient } from '@supabase/supabase-js';
        import { createClient as createCookieClient } from './db-server';
        import { resolveSupabaseServiceKey } from './service-key';
        const getServiceRoleClient = () => createSupabaseClient('http://db', resolveSupabaseServiceKey()!);
        export async function activatePackage(key: string) {
          const { data: profile } = await createCookieClient().from('profiles').select('role').eq('id', 'u').single();
          if (profile?.role !== 'ADMIN') return { error: 'Admins only' };
          await getServiceRoleClient().from('package_activations').upsert({ license_key: key });
        }`,
      'orders.ts': `'use server';
        import * as supabaseJs from '@supabase/supabase-js';
        import { createClient } from './db-server';
        export async function markOrderAsPaid(orderId: string) {
          const { data: profile } = await createClient().from('profiles').select('role').eq('id', 'u').single();
          if (profile?.role !== 'ADMIN') return;
          const admin = supabaseJs.createClient('http://db', process.env.SUPABASE_SERVICE_ROLE_KEY!);
          await admin.from('orders').update({ status: 'paid' }).eq('id', orderId);
        }`,
    });
    expect(flagged).toEqual(['orders.ts#markOrderAsPaid', 'package-actions.ts#activatePackage']);
  });

  it('passes the fixed shapes: getCmsActor() or requireCmsAdmin() first, directly, renamed or through a wrapper module', () => {
    const { flagged, actions } = roleReads({
      'require-admin.ts': `import { getCmsActor } from './cms-actor';
        import { createClient } from './db-server';
        export async function requireAdminSupabaseClient() {
          const actor = await getCmsActor();
          if (!actor || actor.role !== 'ADMIN') throw new Error('Forbidden');
          const { data: profile } = await createClient().from('profiles').select('full_name, role').eq('id', actor.userId).maybeSingle();
          return { fullName: profile?.full_name ?? null };
        }`,
      'actions.ts': `"use server";
        import { getServiceRoleSupabaseClient } from './db-server';
        import { getCmsActor as actorOf, requireCmsAdmin } from './cms-actor';
        import { requireAdminSupabaseClient } from './require-admin';
        export async function updateInteractionStatus(id: string) {
          const actor = await actorOf();
          if (actor?.role !== 'ADMIN') return { error: 'Unauthorized' };
          await getServiceRoleSupabaseClient().from('cms_interactions').update({}).eq('id', id);
        }
        export async function updateLanguageDetectionSettings(input: unknown) {
          const { supabase } = await requireCmsAdmin();
          await supabase.from('site_settings').upsert({ value: input });
        }
        export async function retryThreadDelivery(id: string) {
          await requireAdminSupabaseClient();
          await getServiceRoleSupabaseClient().from('thread_messages').select('id').eq('id', id);
        }`,
    }, ['actions.ts']);
    expect(flagged).toEqual([]);
    expect(actions).toEqual(['actions.ts#retryThreadDelivery', 'actions.ts#updateInteractionStatus', 'actions.ts#updateLanguageDetectionSettings']);
  });

  it('does not count a key read that builds no client, or a head-only count of profiles', () => {
    const { flagged } = roleReads({
      'actions.ts': `"use server";
        import { createClient, getServiceRoleSupabaseClient } from './db-server';
        import { resolveRevalidateSecret, storageBackend } from './app-secrets';
        export async function revalidateAndLog(path: string) {
          const ok = resolveRevalidateSecret() === 'x' || storageBackend() === 'supabase';
          const { data: profile } = await createClient().from('profiles').select('role').eq('id', 'u').maybeSingle();
          return ok || profile?.role === 'ADMIN' ? path : null;
        }
        export async function countStaff() {
          const { count } = await getServiceRoleSupabaseClient().from('profiles').select('*', { count: 'exact', head: true });
          return count;
        }`,
    });
    expect(flagged).toEqual([]);
  });

  it('does not count a local function that only shares a helper name, nor a role read through the service role', () => {
    const { flagged } = roleReads({
      'actions.ts': `"use server";
        import { createClient, getServiceRoleSupabaseClient } from './db-server';
        async function getCmsActor() {
          const { data } = await createClient().from('profiles').select('role').eq('id', 'u').maybeSingle();
          return data;
        }
        export async function lookalike(id: string) {
          const actor = await getCmsActor();
          if (actor?.role !== 'ADMIN') return null;
          return getServiceRoleSupabaseClient().from('orders').select('*').eq('id', id);
        }
        export async function roleThroughServiceRole(id: string) {
          const service = getServiceRoleSupabaseClient();
          const { data: profile } = await service.from('profiles').select('id, role').eq('id', 'u').maybeSingle();
          if (profile?.role !== 'ADMIN') return null;
          return service.from('orders').select('*').eq('id', id);
        }`,
    });
    expect(flagged).toEqual(['actions.ts#lookalike', 'actions.ts#roleThroughServiceRole']);
  });

  it('checks inline actions in server components, and reports a listed helper that is gone', () => {
    const { flagged } = roleReads({
      'page.tsx': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
        export async function helperThatIsNotAnAction() {
          const { data } = await createClient().from('profiles').select('role').eq('id', 'u').single();
          return data && getServiceRoleSupabaseClient();
        }
        export default function Page() {
          async function save(formData: FormData) {
            'use server';
            const { data: profile } = await createClient().from('profiles').select('role').eq('id', 'u').single();
            if (profile?.role !== 'ADMIN') return;
            await getServiceRoleSupabaseClient().from('site_settings').upsert({ value: formData.get('v') });
          }
          return save;
        }`,
    });
    expect(flagged).toEqual(['page.tsx#save']);

    expect(roleReads({}, [], ['getCmsActor', 'requireCmsSuperAdmin']).flagged).toEqual([
      'cms-actor.ts no longer exports requireCmsSuperAdmin(); update SECOND_FACTOR_HELPERS',
    ]);
  });
});

describe('no CMS or app/actions server action reads the role on its way to the service role without a second-factor helper', () => {
  // Analyzed once at collection time from the shared scan.
  const { actions, problems } = findRoleReadsBeforeServiceRole(repositoryModules) as {
    actions: string[];
    problems: Array<{ action?: string; file: string; problem: string }>;
  };

  /**
   * Actions the check flags that may stay, each with why (an entry the check no longer flags fails).
   * "Known ... not yet fixed" entries are real and owed a fix; the rest are reviewed exceptions.
   */
  const ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED = new Map<string, string>([
    [
      'apps/nextblock/app/cms/settings/security/actions.ts#getSecurityPanelData',
      'Reviewed: requireUser() runs evaluateTwoFactor() itself and refuses totp_required / email_required before any read (the factor-management screen needs the raw evaluation, not a CMS role). The service role it reaches is that check\'s own trusted-device lookup (hasValidTrustedDevice), and the role it reads only decides whether the panel shows the admin settings, whose actions save through requireCmsAdmin() (updateSystemConfiguration, saveSecuritySettings).',
    ],
  ]);

  it('sees the server actions of app/cms and app/actions, and only those', () => {
    expect(actions.length).toBeGreaterThan(150);
    expect(actions).toEqual(
      expect.arrayContaining([
        'apps/nextblock/app/actions/interactions.ts#replyToInteraction',
        'apps/nextblock/app/actions/interactions.ts#updateInteractionStatus',
        'apps/nextblock/app/cms/settings/languages/actions.ts#updateLanguageDetectionSettings',
        'apps/nextblock/app/cms/messages/actions.ts#getFormEndpointForEditor',
        'apps/nextblock/app/cms/settings/email/actions.ts#sendTestEmail',
        'apps/nextblock/app/cms/components/github-connect-actions.ts#pollGithubConnect',
        'apps/nextblock/app/actions/package-actions.ts#activatePackage',
        'apps/nextblock/app/actions/feedback.ts#submitFeedback',
        'apps/nextblock/app/cms/media/actions.ts#deleteMediaItem',
        'apps/nextblock/app/cms/media/actions.ts#deleteMultipleMediaItems',
        'apps/nextblock/app/cms/media/actions.ts#moveMultipleMediaItems',
        'apps/nextblock/app/cms/media/actions.ts#moveSingleMediaItem',
      ])
    );
    expect(actions.filter((action) => !SECOND_FACTOR_SCOPES.some((scope: string) => action.startsWith(scope)))).toEqual([]);
    expect(SECOND_FACTOR_HELPERS.map(([, name]: [string, string]) => name)).toEqual([
      'requireCmsAdmin',
      'requireCmsStaff',
      'getCmsActor',
      'requireEcomAdmin',
      'requireEcomStaff',
      'requireRetailer',
      'requireRetailerPage',
      'requireActorRole',
    ]);
  });

  it('finds none outside the reviewed list', () => {
    const offenders = problems
      .filter((p) => !p.action || !ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED.has(`${p.file}#${p.action}`))
      .map((p) => p.problem);
    expect(offenders).toEqual([]);
  });

  it('lists only actions the check still flags', () => {
    const flagged = new Set(problems.map((p) => `${p.file}#${p.action}`));
    expect([...ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED.keys()].filter((key) => !flagged.has(key))).toEqual([]);
  });
});

describe('a staff upload route resolves the actor, second factor included, before anything runs', () => {
  // 2026-11-14: /api/media/r2-presigned, /api/upload/presigned-url, /api/upload/proxy,
  // /api/process-image and /api/media/record read the role through the cookie client and never
  // checked the enrolled second factor, so a staff password alone signed upload URLs, wrote and
  // read bucket objects and recorded media rows: a route handler never passes the CMS layout's 2FA
  // redirect. The fixtures stand in for @nextblock-cms/db/server, the gate, the storage clients,
  // the signer and the Supabase storage helpers those routes call.

  type GateProblem = { file: string; kind: string; handler?: string; operation?: string; problem: string };

  const STAND_INS: Record<string, string> = {
    'db-server.ts': `export function createClient() { return {} as any; }
      export function getServiceRoleSupabaseClient() { return {} as any; }`,
    // The real helper reads a trusted device with the service role: as the gate it never counts.
    'cms-actor.ts': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
      export async function getCmsActor() {
        await getServiceRoleSupabaseClient().from('user_trusted_devices').select('id');
        const { data } = await createClient().from('profiles').select('role').eq('id', 'u').maybeSingle();
        return data ? { userId: 'u', role: data.role } : null;
      }
      export function isCmsStaffRole(role: string | null | undefined) { return role === 'ADMIN' || role === 'WRITER'; }`,
    'utils-server.ts': `export async function getS3Client() { return {} as any; }
      export async function getS3PresignClient() { return {} as any; }`,
    'presigned-put.ts': 'export async function presignBoundPut(client: unknown, input: unknown) { return { url: String(client), headers: input }; }\n',
    'supabase-storage.ts': `import { getServiceRoleSupabaseClient } from './db-server';
      export async function supabaseUploadObject(key: string) { await getServiceRoleSupabaseClient().storage.from('media').upload(key, ''); }`,
    'refusals.ts': `import { createClient } from './db-server';
      export async function hasSignedInUser() { const { data } = await createClient().auth.getUser(); return Boolean(data.user); }
      export function deny(status: number) { return new Response(null, { status }); }`,
  };

  /** The fixed route's opening: the gate and its two refusals. */
  const GATE = `const actor = await getCmsActor();
    if (!actor) {
      return (await hasSignedInUser()) ? deny(403) : deny(401);
    }
    if (!isCmsStaffRole(actor.role)) return deny(403);`;

  const IMPORTS = `import { createClient } from './db-server';
    import { getCmsActor, isCmsStaffRole } from './cms-actor';
    import { getS3Client, getS3PresignClient } from './utils-server';
    import { presignBoundPut } from './presigned-put';
    import { supabaseUploadObject } from './supabase-storage';
    import { deny, hasSignedInUser } from './refusals';`;

  /**
   * Writes the fixture (plus stand-ins) into a fresh directory and runs the check over `entries`.
   * `extraSinks` are [file name, export] pairs added to the upload sinks (the AI routes' model
   * client); `listName` is passed through when set.
   */
  function routeGates(
    files: Record<string, string>,
    entries = Object.keys(files),
    { extraSinks = [], listName }: { extraSinks?: Array<[string, string]>; listName?: string } = {}
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-gate-'));
    try {
      for (const [name, source] of Object.entries({ ...STAND_INS, ...files })) fs.writeFileSync(path.join(dir, name), source);
      const resolveImport = (from: string, spec: string) => {
        const base = spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
        return base === null ? null : (['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)) ?? null);
      };
      const at = (name: string) => path.join(dir, name);
      const result = analyzeStaffRouteGates(
        entries.map(at),
        {
          resolveImport,
          root: dir,
          gate: [at('cms-actor.ts'), 'getCmsActor'],
          sinks: [
            [at('db-server.ts'), 'getServiceRoleSupabaseClient'],
            [at('utils-server.ts'), 'getS3Client'],
            [at('utils-server.ts'), 'getS3PresignClient'],
            [at('presigned-put.ts'), 'presignBoundPut'],
            ...extraSinks.map(([name, exported]) => [at(name), exported]),
          ],
          ...(listName ? { listName } : {}),
        }
      );
      const problems = result.problems as GateProblem[];
      return {
        handlers: result.handlers as string[],
        problems,
        flagged: problems.map((p) => `${p.file}#${p.handler ?? '-'}:${p.kind}${p.operation ? ` ${p.operation}` : ''}`),
      };
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }

  it('catches the pre-2026-11-14 routes: a cookie-client role read, then storage, the body or a media row', () => {
    const { flagged, handlers } = routeGates({
      'proxy.ts': `${IMPORTS}
        export async function POST(request: Request) {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return deny(401);
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
          if (!profile || !['ADMIN', 'WRITER'].includes(profile.role)) return deny(403);
          const form = await request.formData();
          const client = await getS3Client();
          await client.send({ Body: form.get('file') });
          return new Response('ok');
        }`,
      'record.ts': `${IMPORTS}
        export const dynamic = 'force-dynamic';
        export async function POST(request: Request) {
          try {
            const payload = await request.json();
            const supabase = createClient();
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return deny(401);
            const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
            if (!profile || !['ADMIN', 'WRITER'].includes(profile.role)) return deny(403);
            await supabase.from('media').insert(payload);
            return deny(201);
          } catch {
            return deny(500);
          }
        }`,
    });
    expect(handlers).toEqual(['proxy.ts#POST', 'record.ts#POST']);
    expect(flagged).toEqual(['proxy.ts#POST:no-gate', 'record.ts#POST:no-gate']);
  });

  it('passes the fixed shapes: the gate in the body or in a try whose catch returns, one combined refusal, an ADMIN-only rule', () => {
    const { flagged, handlers } = routeGates({
      'presigned-url.ts': `${IMPORTS}
        export async function POST(request: Request) {
          ${GATE}
          const body = await request.json();
          const client = await getS3PresignClient();
          const { url } = await presignBoundPut(client, { key: body.key, metadata: { uploader: actor.userId } });
          return Response.json({ url });
        }`,
      'r2-presigned.ts': `${IMPORTS}
        export async function POST(request: Request) {
          try {
            ${GATE}
            const body = await request.json();
            await supabaseUploadObject(String(body.key));
            return deny(200);
          } catch (error) {
            console.error(error);
            return deny(500);
          }
        }`,
      'process-image.ts': `${IMPORTS}
        export const POST = async (request: Request) => {
          const actor = await getCmsActor();
          if (!actor || !isCmsStaffRole(actor.role)) {
            return deny(actor ? 403 : 401);
          }
          const client = await getS3Client();
          const put = async (key: string) => client.send({ key });
          await put((await request.json()).key);
          return deny(200);
        };`,
      'admin-only.ts': `${IMPORTS}
        export async function DELETE(request: Request) {
          const actor = await getCmsActor();
          if (actor == null) throw new Error('Unauthorized');
          if (actor.role !== 'ADMIN') return deny(403);
          await createClient().from('media').delete().eq('id', new URL(request.url).searchParams.get('id'));
          return deny(204);
        }`,
    });
    expect(flagged).toEqual([]);
    expect(handlers).toEqual(['admin-only.ts#DELETE', 'presigned-url.ts#POST', 'process-image.ts#POST', 'r2-presigned.ts#POST']);
  });

  it('fails a gate that can be skipped, swallowed, rebound or never awaited', () => {
    const { flagged } = routeGates({
      'branch.ts': `${IMPORTS}
        export async function POST(request: Request) {
          if (request.headers.get('x-strict')) {
            ${GATE}
          }
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'swallowed.ts': `${IMPORTS}
        export async function POST() {
          try {
            ${GATE}
          } catch {
            // falls through to the upload
          }
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'caught.ts': `${IMPORTS}
        export async function POST() {
          const actor = await getCmsActor().catch(() => null);
          if (!actor) return deny(401);
          if (!isCmsStaffRole(actor.role)) return deny(403);
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'unawaited.ts': `${IMPORTS}
        export async function POST() {
          const actor = getCmsActor() as any;
          if (!actor) return deny(401);
          if (!isCmsStaffRole(actor.role)) return deny(403);
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'reassigned.ts': `${IMPORTS}
        export async function POST() {
          let actor = await getCmsActor();
          actor = { userId: 'u', role: 'ADMIN' };
          if (!actor) return deny(401);
          if (!isCmsStaffRole(actor.role)) return deny(403);
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'lookalike.ts': `${IMPORTS.replace('getCmsActor, ', '')}
        async function getCmsActor() { return { userId: 'u', role: 'ADMIN' }; }
        export async function POST() {
          ${GATE}
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'shadowed.ts': `${IMPORTS}
        export async function POST(request: Request, getCmsActor: () => Promise<{ userId: string; role: string } | null>) {
          ${GATE}
          await supabaseUploadObject(request.url);
          return deny(200);
        }`,
    });
    expect(flagged).toEqual([
      'branch.ts#POST:no-gate',
      'caught.ts#POST:no-gate',
      'lookalike.ts#POST:no-gate',
      'reassigned.ts#POST:no-gate',
      'shadowed.ts#POST:no-gate',
      'swallowed.ts#POST:no-gate',
      'unawaited.ts#POST:no-gate',
    ]);
  });

  it('fails refusals that let the caller through, and work placed before or beside them', () => {
    const { flagged } = routeGates({
      'no-refusals.ts': `${IMPORTS}
        export async function POST() {
          const actor = await getCmsActor();
          if (!actor) console.warn('no actor');
          if (actor && actor.role === 'USER') console.warn('customer');
          await supabaseUploadObject('k');
          return deny(200);
        }`,
      'body-first.ts': `${IMPORTS}
        export async function POST(request: Request) {
          const body = await request.json();
          ${GATE}
          await supabaseUploadObject(String(body.key));
          return deny(200);
        }`,
      'between.ts': `${IMPORTS}
        export async function POST(request: Request) {
          const actor = await getCmsActor();
          const client = await getS3Client();
          if (!actor) return deny(401);
          if (!isCmsStaffRole(actor.role)) return deny(403);
          await client.send({ body: request.body });
          return deny(200);
        }`,
      'in-refusal.ts': `${IMPORTS}
        export async function POST() {
          const actor = await getCmsActor();
          if (!actor) {
            await supabaseUploadObject('anonymous');
            return deny(401);
          }
          if (!isCmsStaffRole(actor.role)) return deny(403);
          return deny(200);
        }`,
      'in-catch.ts': `${IMPORTS}
        export async function POST() {
          try {
            ${GATE}
            return deny(200);
          } catch {
            await createClient().from('media').insert({ failed: true });
            return deny(500);
          }
        }`,
      'helpers.ts': `${IMPORTS}
        async function readBody(request: Request) { return request.text(); }
        async function logUpload(key: string) { await createClient().rpc('log_upload', { key }); }
        export async function POST(request: Request) {
          const text = await readBody(request);
          await logUpload('early');
          ${GATE}
          return deny(text ? 200 : 400);
        }`,
    });
    expect(flagged).toEqual([
      'between.ts#POST:ungated-operation getS3Client()',
      'body-first.ts#POST:ungated-operation request.json()',
      'helpers.ts#POST:ungated-operation a call handed request',
      'helpers.ts#POST:ungated-operation logUpload()',
      'in-catch.ts#POST:ungated-operation .from(\'media\')',
      'in-refusal.ts#POST:ungated-operation supabaseUploadObject()',
      'no-refusals.ts#POST:no-missing-check',
      'no-refusals.ts#POST:no-role-check',
    ]);
  });

  it('reports a listed route without a handler, and a gate or sink that is gone', () => {
    expect(routeGates({ 'empty.ts': 'export const dynamic = "force-dynamic";\n' }).flagged).toEqual(['empty.ts#-:no-handler']);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-gate-'));
    try {
      fs.writeFileSync(path.join(dir, 'cms-actor.ts'), 'export async function requireCmsStaff() { return null; }\n');
      const result = analyzeStaffRouteGates([], {
        root: dir,
        gate: [path.join(dir, 'cms-actor.ts'), 'getCmsActor'],
        sinks: [[path.join(dir, 'cms-actor.ts'), 'getS3Client']],
      });
      expect((result.problems as GateProblem[]).map((p) => p.problem)).toEqual([
        'cms-actor.ts no longer exports getCmsActor(); update STAFF_ROUTE_GATE',
        'cms-actor.ts no longer exports getS3Client(); update STAFF_ROUTE_SINKS',
      ]);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  // 2026-11-14, later the same day: six staff routes outside the upload folders still read the role
  // through the cookie client, then reached the service role (the product picker's catalog read, the
  // update check's system_configuration write) or the Cortex AI request quota (recorded with the
  // service role) and the operator's model key. STAFF_ROUTES holds them to the same gate, with the
  // model client as one more sink.
  const AI_STAND_INS = {
    'request-quota.ts': `import { getServiceRoleSupabaseClient } from './db-server';
      export async function enforceCortexAiRequestQuota(params: { role: string; userId: string }) {
        await getServiceRoleSupabaseClient().from('cortex_request_log').insert(params);
        return null;
      }`,
    'ai-client.ts': 'export async function createCortexAiOpenRouterClient() { return { model: (id: string) => id }; }\n',
    'ai-generation.ts': `import { createCortexAiOpenRouterClient } from './ai-client';
      export async function generateHtml(prompt: string) { const client = await createCortexAiOpenRouterClient(); return client.model(prompt); }`,
  };
  const AI_IMPORTS = `${IMPORTS}
    import { enforceCortexAiRequestQuota } from './request-quota';
    import { createCortexAiOpenRouterClient } from './ai-client';
    import { generateHtml } from './ai-generation';`;

  it('catches the pre-fix staff AI and CMS routes, passes their fixed shape, and counts the model client as a sink', () => {
    const { flagged, handlers } = routeGates(
      {
        ...AI_STAND_INS,
        'generate-blocks-before.ts': `${AI_IMPORTS}
          async function requireCmsEditorAccess() {
            const supabase = createClient();
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return null;
            const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
            return profile && (profile.role === 'ADMIN' || profile.role === 'WRITER') ? { role: profile.role, userId: user.id } : null;
          }
          export async function POST(request: Request) {
            try {
              const access = await requireCmsEditorAccess();
              if (!access) return deny(403);
              const quota = await enforceCortexAiRequestQuota(access);
              if (quota) return quota;
              return Response.json({ html: await generateHtml((await request.json()).prompt) });
            } catch {
              return deny(500);
            }
          }`,
        'generate-blocks-after.ts': `${AI_IMPORTS}
          export async function POST(request: Request) {
            try {
              ${GATE}
              const quota = await enforceCortexAiRequestQuota({ role: actor.role, userId: actor.userId });
              if (quota) return quota;
              return Response.json({ html: await generateHtml((await request.json()).prompt) });
            } catch (error) {
              console.error(error);
              return deny(500);
            }
          }`,
        'model-first.ts': `${AI_IMPORTS}
          export async function POST() {
            const client = await createCortexAiOpenRouterClient();
            ${GATE}
            return Response.json({ model: client.model('openrouter/free') });
          }`,
        'quota-first.ts': `${AI_IMPORTS}
          export async function POST() {
            const quota = await enforceCortexAiRequestQuota({ role: 'WRITER', userId: 'u' });
            ${GATE}
            return quota ?? deny(200);
          }`,
      },
      ['generate-blocks-before.ts', 'generate-blocks-after.ts', 'model-first.ts', 'quota-first.ts'],
      { extraSinks: [['ai-client.ts', 'createCortexAiOpenRouterClient']], listName: 'STAFF_ROUTES' }
    );
    expect(handlers).toEqual([
      'generate-blocks-after.ts#POST',
      'generate-blocks-before.ts#POST',
      'model-first.ts#POST',
      'quota-first.ts#POST',
    ]);
    expect(flagged).toEqual([
      'generate-blocks-before.ts#POST:no-gate',
      'model-first.ts#POST:ungated-operation createCortexAiOpenRouterClient()',
      'quota-first.ts#POST:ungated-operation enforceCortexAiRequestQuota()',
    ]);
  });

  it('names the list a route came from in its problems', () => {
    const { problems } = routeGates({ 'empty.ts': 'export const dynamic = "force-dynamic";\n' }, ['empty.ts', 'gone.ts'], {
      listName: 'STAFF_ROUTES',
    });
    expect(problems.map((p) => p.problem)).toEqual([
      'empty.ts exports no HTTP method handler; update STAFF_ROUTES',
      'gone.ts is listed in STAFF_ROUTES but cannot be read; update the list',
    ]);
  });
});

describe('every staff upload route in the repository opens with the second-factor gate', () => {
  const { handlers, problems, unlisted } = findStaffUploadRouteGates(repositoryModules) as {
    handlers: string[];
    problems: Array<{ problem: string }>;
    unlisted: string[];
  };

  /**
   * Route modules under STAFF_UPLOAD_ROUTE_SCOPES that are not staff upload routes, each with why. A
   * new route there must join STAFF_UPLOAD_ROUTES (and its gate) or this list; a stale entry fails.
   */
  const NOT_STAFF_UPLOAD_ROUTES = new Map<string, string>([
    [
      'apps/nextblock/app/api/media/library/route.ts',
      'Reviewed 2026-11-14: the media picker\'s read of the media table, through a client built with the publishable key and no session. media_read_policy publishes that table to anon, so it reaches no storage, no service role and no write, and its staff check (a cookie-client role read) guards nothing the Data API does not already serve.',
    ],
  ]);

  it('checks the five staff upload routes', () => {
    expect(STAFF_UPLOAD_ROUTE_SCOPES.length).toBeGreaterThan(0);
    expect(handlers).toEqual(STAFF_UPLOAD_ROUTES.map((route: string) => `${route}#POST`).sort());
  });

  it('finds none without the gate', () => {
    expect(problems.map((p) => p.problem)).toEqual([]);
  });

  it('knows every route module in those directories', () => {
    expect(unlisted).toEqual([...NOT_STAFF_UPLOAD_ROUTES.keys()].sort());
  });
});

describe('every other staff route in the repository opens with the second-factor gate', () => {
  const { handlers, problems, unlisted } = findStaffRouteGates(repositoryModules) as {
    handlers: string[];
    problems: Array<{ problem: string }>;
    unlisted: string[];
  };

  /**
   * Route modules under STAFF_ROUTE_SCOPES that are not in STAFF_ROUTES, each with why. A new route
   * there must join STAFF_ROUTES (and its gate) or this list; a stale entry fails.
   */
  const NOT_STAFF_ROUTES = new Map<string, string>([
    [
      'apps/nextblock/app/api/ai/global-agent/route.ts',
      'Reviewed 2026-11-14: requireAdminAccess() reads the caller\'s own role (retrying getUser() after a session refresh, which the streamed answer needs) and then runs evaluateTwoFactor() itself, refusing totp_required / email_required before the request quota, the package check or the body. Its tools run through requireActorRole() as well.',
    ],
    [
      'apps/nextblock/app/api/cms/full-backup/export/route.ts',
      'Reviewed 2026-11-14: exportFullBackupArchive() opens with requireAdminUser() (lib/full-backup/server.ts), which reads the caller\'s own role, runs evaluateTwoFactor() itself (refusing unless satisfied or not enrolled) and refuses the public sandbox before R2, pg_dump or GoTrue.',
    ],
    [
      'apps/nextblock/app/api/cms/full-backup/restore/route.ts',
      'Reviewed 2026-11-14: the handler awaits requireFullBackupAdmin() first, before the form data is read: the same requireAdminUser() check as the export (role, evaluateTwoFactor(), the sandbox refusal) ahead of the archive, psql, R2 or GoTrue.',
    ],
  ]);

  it('checks the six staff routes', () => {
    expect(STAFF_ROUTE_SCOPES.length).toBeGreaterThan(0);
    expect(STAFF_ROUTES).toHaveLength(6);
    expect(handlers).toEqual([
      'apps/nextblock/app/api/ai/cortex/build-widget/route.ts#POST',
      'apps/nextblock/app/api/ai/generate-blocks/route.ts#POST',
      'apps/nextblock/app/api/ai/seo/alt-text/route.ts#POST',
      'apps/nextblock/app/api/ai/seo/metadata/route.ts#POST',
      'apps/nextblock/app/api/cms/check-updates/route.ts#POST',
      'apps/nextblock/app/api/cms/ecommerce/product-picker/route.ts#GET',
    ]);
  });

  it('finds none without the gate', () => {
    expect(problems.map((p) => p.problem)).toEqual([]);
  });

  it('knows every route module in those directories', () => {
    expect(unlisted).toEqual([...NOT_STAFF_ROUTES.keys()].sort());
  });
});

describe('a route handler that reads the role on its way to the service role needs a second-factor helper', () => {
  // 2026-11-14: the six staff routes outside the upload folders read the role through the cookie
  // client and then reached the service role, directly (the product picker) or through a module
  // (the update check's system_configuration write, the Cortex AI request quota), with no second
  // factor. The fixtures stand in for @nextblock-cms/db/server, the helpers and those modules.

  type RouteRoleReadProblem = { file: string; handler?: string; line?: number; roleRead?: string; serviceRole?: string; problem: string };

  const STAND_INS: Record<string, string> = {
    'db-server.ts': `export function createClient() { return {} as any; }
      export function getServiceRoleSupabaseClient() { return {} as any; }
      export async function getProfileWithRoleServerSide(id: string) {
        return createClient().from('profiles').select('id, full_name, role').eq('id', id).single();
      }`,
    'cms-actor.ts': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
      function cache<T>(fn: T) { return fn; }
      export const getCmsActor = cache(async () => {
        const { data } = await createClient().from('profiles').select('role').eq('id', 'u').maybeSingle();
        return data ? { userId: 'u', role: data.role } : null;
      });
      export async function requireCmsAdmin() { await getCmsActor(); return { supabase: getServiceRoleSupabaseClient() }; }`,
    'service-key.ts': 'export function resolveSupabaseServiceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }\n',
    // refreshUpstreamStatus records the upstream status in system_configuration with the service role.
    'check-upstream.ts': `import { getServiceRoleSupabaseClient } from './db-server';
      async function setSystemConfigurationServiceRole(patch: unknown) { await getServiceRoleSupabaseClient().from('system_configuration').update(patch); }
      export async function refreshUpstreamStatus() { await setSystemConfigurationServiceRole({}); return { ok: true }; }`,
    // The Cortex AI request quota records a row per call with the service role.
    'request-quota.ts': `import { getServiceRoleSupabaseClient } from './db-server';
      export async function enforceCortexAiRequestQuota(params: { role: string; userId: string }) {
        await getServiceRoleSupabaseClient().from('cortex_request_log').insert(params);
        return null;
      }`,
  };

  /** Writes the fixture (plus stand-ins) into a fresh directory and runs the check over `entries`. */
  function routeRoleReads(files: Record<string, string>, entries = Object.keys(files)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-role-read-'));
    try {
      for (const [name, source] of Object.entries({ ...STAND_INS, ...files })) fs.writeFileSync(path.join(dir, name), source);
      const resolveImport = (from: string, spec: string) => {
        const base = spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
        return base === null ? null : (['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)) ?? null);
      };
      const at = (name: string) => path.join(dir, name);
      const result = analyzeRouteRoleReadsBeforeServiceRole(entries.map(at), {
        resolveImport,
        root: dir,
        helpers: [
          [at('cms-actor.ts'), 'getCmsActor'],
          [at('cms-actor.ts'), 'requireCmsAdmin'],
        ],
        sources: [[at('db-server.ts'), 'getServiceRoleSupabaseClient']],
        keyReaders: [[at('service-key.ts'), 'resolveSupabaseServiceKey']],
        roleReaders: [[at('db-server.ts'), 'getProfileWithRoleServerSide']],
      });
      const problems = result.problems as RouteRoleReadProblem[];
      return {
        handlers: result.handlers as string[],
        problems,
        flagged: problems.map((p) => (p.handler ? `${p.file}#${p.handler}` : p.problem)),
      };
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }

  it('catches the pre-fix product picker, update check and AI routes', () => {
    const { flagged, problems } = routeRoleReads({
      'product-picker.ts': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
        export const dynamic = 'force-dynamic';
        export async function GET(request: Request) {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return new Response(null, { status: 401 });
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
          if (!profile || !['ADMIN', 'WRITER'].includes(profile.role)) return new Response(null, { status: 403 });
          return Response.json(await getServiceRoleSupabaseClient().from('products').select('*').limit(new URL(request.url).searchParams.size));
        }`,
      'check-updates.ts': `import { createClient } from './db-server';
        import { refreshUpstreamStatus } from './check-upstream';
        async function requireAdmin() {
          const supabase = createClient();
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', 'u').single();
          return profile?.role === 'ADMIN' ? null : 'Administrator role required.';
        }
        export async function POST() {
          const denied = await requireAdmin();
          if (denied) return Response.json({ error: denied }, { status: 401 });
          return Response.json(await refreshUpstreamStatus());
        }`,
      'generate-blocks.ts': `import { createClient, getProfileWithRoleServerSide } from './db-server';
        import { enforceCortexAiRequestQuota } from './request-quota';
        export async function POST(request: Request) {
          const { data: { user } } = await createClient().auth.getUser();
          const { data: profile } = await getProfileWithRoleServerSide(user.id);
          if (profile?.role !== 'ADMIN' && profile?.role !== 'WRITER') return new Response(null, { status: 403 });
          const quota = await enforceCortexAiRequestQuota({ role: profile.role, userId: user.id });
          return quota ?? Response.json(await request.json());
        }`,
    });
    expect(flagged).toEqual(['check-updates.ts#POST', 'generate-blocks.ts#POST', 'product-picker.ts#GET']);
    const picker = problems.find((p) => p.file === 'product-picker.ts');
    expect(picker?.roleRead).toBe('product-picker.ts:7');
    expect(picker?.serviceRole).toBe('product-picker.ts:9');
    expect(problems.find((p) => p.file === 'check-updates.ts')?.serviceRole).toBe('check-upstream.ts:2');
  });

  it('passes the fixed shapes, a public route without a role read, and a role read that stays on the cookie client', () => {
    const { flagged, handlers } = routeRoleReads({
      'gated.ts': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
        import { getCmsActor } from './cms-actor';
        import { refreshUpstreamStatus } from './check-upstream';
        export async function GET() {
          const actor = await getCmsActor();
          if (!actor || actor.role !== 'ADMIN') return new Response(null, { status: 403 });
          const { data } = await createClient().from('profiles').select('full_name, role').eq('id', actor.userId).maybeSingle();
          return Response.json({ data, config: await getServiceRoleSupabaseClient().from('site_settings').select('value') });
        }
        export async function POST() {
          const actor = await getCmsActor();
          if (!actor) return new Response(null, { status: 401 });
          return Response.json(await refreshUpstreamStatus());
        }`,
      'admin-helper.ts': `import { requireCmsAdmin } from './cms-actor';
        export async function DELETE() {
          const { supabase } = await requireCmsAdmin();
          return Response.json(await supabase.from('media').delete().eq('id', 'm'));
        }`,
      'webhook.ts': `import { getServiceRoleSupabaseClient } from './db-server';
        export async function POST(request: Request) {
          return Response.json(await getServiceRoleSupabaseClient().from('orders').update({ paid: true }).eq('id', (await request.json()).id));
        }`,
      'library.ts': `import { createClient } from './db-server';
        export async function GET() {
          const supabase = createClient();
          const { data: profile } = await supabase.from('profiles').select('role').eq('id', 'u').single();
          if (profile?.role !== 'ADMIN') return new Response(null, { status: 403 });
          return Response.json(await supabase.from('media').select('*'));
        }`,
    });
    expect(flagged).toEqual([]);
    expect(handlers).toEqual(['admin-helper.ts#DELETE', 'gated.ts#GET', 'gated.ts#POST', 'library.ts#GET', 'webhook.ts#POST']);
  });

  it('follows a handler through a const alias and a re-export, and fails one it cannot read', () => {
    const { flagged, handlers } = routeRoleReads({
      'shared.ts': `import { createClient, getServiceRoleSupabaseClient } from './db-server';
        export async function handle() {
          const { data: profile } = await createClient().from('profiles').select('role').eq('id', 'u').single();
          if (profile?.role !== 'ADMIN') return new Response(null, { status: 403 });
          return Response.json(await getServiceRoleSupabaseClient().from('orders').select('*'));
        }`,
      'aliased.ts': `import { handle } from './shared';
        export async function PUT() { return handle(); }
        export const PATCH = PUT;
        const read = handle;
        export const GET = read;`,
      're-exported.ts': "export { handle as POST } from './shared';\n",
      'built.ts': `import { handle } from './shared';
        function makeHandler(fn: () => Promise<Response>) { return fn; }
        export const POST = makeHandler(handle);
        export const GET = 'not a function' as unknown as () => Response;`,
    }, ['aliased.ts', 're-exported.ts', 'built.ts']);
    expect(handlers).toEqual(['aliased.ts#GET', 'aliased.ts#PATCH', 'aliased.ts#PUT', 'built.ts#GET', 'built.ts#POST', 're-exported.ts#POST']);
    expect(flagged).toEqual([
      'aliased.ts#GET',
      'aliased.ts#PATCH',
      'aliased.ts#PUT',
      'built.ts#GET',
      'built.ts#POST',
      're-exported.ts#POST',
    ]);
  });

  it('reports a listed helper that is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-role-read-'));
    try {
      fs.writeFileSync(path.join(dir, 'cms-actor.ts'), 'export async function requireCmsStaff() { return null; }\n');
      const result = analyzeRouteRoleReadsBeforeServiceRole([], {
        root: dir,
        helpers: [[path.join(dir, 'cms-actor.ts'), 'getCmsActor']],
        sources: [],
        roleReaders: [],
      });
      expect((result.problems as RouteRoleReadProblem[]).map((p) => p.problem)).toEqual([
        'cms-actor.ts no longer exports getCmsActor(); update SECOND_FACTOR_HELPERS',
      ]);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe('no route handler of the app reads the role on its way to the service role without a second-factor helper', () => {
  // Analyzed once at collection time from the shared scan.
  const { handlers, problems } = findRouteRoleReadsBeforeServiceRole(repositoryModules) as {
    handlers: string[];
    problems: Array<{ file: string; handler?: string; problem: string }>;
  };

  /** Handlers the check flags that may stay, each with why (an entry the check no longer flags fails). */
  const ROUTE_ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED = new Map<string, string>([
    [
      'apps/nextblock/app/api/cms/full-backup/restore/route.ts#POST',
      'Reviewed 2026-11-14: requireFullBackupAdmin() runs first, before the form data is read. Its requireAdminUser() (lib/full-backup/server.ts) reads the caller\'s own role and then runs evaluateTwoFactor() itself, throwing unless the factor is satisfied or not enrolled, and refuses the public sandbox; the service role this check sees is evaluateTwoFactor()\'s own trusted-device lookup.',
    ],
    [
      'apps/nextblock/app/api/setup/bootstrap/route.ts#POST',
      'Reviewed 2026-11-14: not a session route. It answers 404 without MCP_BEARER_TOKEN and 401 unless the bearer matches it, before the body is read, and the role it reads (provisionFirstAdmin, through the service role) is the account it has just created, to detect a concurrent setup, never the caller\'s.',
    ],
  ]);

  it('sees every route handler of the app, the staff routes included', () => {
    expect(handlers.length).toBeGreaterThan(50);
    expect(handlers).toEqual(
      expect.arrayContaining([
        ...STAFF_ROUTES.filter((route: string) => !route.endsWith('product-picker/route.ts')).map((route: string) => `${route}#POST`),
        'apps/nextblock/app/api/cms/ecommerce/product-picker/route.ts#GET',
        ...STAFF_UPLOAD_ROUTES.map((route: string) => `${route}#POST`),
        'apps/nextblock/app/ucp/v1/carts/[id]/route.ts#PATCH',
      ])
    );
    expect(handlers.filter((handler) => !ROUTE_HANDLER_SCOPES.some((scope: string) => handler.startsWith(scope)))).toEqual([]);
  });

  it('finds none outside the reviewed list', () => {
    const offenders = problems
      .filter((p) => !p.handler || !ROUTE_ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED.has(`${p.file}#${p.handler}`))
      .map((p) => p.problem);
    expect(offenders).toEqual([]);
  });

  it('lists only handlers the check still flags', () => {
    const flagged = new Set(problems.map((p) => `${p.file}#${p.handler}`));
    expect([...ROUTE_ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED.keys()].filter((key) => !flagged.has(key))).toEqual([]);
  });
});
