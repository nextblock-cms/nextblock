/**
 * Button looks for plain links (`<a href="#signup">`, `next/link`) on the public partner pages.
 * Server components cannot call `buttonVariants()` (it lives in a `'use client'` module, so the
 * server only sees a client reference), so the default and outline looks of
 * `libs/ui/src/lib/button.tsx` are spelled out here verbatim, hover/pressed colour mix included
 * (docs/05: the surface moves away from its own text colour, so contrast rises in every theme).
 */
export const PARTNERS_PRIMARY_LINK_CLASS =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none [--surface:var(--primary)] [--surface-foreground:var(--primary-foreground)] hover:[background-color:color-mix(in_oklab,hsl(var(--surface)),oklch(from_hsl(var(--surface-foreground))_calc(1_-_l)_0_0)_12%)] active:[background-color:color-mix(in_oklab,hsl(var(--surface)),oklch(from_hsl(var(--surface-foreground))_calc(1_-_l)_0_0)_20%)]';

export const PARTNERS_OUTLINE_LINK_CLASS =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-input bg-background px-6 py-2 text-sm font-semibold text-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none';

/** An inline text link on a neutral surface. */
export const PARTNERS_TEXT_LINK_CLASS =
  'font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm';
