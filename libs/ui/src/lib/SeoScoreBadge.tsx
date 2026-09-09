import React from "react";
import { Badge } from "./badge";

export interface SeoScoreBadgeProps {
  score?: number | null;
  className?: string;
}

export function SeoScoreBadge({ score, className = "" }: SeoScoreBadgeProps) {
  if (score === undefined || score === null) {
    return (
      <Badge
        variant="outline"
        title="SEO Score: Not calculated"
        className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border text-muted-foreground border-border ${className}`}
      >
        <span className="w-1.5 h-1.5 rounded-full mr-1.5 shrink-0 bg-muted-foreground/50" />
        N/A
      </Badge>
    );
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));

  let colorClass = "";
  let dotClass = "";
  let title = "";

  if (normalizedScore >= 90) {
    colorClass = "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/60";
    dotClass = "bg-emerald-500";
    title = `SEO Score: ${normalizedScore}% — Optimal`;
  } else if (normalizedScore >= 70) {
    colorClass = "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800/60";
    dotClass = "bg-amber-500";
    title = `SEO Score: ${normalizedScore}% — Good (Minor warnings)`;
  } else {
    colorClass = "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800/60";
    dotClass = "bg-rose-500";
    title = `SEO Score: ${normalizedScore}% — Needs improvement`;
  }

  return (
    <Badge
      variant="outline"
      title={title}
      className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border transition-colors ${colorClass} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 shrink-0 ${dotClass}`} />
      {normalizedScore}%
    </Badge>
  );
}
export default SeoScoreBadge;
