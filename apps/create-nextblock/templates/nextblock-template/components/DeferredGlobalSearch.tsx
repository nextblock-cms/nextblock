"use client";

import { Search } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "@nextblock-cms/ui";
import { cn } from "@nextblock-cms/utils";
import { useLabel } from "../lib/i18n/use-label";

type TriggerVariant = "desktop" | "mobile";

interface DeferredGlobalSearchProps {
  isEcommerceActive: boolean;
  variant: TriggerVariant;
}

// Always rendered client-side: ResponsiveNav mounts this inside <ClientOnly>, so React.lazy
// is enough and lets the placeholder below double as the Suspense fallback.
const GlobalSearch = lazy(() => import("./GlobalSearch"));

function SearchTriggerPlaceholder({
  variant,
  busy = false,
  onClick,
}: {
  variant: TriggerVariant;
  busy?: boolean;
  onClick?: () => void;
}) {
  const label = useLabel();
  const text = label("global_search.trigger", "Search", "Rechercher");

  return (
    <Button
      type="button"
      variant="outline"
      size={variant === "mobile" ? "icon" : "default"}
      className={cn(
        "shrink-0 border-foreground/15 bg-background/70",
        variant === "desktop" && "h-9 gap-2 px-3 text-sm",
        variant === "mobile" && "h-10 w-10"
      )}
      aria-label={text}
      aria-busy={busy || undefined}
      aria-keyshortcuts="Control+K Meta+K"
      onClick={onClick}
    >
      <Search className="h-4 w-4" />
      {variant === "desktop" ? <span>{text}</span> : null}
    </Button>
  );
}

export function DeferredGlobalSearch(props: DeferredGlobalSearchProps) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const [openOnMount, setOpenOnMount] = useState(false);

  const openSearch = () => {
    setOpenOnMount(true);
    setShouldLoad(true);
  };

  useEffect(() => {
    if (props.variant !== "desktop") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.variant]);

  if (shouldLoad) {
    // While the chunk downloads the trigger used to vanish (`loading: () => null`), which
    // shifted the header and left nothing on screen to explain the wait. GlobalSearch takes
    // focus into the dialog once it mounts and hands it back to its own trigger on close.
    return (
      <Suspense fallback={<SearchTriggerPlaceholder variant={props.variant} busy />}>
        <GlobalSearch {...props} openOnMount={openOnMount} />
      </Suspense>
    );
  }

  return <SearchTriggerPlaceholder variant={props.variant} onClick={openSearch} />;
}
