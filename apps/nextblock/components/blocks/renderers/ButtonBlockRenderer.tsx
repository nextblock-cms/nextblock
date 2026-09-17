"use client";
import React from "react";
import Link from "next/link";
import { buttonVariants } from "@nextblock-cms/ui/button";
import { cn } from "@nextblock-cms/utils";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";

export type ButtonBlockContent = {
    text?: string;
    url?: string;
    variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link';
    size?: 'default' | 'sm' | 'lg' | 'full';
    position?: 'left' | 'center' | 'right';
};

interface ButtonBlockRendererProps {
  content: ButtonBlockContent;
  languageId: number; // This prop seems unused
  visualEditAttributes?: VisualEditAttributes;
}

const ButtonBlockRenderer: React.FC<ButtonBlockRendererProps> = ({
  content,
  visualEditAttributes,
}) => {
  const isExternal =
    content.url?.startsWith("http") ||
    content.url?.startsWith("mailto:") ||
    content.url?.startsWith("tel:");
  const isAnchor = content.url?.startsWith("#");
  // mailto: and tel: hand off to another app; `target="_blank"` only leaves an empty tab behind.
  const opensNewTab = Boolean(content.url?.startsWith("http"));

  const buttonText = content.text || "Button";
  // Map variant name if needed or pass directly if it matches
  // The migration might have uppercase 'DEFAULT' or 'OUTLINE', ensure lowercase
  const variantRaw = content.variant?.toLowerCase() || "default";
  // Cast to specific allowed variants for TS safety if strictly typed, else as any
  const variant = (variantRaw === 'default' || variantRaw === 'outline' || variantRaw === 'secondary' || variantRaw === 'ghost' || variantRaw === 'link' || variantRaw === 'destructive') 
    ? variantRaw 
    : 'default';

  const sizeRaw = content.size?.toLowerCase() || "default";
  const size = (sizeRaw === 'default' || sizeRaw === 'sm' || sizeRaw === 'lg' || sizeRaw === 'icon') 
    ? sizeRaw 
    : 'default';
    
  const buttonPosition = content.position || "left";

  const alignmentClasses = {
      left: "justify-start text-left",
      center: "justify-center text-center",
      right: "justify-end text-right",
  };
  
  // We use buttonVariants directly to avoid 'asChild' composition issues with Radix Slot
  // This ensures we just render a clean Link or Anchor with the correct classes.
  const classes = cn(
    buttonVariants({ variant, size }),
    variant === 'outline' && "text-foreground", // Ensure outline text is visible
    "no-underline" // Force no-underline for links
  );

  return (
    <div
      className={cn("my-6 flex w-full", alignmentClasses[buttonPosition])}
      {...visualEditAttributes}
    >
      {/* Case 1: Internal link */}
      {!isExternal && !isAnchor && !!content.url ? (
        <Link href={content.url} className={classes}>
            {buttonText}
        </Link>
      ) : /* Case 2: External or Anchor link */
      (isExternal || isAnchor) && !!content.url ? (
        <a
          href={content.url}
          target={opensNewTab ? "_blank" : undefined}
          rel={opensNewTab ? "noopener noreferrer" : undefined}
          className={classes}
        >
          {buttonText}
        </a>
      ) : (
        /* Case 3: No URL - render a disabled fake button */
        <button disabled className={cn(classes, "opacity-50 cursor-not-allowed")}>
          {buttonText}
        </button>
      )}
    </div>
  );
};

export default ButtonBlockRenderer;
