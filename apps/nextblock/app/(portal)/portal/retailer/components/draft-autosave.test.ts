import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDraftAutosaver, STOREFRONT_AUTOSAVE_DELAY_MS, type DraftAutosaveStatus, type DraftSaveOutcome } from './draft-autosave';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(save: (snapshot: number) => Promise<DraftSaveOutcome>) {
  const statuses: DraftAutosaveStatus[] = [];
  const saver = createDraftAutosaver<number>({ delayMs: STOREFRONT_AUTOSAVE_DELAY_MS, save, onStatus: (status) => statuses.push(status) });
  return { saver, statuses };
}

describe('createDraftAutosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a burst of edits into one save of the latest snapshot (about 1.5 s)', async () => {
    const save = vi.fn(async () => 'saved' as DraftSaveOutcome);
    const { saver, statuses } = setup(save);

    saver.update(1);
    saver.update(2);
    await vi.advanceTimersByTimeAsync(1000);
    saver.update(3);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(3);
    expect(saver.getStatus()).toBe('saved');
    expect(saver.hasPendingChanges()).toBe(false);
    expect(statuses).toEqual(['unsaved', 'saving', 'saved']);
  });

  it('runs one save at a time and saves edits made during it right after', async () => {
    const first = deferred<DraftSaveOutcome>();
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async () => 'saved');
    const { saver } = setup(save);

    saver.update(1);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    saver.update(2);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    // The second save waits for the first one.
    expect(save).toHaveBeenCalledTimes(1);
    expect(saver.getStatus()).toBe('saving');

    first.resolve('saved');
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2);
    expect(saver.getStatus()).toBe('saved');
  });

  it('flush() saves at once and resolves when the save settled', async () => {
    const save = vi.fn(async () => 'saved' as DraftSaveOutcome);
    const { saver } = setup(save);

    saver.update(7);
    await saver.flush();
    expect(save).toHaveBeenCalledWith(7);
    expect(saver.getStatus()).toBe('saved');

    // Nothing pending: flushing again does not save again, and the cancelled timer never fires.
    await saver.flush();
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps changes pending after a failure and retries them with the next edit or flush', async () => {
    const save = vi
      .fn<(snapshot: number) => Promise<DraftSaveOutcome>>()
      .mockResolvedValueOnce('retry')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue('saved');
    const { saver } = setup(save);

    saver.update(1);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(saver.getStatus()).toBe('error');
    expect(saver.hasPendingChanges()).toBe(true);

    // A thrown save counts as a retryable failure too.
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.getStatus()).toBe('error');

    saver.update(2);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith(2);
    expect(saver.getStatus()).toBe('saved');
    expect(saver.hasPendingChanges()).toBe(false);
  });

  it('stops every save once blocked (conflict, review, lost session) until reset', async () => {
    const save = vi.fn(async () => 'blocked' as DraftSaveOutcome);
    const { saver } = setup(save);

    saver.update(1);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(saver.getStatus()).toBe('blocked');

    saver.update(2);
    await saver.flush();
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);

    saver.reset();
    expect(saver.getStatus()).toBe('saved');
    save.mockResolvedValue('saved');
    saver.update(3);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(3);
  });

  it('block() from outside cancels a scheduled save', async () => {
    const save = vi.fn(async () => 'saved' as DraftSaveOutcome);
    const { saver } = setup(save);
    saver.update(1);
    saver.block();
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS * 2);
    expect(save).not.toHaveBeenCalled();
    expect(saver.getStatus()).toBe('blocked');
  });

  it('dispose() cancels the timer and ignores late results', async () => {
    const pending = deferred<DraftSaveOutcome>();
    const save = vi.fn(() => pending.promise);
    const { saver, statuses } = setup(save);
    saver.update(1);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    saver.dispose();
    pending.resolve('saved');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['unsaved', 'saving']);
    saver.update(2);
    await vi.advanceTimersByTimeAsync(STOREFRONT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
