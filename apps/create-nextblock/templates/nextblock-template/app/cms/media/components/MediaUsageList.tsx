// app/cms/media/components/MediaUsageList.tsx
import Link from "next/link";
import {
  countMediaHistoryUses,
  countMediaUses,
  describeMediaUsageSite,
  summarizeMediaUsage,
  type MediaUsage,
} from "../../../../lib/media/media-usage-format";

interface MediaUsageListProps {
  usage: MediaUsage;
  /** How many places to list before "and N more". */
  maxItems?: number;
}

/**
 * Where a media item is used, as public.media_usage (02045) found it: a summary line, then the
 * places (live uses first, then drafts, then revisions), each linked to the screen that edits it.
 * No hooks, so the media edit page (a server component) and the delete dialogs both render it.
 */
export default function MediaUsageList({ usage, maxItems = 8 }: MediaUsageListProps) {
  const shown = usage.sites.slice(0, maxItems);
  const more = usage.total - shown.length;
  const uses = countMediaUses(usage);
  const history = countMediaHistoryUses(usage);

  return (
    <div className="space-y-2 text-sm" data-media-usage>
      <p className={uses > 0 ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground"}>
        {summarizeMediaUsage(usage)}
      </p>
      {shown.length > 0 ? (
        <ul className="list-disc space-y-1 ps-5">
          {shown.map((site, index) => {
            const { text, href } = describeMediaUsageSite(site);
            // By position too: a place withheld from a WRITER has no record id (withoutAdminOnlyLabels),
            // so two partner storefronts would share a key.
            return (
              <li key={`${index}:${site.kind}:${site.recordId}`}>
                {href ? (
                  <Link href={href} className="underline underline-offset-2 hover:text-primary">
                    {text}
                  </Link>
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {more > 0 ? <p className="text-muted-foreground">and {more} more</p> : null}
      {uses === 0 && history > 0 ? (
        <p className="text-xs text-muted-foreground">
          Restoring one of those revisions would show a missing image.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Checked in this site&apos;s pages, posts, products, drafts, settings and partner storefronts. A link from
        another site, an email already sent or a cached social preview cannot be seen.
      </p>
    </div>
  );
}
