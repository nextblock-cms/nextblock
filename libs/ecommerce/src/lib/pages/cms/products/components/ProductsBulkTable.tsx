'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Archive, ChevronLeft, ChevronRight, Search, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SeoScoreBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nextblock-cms/ui';
import { formatPrice } from '@nextblock-cms/utils';

import { DeleteProductButton } from './DeleteProductButton';

type ProductRow = {
  id: string;
  title: string;
  sku: string;
  slug?: string | null;
  price?: number | null;
  sale_price?: number | null;
  stock?: number | null;
  status?: string | null;
  language_id: number;
  seo_score?: number | null;
  product_media?: Array<{
    media?: {
      file_path?: string | null;
      object_key?: string | null;
    } | null;
  }> | null;
};

type BulkActionResult = Promise<{
  success: boolean;
  error?: string;
  count?: number;
}>;

interface ProductsBulkTableProps {
  products: ProductRow[];
  languageLabels: Record<string, string>;
  defaultCurrencyCode: string;
  deleteProductAction: (id: string) => Promise<void>;
  bulkDeleteProductsAction: (productIds: string[]) => BulkActionResult;
  bulkDraftProductsAction: (productIds: string[]) => BulkActionResult;
}

const R2_BASE_URL = process.env.NEXT_PUBLIC_R2_BASE_URL || '';

function resolveMediaUrl(path?: string | null) {
  if (!path) {
    return null;
  }

  if (path.startsWith('http')) {
    return path;
  }

  if (!R2_BASE_URL) {
    return path;
  }

  return `${R2_BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function ProductsBulkTable({
  products,
  languageLabels,
  defaultCurrencyCode,
  deleteProductAction,
  bulkDeleteProductsAction,
  bulkDraftProductsAction,
}: ProductsBulkTableProps) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkActionLabel, setBulkActionLabel] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filteredProducts = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return products;
    }

    return products.filter((product) => {
      const languageLabel = languageLabels[String(product.language_id)] || '';
      const searchableValue = [
        product.title,
        product.sku,
        product.slug,
        product.status,
        languageLabel,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchableValue.includes(normalizedQuery);
    });
  }, [languageLabels, products, searchQuery]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  const totalFiltered = filteredProducts.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedProducts = useMemo(() => {
    const from = (safePage - 1) * pageSize;
    return filteredProducts.slice(from, from + pageSize);
  }, [filteredProducts, safePage, pageSize]);

  const productIds = useMemo(() => products.map((product) => product.id), [products]);
  const visibleProductIds = useMemo(
    () => paginatedProducts.map((product) => product.id),
    [paginatedProducts]
  );
  const selectedProducts = useMemo(
    () => products.filter((product) => selectedIds.has(product.id)),
    [products, selectedIds]
  );
  const selectedCount = selectedProducts.length;
  const showBulkActions = selectedCount > 1;
  const selectedVisibleCount = visibleProductIds.filter((productId) =>
    selectedIds.has(productId)
  ).length;
  const allVisibleSelected =
    visibleProductIds.length > 0 &&
    visibleProductIds.every((productId) => selectedIds.has(productId));
  const hasPartialSelection = selectedVisibleCount > 0 && !allVisibleSelected;

  useEffect(() => {
    const currentProductIds = new Set(productIds);
    setSelectedIds((current) => {
      const next = new Set(
        Array.from(current).filter((productId) => currentProductIds.has(productId))
      );

      return next.size === current.size ? current : next;
    });
  }, [productIds]);

  const setAllVisibleSelected = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (checked) {
        visibleProductIds.forEach((productId) => next.add(productId));
      } else {
        visibleProductIds.forEach((productId) => next.delete(productId));
      }

      return next;
    });
  };

  const setProductSelected = (productId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(productId);
      } else {
        next.delete(productId);
      }

      return next;
    });
  };

  const runBulkAction = (
    label: string,
    confirmMessage: string,
    action: (ids: string[]) => BulkActionResult
  ) => {
    if (selectedCount === 0) {
      setBulkError('Select at least one product first.');
      return;
    }

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setBulkError(null);
    setBulkActionLabel(label);

    startTransition(async () => {
      try {
        const result = await action(Array.from(selectedIds));

        if (!result.success) {
          setBulkError(result.error || 'Bulk action failed. Please try again.');
          setBulkActionLabel(null);
          return;
        }

        setSelectedIds(new Set());
        router.refresh();
      } catch (error) {
        console.error('Bulk product action failed:', error);
        setBulkError('Bulk action failed. Please try again.');
      } finally {
        setBulkActionLabel(null);
      }
    });
  };

  return (
    <div className="rounded-lg border overflow-hidden dark:border-slate-700">
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
        <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search products..."
              className="h-9 pl-9"
              aria-label="Search products"
            />
          </div>
          {selectedCount > 0 ? (
            <span className="text-sm font-medium text-foreground">
              {selectedCount} selected
            </span>
          ) : null}
          {bulkError ? (
            <span className="text-sm text-destructive">{bulkError}</span>
          ) : null}
        </div>
        {showBulkActions ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() =>
                runBulkAction(
                  'Moving to draft...',
                  `Move ${selectedCount} selected products to draft?`,
                  bulkDraftProductsAction
                )
              }
            >
              <Archive className="mr-2 h-4 w-4" />
              {bulkActionLabel === 'Moving to draft...' ? bulkActionLabel : 'Set Draft'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() =>
                runBulkAction(
                  'Deleting...',
                  `Delete ${selectedCount} selected products? This action cannot be undone.`,
                  bulkDeleteProductsAction
                )
              }
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {bulkActionLabel === 'Deleting...' ? bulkActionLabel : 'Delete'}
            </Button>
          </div>
        ) : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox
                checked={
                  allVisibleSelected
                    ? true
                    : hasPartialSelection
                      ? 'indeterminate'
                      : false
                }
                onCheckedChange={(checked) => setAllVisibleSelected(checked === true)}
                aria-label="Select all products on this page"
              />
            </TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Language</TableHead>
            <TableHead>SEO</TableHead>
            <TableHead>Stock</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginatedProducts.length > 0 ? (
            paginatedProducts.map((product) => {
              const mediaUrl = resolveMediaUrl(
                product.product_media?.[0]?.media?.file_path ||
                  product.product_media?.[0]?.media?.object_key
              );

              return (
                <TableRow
                  key={product.id}
                  data-state={selectedIds.has(product.id) ? 'selected' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(product.id)}
                      onCheckedChange={(checked) =>
                        setProductSelected(product.id, checked === true)
                      }
                      aria-label={`Select ${product.title}`}
                    />
                  </TableCell>
                  <TableCell>
                    {mediaUrl ? (
                      <Image
                        src={mediaUrl}
                        alt={product.title}
                        width={40}
                        height={40}
                        className="w-10 h-10 object-cover rounded"
                      />
                    ) : (
                      <div className="w-10 h-10 bg-gray-200 rounded flex items-center justify-center text-xs text-gray-500">
                        No Img
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/cms/products/${product.id}/edit`} className="hover:underline">
                      {product.title}
                    </Link>
                  </TableCell>
                  <TableCell>{product.sku}</TableCell>
                  <TableCell>
                    <div className="flex items-baseline gap-2">
                      <span className={product.sale_price ? 'font-semibold text-primary' : ''}>
                        {typeof (product.sale_price ?? product.price) === 'number'
                          ? formatPrice(
                              product.sale_price ?? product.price ?? 0,
                              defaultCurrencyCode
                            )
                          : 'N/A'}
                      </span>
                      {product.sale_price ? (
                        <span className="text-sm text-muted-foreground line-through">
                          {formatPrice(product.price ?? 0, defaultCurrencyCode)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {languageLabels[String(product.language_id)] || 'N/A'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <SeoScoreBadge score={product.seo_score} />
                  </TableCell>
                  <TableCell>{product.stock}</TableCell>
                  <TableCell>
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        product.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : product.status === 'archived'
                            ? 'bg-gray-100 text-gray-800'
                            : 'bg-yellow-100 text-yellow-800'
                      }`}
                    >
                      {product.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right flex justify-end gap-2 items-center">
                    {product.slug ? (
                      <Link href={`/product/${product.slug}`} target="_blank" rel="noopener noreferrer">
                        <Button variant="outline" size="sm">
                          View Product
                        </Button>
                      </Link>
                    ) : null}
                    <Link href={`/cms/products/${product.id}/edit`}>
                      <Button variant="ghost" size="sm">
                        Edit
                      </Button>
                    </Link>
                    <DeleteProductButton
                      productName={product.title}
                      isIcon
                      deleteAction={() => deleteProductAction(product.id)}
                    />
                  </TableCell>
                </TableRow>
              );
            })
          ) : (
            <TableRow>
              <TableCell colSpan={10} className="text-center py-10">
                {products.length === 0 ? 'No products found.' : 'No products match your search.'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {totalFiltered > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-2 py-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Rows per page:</span>
            <Select
              value={String(pageSize)}
              onValueChange={(val) => {
                setPageSize(Number(val));
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue placeholder={String(pageSize)} />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 25, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-2">
              Showing {(safePage - 1) * pageSize + 1} to {Math.min(safePage * pageSize, totalFiltered)} of {totalFiltered} products
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span>
              Page {safePage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
