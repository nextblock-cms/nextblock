import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';

/**
 * Full-site backup and restore (lib/full-backup/server.ts and the /api/cms/full-backup routes).
 * The public sandbox publishes its admin login and always satisfies its second factor
 * (2026-11-03). An export hands out the whole database and every account's password hash, and a
 * restore creates, updates and deletes accounts through GoTrue; on the sandbox only pg_dump/psql
 * missing from the host stopped either. There every entry point now refuses after the admin check
 * and before it parses an archive, reaches R2, spawns a process or calls GoTrue, and the routes
 * answer 403. Off the sandbox ('', 'false', 'TRUE', '1') nothing changes: here the run stops at
 * the faked missing pg_dump/psql, past every point the sandbox refusal guards.
 */

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string | null,
  getUser: vi.fn(),
  evaluateTwoFactor: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  gotrue: {
    listUsers: vi.fn(),
    createUser: vi.fn(),
    updateUserById: vi.fn(),
    deleteUser: vi.fn(),
  },
  getS3Client: vi.fn(),
  s3Send: vi.fn(),
  spawn: vi.fn(),
  postgres: vi.fn(),
  exportBackupBundle: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: table === 'profiles' && mocks.role ? { role: mocks.role } : null, error: null }),
        }),
      }),
    }),
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('@nextblock-cms/utils/server', () => ({ getS3Client: mocks.getS3Client }));
vi.mock('../auth/twoFactor', () => ({ evaluateTwoFactor: mocks.evaluateTwoFactor }));
vi.mock('../cms-transfer/server', () => ({ exportBackupBundle: mocks.exportBackupBundle }));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdtemp: mocks.mkdtemp,
  readFile: mocks.readFile,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));
vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    DeleteObjectsCommand: class extends Command {},
    GetObjectCommand: class extends Command {},
    ListObjectsV2Command: class extends Command {},
    PutObjectCommand: class extends Command {},
  };
});
// The real unzip, behind a spy: parsing the archive is the first thing a review or restore does.
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) };
});

import { POST as exportRoute } from '../../app/api/cms/full-backup/export/route';
import { POST as restoreRoute } from '../../app/api/cms/full-backup/restore/route';
import {
  FULL_BACKUP_ARCHIVE_TYPE,
  FULL_BACKUP_CONFIRMATION,
  FULL_BACKUP_CONTENT_PATH,
  FULL_BACKUP_DATABASE_PATH,
  FULL_BACKUP_MANIFEST_PATH,
} from './manifest';
import {
  FULL_BACKUP_SANDBOX_MESSAGE,
  exportFullBackupArchive,
  requireFullBackupAdmin,
  restoreFullBackupArchive,
  reviewFullBackupArchiveForAdmin,
} from './server';

const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;
const unzip = vi.mocked(unzipSync);

/** A valid archive with no accounts and no stored objects: a review passes and a restore runs. */
function buildArchive() {
  const manifest = {
    type: FULL_BACKUP_ARCHIVE_TYPE,
    version: 1,
    exported_at: '2026-11-01T00:00:00.000Z',
    app: { name: 'nextblock', version: '1.0.0' },
    database: { path: FULL_BACKUP_DATABASE_PATH, created_with: 'pg_dump' },
    content: { path: FULL_BACKUP_CONTENT_PATH, type: 'nextblock-content-backup-v1' },
    storage: { bucket: 'source-bucket', source_base_url: null, public_url: null, objects: [] },
    users: null,
  };
  return zipSync({
    [FULL_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
    [FULL_BACKUP_DATABASE_PATH]: strToU8('CREATE TABLE public.example (id integer);\n'),
    [FULL_BACKUP_CONTENT_PATH]: strToU8('{}'),
  });
}

/** A child process for a command the host lacks: it fails to start, as on Vercel. */
function missingCommand(command: string) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  setTimeout(() => child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })), 0);
  return child;
}

function restoreRequest(action: 'review' | 'restore') {
  const formData = new FormData();
  formData.set('file', new File([buildArchive()], 'backup.zip', { type: 'application/zip' }));
  formData.set('action', action);
  formData.set('confirmation', FULL_BACKUP_CONFIRMATION);
  formData.set('mediaUrlMode', 'keep_exact_urls');
  return new Request('http://localhost/api/cms/full-backup/restore', { method: 'POST', body: formData });
}

function resetCalls() {
  for (const mock of [
    mocks.getUser,
    mocks.evaluateTwoFactor,
    mocks.getServiceRoleSupabaseClient,
    mocks.getS3Client,
    mocks.s3Send,
    mocks.spawn,
    mocks.postgres,
    mocks.exportBackupBundle,
    mocks.mkdtemp,
    mocks.rm,
    mocks.readFile,
    mocks.writeFile,
    ...Object.values(mocks.gotrue),
  ]) {
    mock.mockClear();
  }
  unzip.mockClear();
}

/** Nothing past the refusal ran: no archive parse, R2, temp dir, process, database or GoTrue call. */
function expectNoBackupSideEffects() {
  expect(unzip).not.toHaveBeenCalled();
  expect(mocks.getS3Client).not.toHaveBeenCalled();
  expect(mocks.s3Send).not.toHaveBeenCalled();
  expect(mocks.mkdtemp).not.toHaveBeenCalled();
  expect(mocks.writeFile).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.postgres).not.toHaveBeenCalled();
  expect(mocks.exportBackupBundle).not.toHaveBeenCalled();
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  for (const method of Object.values(mocks.gotrue)) expect(method).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('R2_BUCKET_NAME', 'site-bucket');
  mocks.role = 'ADMIN';
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'admin-1', email: 'admin@site.example' } } });
  mocks.evaluateTwoFactor.mockReset().mockResolvedValue({ status: 'satisfied' });
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => ({ auth: { admin: mocks.gotrue } }));
  mocks.gotrue.listUsers.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
  mocks.getS3Client.mockReset().mockResolvedValue({ send: mocks.s3Send });
  mocks.s3Send.mockReset().mockResolvedValue({ Contents: [], IsTruncated: false });
  mocks.spawn.mockReset().mockImplementation((command: string) => missingCommand(command));
  mocks.mkdtemp.mockReset().mockImplementation(async (prefix: string) => `${prefix}test`);
  mocks.rm.mockReset().mockResolvedValue(undefined);
  mocks.readFile.mockReset().mockResolvedValue(Buffer.from(''));
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
  resetCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('full-site backup on the sandbox', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  it('refuses every entry point after the admin check, before any archive, R2, process or GoTrue call', async () => {
    await expect(requireFullBackupAdmin()).rejects.toThrow(FULL_BACKUP_SANDBOX_MESSAGE);
    await expect(exportFullBackupArchive()).rejects.toThrow(FULL_BACKUP_SANDBOX_MESSAGE);
    await expect(reviewFullBackupArchiveForAdmin(buildArchive())).rejects.toThrow(FULL_BACKUP_SANDBOX_MESSAGE);
    await expect(
      restoreFullBackupArchive({
        archive: buildArchive(),
        confirmation: FULL_BACKUP_CONFIRMATION,
        mediaUrlMode: 'keep_exact_urls',
        deleteExtraneousR2Objects: true,
      })
    ).rejects.toThrow(FULL_BACKUP_SANDBOX_MESSAGE);

    // The session, role and second factor were checked for each of the four, then the refusal.
    expect(mocks.getUser).toHaveBeenCalledTimes(4);
    expect(mocks.evaluateTwoFactor).toHaveBeenCalledTimes(4);
    expect(FULL_BACKUP_SANDBOX_MESSAGE).toBe('Full-site backup and restore are disabled in the sandbox.');
    expectNoBackupSideEffects();
  });

  it('still answers a non-admin with the role error first', async () => {
    mocks.role = 'WRITER';

    await expect(exportFullBackupArchive()).rejects.toThrow('Admin role required.');
    expect(mocks.evaluateTwoFactor).not.toHaveBeenCalled();
    expectNoBackupSideEffects();
  });

  it('answers the export route with 403', async () => {
    const response = await exportRoute();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: FULL_BACKUP_SANDBOX_MESSAGE });
    expectNoBackupSideEffects();
  });

  it.each(['review', 'restore'] as const)('answers a %s through the restore route with 403', async (action) => {
    const response = await restoreRoute(restoreRequest(action));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: FULL_BACKUP_SANDBOX_MESSAGE, warnings: [] });
    expectNoBackupSideEffects();
  });
});

describe('full-site backup anywhere else (only the exact value "true" is the sandbox)', () => {
  it.each(OFF_SANDBOX)('NEXT_PUBLIC_IS_SANDBOX=%j: the admin check passes and each entry point runs', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    await expect(requireFullBackupAdmin()).resolves.toBeUndefined();

    // Export: the R2 client and a temp dir, then pg_dump, which this host lacks.
    resetCalls();
    await expect(exportFullBackupArchive()).rejects.toThrow('pg_dump is required for full ZIP backup/restore');
    expect(mocks.getS3Client).toHaveBeenCalledTimes(1);
    expect(mocks.mkdtemp).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith('pg_dump', ['--version'], expect.anything());
    expect(mocks.rm).toHaveBeenCalledTimes(1);

    // Review: the archive is parsed and summarised.
    resetCalls();
    await expect(reviewFullBackupArchiveForAdmin(buildArchive())).resolves.toMatchObject({
      success: true,
      sourceBucket: 'source-bucket',
      storageObjects: 0,
      usersInArchive: null,
    });
    expect(unzip).toHaveBeenCalledTimes(1);

    // Restore: the archive is parsed, the R2 client resolved, then psql, which this host lacks,
    // stops it before any account or object is touched.
    resetCalls();
    await expect(
      restoreFullBackupArchive({
        archive: buildArchive(),
        confirmation: FULL_BACKUP_CONFIRMATION,
        mediaUrlMode: 'keep_exact_urls',
      })
    ).rejects.toThrow('psql is required for full ZIP backup/restore');
    expect(unzip).toHaveBeenCalledTimes(1);
    expect(mocks.getS3Client).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith('psql', ['--version'], expect.anything());
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it.each(OFF_SANDBOX)('NEXT_PUBLIC_IS_SANDBOX=%j: the routes answer as before', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    const exported = await exportRoute();
    expect(exported.status).toBe(500);
    expect(await exported.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('pg_dump is required for full ZIP backup/restore'),
    });

    const reviewed = await restoreRoute(restoreRequest('review'));
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({ success: true, storageObjects: 0 });

    const restored = await restoreRoute(restoreRequest('restore'));
    expect(restored.status).toBe(500);
    expect(await restored.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('psql is required for full ZIP backup/restore'),
      warnings: [],
    });
  });
});
