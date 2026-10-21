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
