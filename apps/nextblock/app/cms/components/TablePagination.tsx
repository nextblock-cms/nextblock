"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nextblock-cms/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface TablePaginationProps {
  currentPage: number;
  pageSize: number;
  totalCount: number;
  basePath: string;
  itemLabel?: string;
  pageSizeOptions?: number[];
}

export default function TablePagination({
  currentPage,
  pageSize,
  totalCount,
  basePath,
  itemLabel = "items",
  pageSizeOptions = [10, 25, 50, 100],
}: TablePaginationProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const from = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const to = Math.min(totalCount, currentPage * pageSize);

  const navigateTo = (newPage: number, newPageSize?: number) => {
    const current = new URLSearchParams(Array.from(searchParams.entries()));

    if (newPage > 1) {
      current.set("page", newPage.toString());
    } else {
      current.delete("page");
    }

    const effectivePageSize = newPageSize ?? pageSize;
    if (effectivePageSize !== 25) {
      current.set("pageSize", effectivePageSize.toString());
    } else {
      current.delete("pageSize");
    }

    const query = current.toString();
    router.push(`${basePath}${query ? `?${query}` : ""}`);
  };

  const handlePageSizeChange = (val: string) => {
    const nextSize = parseInt(val, 10);
    if (!Number.isNaN(nextSize) && nextSize > 0) {
      // Reset to page 1 when changing page size
      navigateTo(1, nextSize);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 bg-muted/20 border-t border-slate-200 dark:border-slate-700 text-xs sm:text-sm text-muted-foreground">
      {/* Item summary */}
      <div className="flex items-center gap-1">
        <span>Showing</span>
        <span className="font-medium text-foreground">{from}</span>
        <span>to</span>
        <span className="font-medium text-foreground">{to}</span>
        <span>of</span>
        <span className="font-medium text-foreground">{totalCount}</span>
        <span>{itemLabel}</span>
      </div>

      {/* Controls: Page size + Pagination buttons */}
      <div className="flex items-center gap-4 sm:gap-6 flex-wrap">
        {/* Rows per page selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs">Rows per page:</span>
          <Select
            value={pageSize.toString()}
            onValueChange={handlePageSizeChange}
          >
            <SelectTrigger className="h-8 w-[72px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((opt) => (
                <SelectItem key={opt} value={opt.toString()} className="text-xs">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Page counter */}
        <div className="flex items-center gap-1 text-xs">
          <span>Page</span>
          <span className="font-medium text-foreground">{currentPage}</span>
          <span>of</span>
          <span className="font-medium text-foreground">{totalPages}</span>
        </div>

        {/* Prev / Next buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={currentPage <= 1}
            onClick={() => navigateTo(currentPage - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={currentPage >= totalPages}
            onClick={() => navigateTo(currentPage + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
