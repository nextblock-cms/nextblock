"use client";

import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => undefined;

/** The same text on every machine: `2026-11-18 14:05 UTC`. */
export function formatUtcDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * A timestamp in the viewer's locale and time zone, without a hydration mismatch.
 *
 * `new Date(value).toLocaleString()` in a client component that the server also renders prints the
 * server's time zone and locale in the HTML and the browser's while hydrating, and React throws
 * error #418 (hydration text mismatch) and re-renders the tree on the client: the media edit page
 * did (its AuthProvider is seeded with the server's user, so the form renders on the server). The
 * server and the hydrating render print the same UTC text; the browser prints the local text in
 * the render right after hydration (useSyncExternalStore reads the server snapshot while
 * hydrating).
 */
export function LocalDateTime({ value, className }: { value: string | null | undefined; className?: string }) {
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  );

  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return <span className={className}>{value}</span>;
  }

  return (
    <time dateTime={date.toISOString()} className={className}>
      {hydrated ? date.toLocaleString() : formatUtcDateTime(date)}
    </time>
  );
}
