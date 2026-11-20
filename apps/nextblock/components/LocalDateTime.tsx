"use client";

import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => undefined;

/** The same text on every machine: `2026-11-18 14:05 UTC`. */
export function formatUtcDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The same text on every machine: `2026-11-18` (the UTC date). */
export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** True when `format` asks for any part of the time of day. */
function formatShowsTime(format: Intl.DateTimeFormatOptions): boolean {
  return (
    format.timeStyle !== undefined ||
    format.hour !== undefined ||
    format.minute !== undefined ||
    format.second !== undefined ||
    format.dayPeriod !== undefined ||
    format.fractionalSecondDigits !== undefined
  );
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
 * hydrating). `suppressHydrationWarning` is no substitute: React keeps the server's text under it,
 * so the page went on showing the server's time zone.
 *
 * `format` is handed to `toLocaleString` in the browser. Without a time of day in it (`{ year:
 * 'numeric', month: 'short', day: 'numeric' }`), the server and the hydrating render print the UTC
 * date (`2026-11-18`) instead of the UTC date and time.
 */
export function LocalDateTime({
  value,
  className,
  format,
}: {
  value: string | null | undefined;
  className?: string;
  format?: Intl.DateTimeFormatOptions;
}) {
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

  const serverText = format && !formatShowsTime(format) ? formatUtcDate(date) : formatUtcDateTime(date);

  return (
    <time dateTime={date.toISOString()} className={className}>
      {hydrated ? date.toLocaleString(undefined, format) : serverText}
    </time>
  );
}
