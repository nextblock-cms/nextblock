/**
 * The storefront studio's autosave engine, framework-free so it can be tested with fake timers.
 *
 * - `update(snapshot)` records the latest state and restarts the debounce (about 1.5 s);
 * - one save runs at a time; edits made while it runs are saved right after it;
 * - `flush()` saves now (the copilot flushes before inserting, the submit button before submitting);
 * - a failed save keeps the changes pending (status `error`) and is retried with the next edit or
 *   an explicit `flush()`; a refused one (`blocked`: a newer version elsewhere, the page went into
 *   review, the session ended) stops every save until `reset()`.
 */

export type DraftAutosaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'blocked';

/** What the save callback reports. */
export type DraftSaveOutcome = 'saved' | 'retry' | 'blocked';

export interface DraftAutosaver<T> {
  update(snapshot: T): void;
  flush(): Promise<void>;
  block(): void;
  reset(): void;
  dispose(): void;
  hasPendingChanges(): boolean;
  getStatus(): DraftAutosaveStatus;
}

export interface DraftAutosaverOptions<T> {
  delayMs: number;
  save: (snapshot: T) => Promise<DraftSaveOutcome>;
  onStatus?: (status: DraftAutosaveStatus) => void;
  /** Injectable timers (tests); default `setTimeout` / `clearTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export const STOREFRONT_AUTOSAVE_DELAY_MS = 1500;

export function createDraftAutosaver<T>(options: DraftAutosaverOptions<T>): DraftAutosaver<T> {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let latest: { value: T } | null = null;
  let dirty = false;
  let blocked = false;
  let disposed = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let status: DraftAutosaveStatus = 'saved';

  const setStatus = (next: DraftAutosaveStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const arm = () => {
    clearTimer();
    timer = schedule(() => {
      timer = null;
      void run();
    }, options.delayMs);
  };

  async function run(): Promise<void> {
    while (inFlight) {
      await inFlight;
    }
    if (disposed || blocked || !dirty || !latest) return;

    const snapshot = latest.value;
    dirty = false;
    setStatus('saving');

    const attempt = (async () => {
      let outcome: DraftSaveOutcome;
      try {
        outcome = await options.save(snapshot);
      } catch {
        outcome = 'retry';
      }
      if (disposed) return;
      if (outcome === 'blocked') {
        blocked = true;
        clearTimer();
        setStatus('blocked');
        return;
      }
      if (outcome === 'retry') {
        dirty = true;
        setStatus('error');
        return;
      }
      if (dirty) {
        setStatus('unsaved');
        arm();
      } else {
        setStatus('saved');
      }
    })();

    inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (inFlight === attempt) inFlight = null;
    }
  }

  return {
    update(snapshot: T) {
      if (disposed || blocked) return;
      latest = { value: snapshot };
      dirty = true;
      if (!inFlight) setStatus('unsaved');
      arm();
    },
    async flush() {
      if (disposed) return;
      clearTimer();
      await run();
    },
    block() {
      blocked = true;
      clearTimer();
      setStatus('blocked');
    },
    reset() {
      clearTimer();
      latest = null;
      dirty = false;
      blocked = false;
      setStatus('saved');
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
    hasPendingChanges() {
      return dirty || inFlight !== null;
    },
    getStatus() {
      return status;
    },
  };
}
