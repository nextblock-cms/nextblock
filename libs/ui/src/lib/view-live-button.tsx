"use client";

import * as React from "react";
import { Eye, Loader2 } from "lucide-react";

import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

export interface ViewLiveButtonProps {
  /** Public URL of the content (e.g. "/about", "/article/x", "/product/y"). */
  href: string;
  /**
   * True when the content is actually visible on the live site (page/post
   * published, product active). When false the button opens a "still a draft"
   * dialog offering to publish instead of navigating to a URL that 404s.
   */
  isLive: boolean;
  /** Human label for the content type, e.g. "page", "post", "product". */
  label?: string;
  /**
   * Publishes the item (sets its status live). Resolves to `{ error }` on
   * failure. Should revalidate the relevant paths server-side.
   */
  publishAction: () => Promise<{ error?: string } | void | undefined>;
  className?: string;
}

/**
 * "View Live" button that is draft-aware. Published/active content links
 * straight to the public URL (opens a new tab, matching the previous behaviour).
 * Draft content instead opens a dialog explaining it isn't live yet, with a
 * one-click "Publish & view live" action.
 */
export function ViewLiveButton({
  href,
  isLive,
  label = "page",
  publishAction,
  className,
}: ViewLiveButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (isLive) {
    return (
      <Button variant="outline" asChild className={className}>
        <a href={href} target="_blank" rel="noopener noreferrer">
          <Eye className="mr-2 h-4 w-4" /> View Live
        </a>
      </Button>
    );
  }

  const handlePublish = async () => {
    setError(null);
    setIsPublishing(true);
    // Open the tab now, inside the click gesture, so a popup blocker doesn't stop
    // it once the async publish resolves. It's pointed at the live URL on success.
    const liveTab = typeof window !== "undefined" ? window.open("", "_blank") : null;

    try {
      const result = await publishAction();

      if (result && "error" in result && result.error) {
        setError(result.error);
        liveTab?.close();
        return;
      }

      if (liveTab) {
        liveTab.location.href = href;
      } else if (typeof window !== "undefined") {
        window.open(href, "_blank");
      }

      setOpen(false);
      // Reload the editor so it reflects the now-live status.
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (err) {
      liveTab?.close();
      setError(err instanceof Error ? err.message : "Failed to publish.");
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        className={className}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Eye className="mr-2 h-4 w-4" /> View Live
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby="view-live-draft-description">
          <DialogHeader>
            <DialogTitle>This {label} is still a draft</DialogTitle>
            <DialogDescription id="view-live-draft-description">
              It hasn&apos;t been published yet, so it isn&apos;t visible on your live
              site. Publish it to view it live — or use Preview to see the draft first.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">Couldn&apos;t publish: {error}</p>
          ) : null}
          <DialogFooter className="mt-4 gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPublishing}
            >
              Cancel
            </Button>
            <Button onClick={handlePublish} disabled={isPublishing}>
              {isPublishing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              Publish &amp; view live
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
