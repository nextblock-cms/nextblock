import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  classifyName,
  findCallerSuppliedActors,
  findCallerSuppliedActorsInSource,
  listServerActions,
} = require('./lib/server-action-actors.js');
const { scanRepository } = require('./lib/service-role-boundary.js');

type Problem = { action: string; file: string; line: number; param: string; problem: string };

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
  const modules = scanRepository();

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

describe('CMS server actions take the service-role client only from a verified helper', () => {
  // 2026-10-27: app/cms/orders/actions.ts#markOrderAsPaid read the role with the cookie client,
  // then built a service-role client from the env keys itself, so a first factor alone could
  // mark an order paid (and, since 02030, record a partner's commission). The ecommerce lib's
  // order status actions had the same shape. A CMS action takes the service client from
  // requireCmsAdmin / requireCmsStaff (app) or requireEcomAdmin / requireEcomStaff (libs), which
  // refuse a session that has not passed its enrolled second factor; this check fails on any
  // module under the CMS trees that has a 'use server' directive and mints the client itself.
  const CMS_ACTION_PATH = /^(?:apps\/nextblock\/app\/cms\/|libs\/[^/]+\/src\/lib\/pages\/cms\/)/;
  const USE_SERVER_ANYWHERE = /['"]use server['"]/;
  const RAW_SERVICE_ROLE: ReadonlyArray<readonly [RegExp, string]> = [
    [/^\s*import\s+(?!type\b)[^;]*\bcreateClient\b[^;]*\bfrom\s+['"]@supabase\/supabase-js['"]/m, 'builds its own supabase-js client'],
    [/process\.env(?:\.|\[\s*['"])(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\b/, 'reads the secret key from process.env'],
    [/\bresolveSupabaseServiceKey\b/, 'resolves the secret key itself'],
  ];

  function rawServiceRoleUses(source: string): string[] {
    return RAW_SERVICE_ROLE.filter(([re]) => re.test(source)).map(([, what]) => what);
  }

  // Scanned once at collection time, like the repository-wide check above: under a full parallel
  // run the scan alone outlasts a test's default timeout.
  const cmsActionModules = [...scanRepository().values()]
    .filter((mod: { repoPath: string }) => CMS_ACTION_PATH.test(mod.repoPath))
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

  it('finds none in the app CMS or the libraries\' CMS pages', () => {
    // Coverage: the scan must actually see the CMS action modules, the two order modules included.
    const paths = cmsActionModules.map(([repoPath]) => repoPath);
    expect(paths.length).toBeGreaterThan(40);
    expect(paths).toContain('apps/nextblock/app/cms/orders/actions.ts');
    expect(paths).toContain('libs/ecommerce/src/lib/pages/cms/orders/server-actions.ts');
    expect(paths).toContain('apps/nextblock/app/cms/affiliates/actions.ts');

    const offenders = cmsActionModules.flatMap(([repoPath, source]) =>
      rawServiceRoleUses(source).map((what) => repoPath + ': ' + what)
    );
    expect(offenders).toEqual([]);
  });
});
