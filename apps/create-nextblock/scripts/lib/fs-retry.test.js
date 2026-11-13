import { describe, expect, it, vi } from 'vitest';
import { isTransientFsError, retryTransientFsErrors } from './fs-retry.js';

const fsError = (code, path = 'D:/repo/apps/create-nextblock/templates/nextblock-template/app/x.tsx') =>
  Object.assign(new Error(`${code}: unknown error, open '${path}'`), { code, path });

describe('retryTransientFsErrors', () => {
  it('runs a step again after a locked file (UNKNOWN is how Windows reports a mapped file) until it succeeds', async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(fsError('UNKNOWN'))
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockResolvedValue('done');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(retryTransientFsErrors('sanitizeUiImports', action, { sleep, log })).resolves.toBe('done');

    expect(action).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('sanitizeUiImports: UNKNOWN');
    expect(log.mock.calls[0][0]).toContain('nextblock-template/app/x.tsx');
  });

  it('rethrows any other error at once, without waiting', async () => {
    const action = vi.fn().mockRejectedValue(fsError('ENOENT'));
    const sleep = vi.fn();

    await expect(retryTransientFsErrors('copy', action, { sleep, log: vi.fn() })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the last attempt and rethrows that error', async () => {
    const action = vi.fn().mockRejectedValue(fsError('EPERM'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryTransientFsErrors('copy', action, { attempts: 3, sleep, log: vi.fn() }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(action).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
  });
});

describe('isTransientFsError', () => {
  it.each(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'UNKNOWN'])('treats %s as a lock', (code) => {
    expect(isTransientFsError(fsError(code))).toBe(true);
  });

  it.each(['ENOENT', 'EISDIR', 'EEXIST', undefined])('does not treat %s as a lock', (code) => {
    expect(isTransientFsError({ code })).toBe(false);
  });

  it('is false for a missing error', () => {
    expect(isTransientFsError(undefined)).toBe(false);
    expect(isTransientFsError(null)).toBe(false);
  });
});
