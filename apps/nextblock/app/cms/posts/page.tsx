// app/cms/posts/page.tsx
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
import { MoreHorizontal, PlusCircle, Edit3, PenTool } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuButtonTrigger,
  DropdownMenuSeparator,
} from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";
import { getActiveLanguagesServerSide } from "@nextblock-cms/db/server";
import { resolveMediaUrl } from "../../../lib/media/resolveMediaUrl";
import { auditSeo } from "@nextblock-cms/utils/seo";
import { buildPageSeoDocument } from "../../../lib/seo/page-document";

type Post = Database['public']['Tables']['posts']['Row'] & { feature_image_url?: string | null };
import LanguageFilterSelect from "../components/LanguageFilterSelect";
import DeletePostButtonClient from "./components/DeletePostButtonClient";
import { ContentTransferControls } from "../import-export/ContentTransferControls";
import VisibilityBadge from "../components/VisibilityBadge";
import SeoScoreBadge from "../components/SeoScoreBadge";
import TablePagination from "../components/TablePagination";

async function getPostsWithDetails(
  filterLanguageId?: number,
  pageNumber: number = 1,
  pageSize: number = 25
): Promise<{
  items: { post: Post; languageCode: string; seoScore: number }[];
  totalCount: number;
}> {
  const supabase = createClient();
  const languages = await getActiveLanguagesServerSide();
  const langMap = new Map(languages.map(l => [l.id, l.code]));

  let query = supabase
    .from("posts")
    .select("*, languages!inner(code), media ( object_key ), blocks(id, block_type, content, order)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (filterLanguageId) {
    query = query.eq("language_id", filterLanguageId);
  }

  const from = (pageNumber - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: postsData, count, error } = await query.range(from, to);

  if (error) {
    console.error("Error fetching posts:", error);
    return { items: [], totalCount: 0 };
  }
  if (!postsData) return { items: [], totalCount: 0 };

  const items = postsData.map(p => {
    const langInfo = p.languages as unknown as { code: string } | null;
    const rawBlocks = (p.blocks || []) as unknown as Parameters<typeof buildPageSeoDocument>[0];
    const doc = buildPageSeoDocument(rawBlocks, {
      documentTitle: p.title,
      documentType: "post",
    });
    const auditResult = auditSeo({
      document: doc,
      metaTitle: p.meta_title ?? undefined,
      metaDescription: p.meta_description ?? undefined,
      scope: "page",
    });

    const langCode = langInfo?.code || langMap.get(p.language_id) || "N/A";

    return {
      post: { ...p, feature_image_url: resolveMediaUrl(p.media?.object_key) } as Post,
      languageCode: String(langCode).toUpperCase(),
      seoScore: auditResult.score,
    };
  });

  return { items, totalCount: count ?? items.length };
}

interface CmsPostsListPageProps {
  searchParams?: Promise<{
    lang?: string;
    success?: string;
    page?: string;
    pageSize?: string;
  }>;
}

export default async function CmsPostsListPage(props: CmsPostsListPageProps) {
  const searchParams = await props.searchParams;
  const allLanguages = await getActiveLanguagesServerSide();
  const selectedLangId = searchParams?.lang ? parseInt(searchParams.lang, 10) : undefined;
  const isValidLangId = selectedLangId ? allLanguages.some(l => l.id === selectedLangId) : true;
  const filterLangId = isValidLangId ? selectedLangId : undefined;

  const pageNumber = searchParams?.page
    ? Math.max(1, parseInt(searchParams.page, 10) || 1)
    : 1;
  const pageSize = searchParams?.pageSize
    ? Math.max(1, parseInt(searchParams.pageSize, 10) || 25)
    : 25;

  const { items: postsWithDetails, totalCount } = await getPostsWithDetails(
    filterLangId,
    pageNumber,
    pageSize
  );
  const successMessage = searchParams?.success;

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6 flex-wrap gap-4">
        <h1 className="text-2xl font-semibold">Manage Posts</h1>
        <div className="flex items-center gap-3">
          <ContentTransferControls
            contentType="posts"
            label="Posts"
            languageId={filterLangId}
            hasContent={postsWithDetails.length > 0}
          />
          <LanguageFilterSelect
            allLanguages={allLanguages}
            currentFilterLangId={filterLangId}
            basePath="/cms/posts"
          />
          <Button variant="default" asChild>
            <Link href="/cms/posts/new">
              <PlusCircle className="mr-2 h-4 w-4" /> Create New Post
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
          <PenTool className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-2 text-sm font-medium text-foreground">
            {filterLangId
              ? "No posts found for the selected language."
              : "No posts found."}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Get started by creating a new post.
          </p>
          <div className="mt-6">
            <Button asChild>
              <Link href="/cms/posts/new">
                <PlusCircle className="mr-2 h-4 w-4" /> Create Post
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
                <TableHead className="hidden lg:table-cell">Published At</TableHead>
                <TableHead className="text-right w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {postsWithDetails.map(({ post, languageCode, seoScore }) => (
                <TableRow key={post.id} className="dark:border-slate-700">
                  <TableCell className="font-medium">
                    <Link
                      href={`/cms/posts/${post.id}/edit`}
                      className="flex items-center cursor-pointer"
                    >
                      <Edit3 className="mr-2 h-4 w-4" />
                      {post.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <VisibilityBadge
                      type="post"
                      status={post.status}
                      publishedAt={post.published_at}
                    />
                  </TableCell>
                  <TableCell><Badge variant="outline" className="dark:border-slate-600">{languageCode}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden md:table-cell">/article/{post.slug}</TableCell>
                  <TableCell>
                    <SeoScoreBadge score={seoScore} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                    {post.published_at ? new Date(post.published_at).toLocaleDateString() : "Not yet"}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuButtonTrigger id={`post-trigger-${post.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Post actions for {post.title}</span>
                      </DropdownMenuButtonTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/cms/posts/${post.id}/edit`} className="flex items-center cursor-pointer">
                            <Edit3 className="mr-2 h-4 w-4" /> Edit
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DeletePostButtonClient postId={post.id} />
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
            basePath="/cms/posts"
            itemLabel="posts"
          />
        </div>
      )}
    </div>
  );
}
