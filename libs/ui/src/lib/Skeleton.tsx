"use client";
import { cn } from "@nextblock-cms/utils/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-md bg-muted shimmer", className)}
      {...props}
    />
  );
}

export { Skeleton };