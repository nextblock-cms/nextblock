// app/cms/pages/page.tsx
import React from "react";
import { createClient } from "@nextblock-cms/db/server";
import Link from "next/link";
import { Button } from "@nextblock-cms/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@nextblock-cms/ui";
import { Badge } from "@nextblock-cms/ui";
import { Alert, AlertDescription } from "@nextblock-cms/ui";
import {
  MoreHorizontal,
  PlusCircle,
  Edit3,
  FileText,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuButtonTrigger,
  DropdownMenuSeparator,
} from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";
import { getActiveLanguagesServerSide } from "@nextblock-cms/db/server";
import { auditSeo } from "@nextblock-cms/utils/seo";
import { buildPageSeoDocument } from "../../../lib/seo/page-document";

type Page = Database["public"]["Tables"]["pages"]["Row"];
import LanguageFilterSelect from "../components/LanguageFilterSelect";
import DeletePageButtonClient from "./components/DeletePageButtonClient";
import { ContentTransferControls } from "../import-export/ContentTransferControls";
import VisibilityBadge from "../components/VisibilityBadge";
import SeoScoreBadge from "../components/SeoScoreBadge";
import TablePagination from "../components/TablePagination";

async function getPagesWithDetails(
  filterLanguageId?: number,
  pageNumber: number = 1,
  pageSize: number = 25
): Promise<{
  items: { page: Page; languageCode: string; seoScore: number }[];
  totalCount: number;
}> {
  const supabase = createClient();
  const languages = await getActiveLanguagesServerSide();
  const langMap = new Map(languages.map((l) => [l.id, l.code]));

  let query = supabase
    .from("pages")
    .select("*, languages!inner(code), blocks(id, block_type, content, order)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (filterLanguageId) {
    query = query.eq("language_id", filterLanguageId);
  }

  const from = (pageNumber - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: pagesData, count, error } = await query.range(from, to);

  if (error) {
    console.error("Error fetching pages:", error);
    return { items: [], totalCount: 0 };
  }
  if (!pagesData) return { items: [], totalCount: 0 };

  const items = pagesData.map((p) => {
    const langInfo = p.languages as unknown as { code: string } | null;
    const rawBlocks = (p.blocks || []) as unknown as Parameters<typeof buildPageSeoDocument>[0];
    const doc = buildPageSeoDocument(rawBlocks);
    const auditResult = auditSeo({
      document: doc,
      metaTitle: p.meta_title ?? undefined,
      metaDescription: p.meta_description ?? undefined,
      scope: "page",
    });

    const langCode = langInfo?.code || langMap.get(p.language_id) || "N/A";

    return {
      page: p as unknown as Page,
      languageCode: String(langCode).toUpperCase(),
      seoScore: auditResult.score,
    };
  });

  return { items, totalCount: count ?? items.length };
}

interface CmsPagesListPageProps {
  searchParams?: Promise<{
    lang?: string;
    success?: string;
    page?: string;
    pageSize?: string;
  }>;
}

export default async function CmsPagesListPage(props: CmsPagesListPageProps) {
  const searchParams = await props.searchParams;
  const allLanguages = await getActiveLanguagesServerSide();
  const selectedLangId = searchParams?.lang
    ? parseInt(searchParams.lang, 10)
    : undefined;

  const isValidLangId = selectedLangId
    ? allLanguages.some((l) => l.id === selectedLangId)
    : true;
  const filterLangId = isValidLangId ? selectedLangId : undefined;

  const pageNumber = searchParams?.page
    ? Math.max(1, parseInt(searchParams.page, 10) || 1)
    : 1;
  const pageSize = searchParams?.pageSize
    ? Math.max(1, parseInt(searchParams.pageSize, 10) || 25)
    : 25;

  const { items: pagesWithDetails, totalCount } = await getPagesWithDetails(
    filterLangId,
    pageNumber,
    pageSize
  );
  const successMessage = searchParams?.success;

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6 flex-wrap gap-4">
        <h1 className="text-2xl font-semibold">Manage Pages</h1>
        <div className="flex items-center gap-3">
          <ContentTransferControls
            contentType="pages"
            label="Pages"
            languageId={filterLangId}
            hasContent={pagesWithDetails.length > 0}
          />
          <LanguageFilterSelect
            allLanguages={allLanguages}
            currentFilterLangId={filterLangId}
            basePath="/cms/pages"
          />
          <Button variant="default" asChild>
            <Link href="/cms/pages/new">
              <PlusCircle className="mr-2 h-4 w-4" /> Create New Page
            </Link>
          </Button>
        </div>
      </div>

      {successMessage && (
        <Alert variant="success" className="mb-4">
          <AlertDescription>
            {decodeURIComponent(successMessage)}
          </AlertDescription>
        </Alert>
      )}

      {totalCount === 0 ? (
        <div className="text-center py-10 border rounded-lg dark:border-slate-700">
          <FileText className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-2 text-sm font-medium text-foreground">
            {filterLangId
              ? "No pages found for the selected language."
              : "No pages found."}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Get started by creating a new page.
          </p>
          <div className="mt-6">
            <Button asChild>
              <Link href="/cms/pages/new">
                <PlusCircle className="mr-2 h-4 w-4" /> Create Page
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden dark:border-slate-700">
          <Table>
            <TableHeader>
              <TableRow className="dark:border-slate-700">
                <TableHead className="w-[280px] sm:w-[350px]">Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Language</TableHead>
                <TableHead className="hidden md:table-cell">Slug</TableHead>
                <TableHead>SEO</TableHead>
                <TableHead className="hidden lg:table-cell">
                  Last Updated
                </TableHead>
                <TableHead className="text-right w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagesWithDetails.map(({ page, languageCode, seoScore }) => (
                <TableRow key={page.id} className="dark:border-slate-700">
                  <TableCell className="font-medium">
                    <Link
                      href={`/cms/pages/${page.id}/edit`}
                      className="flex items-center cursor-pointer"
                    >
                      <Edit3 className="mr-2 h-4 w-4" />
                      {page.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <VisibilityBadge
                      type="page"
                      status={page.status}
                      publishedAt={page.published_at}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="dark:border-slate-600">
                      {languageCode}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden md:table-cell">
                    /{page.slug}
                  </TableCell>
                  <TableCell>
                    <SeoScoreBadge score={seoScore} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                    {new Date(page.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuButtonTrigger id={`page-trigger-${page.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">
                          Page actions for {page.title}
                        </span>
                      </DropdownMenuButtonTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/cms/pages/${page.id}/edit`}
                            className="flex items-center cursor-pointer"
                          >
                            <Edit3 className="mr-2 h-4 w-4" /> Edit
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DeletePageButtonClient
                          pageId={page.id}
                          pageTitle={page.title}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <TablePagination
            currentPage={pageNumber}
            pageSize={pageSize}
            totalCount={totalCount}
            basePath="/cms/pages"
            itemLabel="pages"
          />
        </div>
      )}
    </div>
  );
}
