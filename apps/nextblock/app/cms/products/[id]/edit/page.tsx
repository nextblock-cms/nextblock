import { verifyPackageOnline, getActiveLanguagesServerSide } from '@nextblock-cms/db/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, ChevronDown, Eye, FilePenLine } from 'lucide-react';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuButtonTrigger,
} from '@nextblock-cms/ui';
import ProductFormClientShell from '../../ProductFormClientShell';
import { ProductDraftFlagProvider } from '../../ProductDraftFlagProvider';
import { buildProductCreatedIncompleteNotice } from '@nextblock-cms/ecommerce/product-actions';
import {
  getCmsProduct,
  getEnabledPaymentProviders,
  getGlobalProductAttributes,
  getProductTranslations,
  getStoreConfigStatus,
  getStoreReadiness,
  normalizeCurrencyRecord,
  updateProductAction,
  getCategoriesWithCount,
  getProductCategories,
} from '@nextblock-cms/ecommerce/server';
import { createClient } from '@nextblock-cms/db/server';
import {
  buildGlobalAttributesForForm,
  buildProductFormInitialData,
  buildProductStockBaseline,
  getProductDraftEditNotices,
  mergeProductDraftMetaIntoFormInitialData,
  readProductDraftGalleryMediaIds,
  readProductStockPublishAnswer,
  resolveProductDraftGalleryForEdit,
  type ProductDraftGalleryMediaRow,
  type ProductDraftGalleryTile,
  type ProductStockPublish,
} from '../../productFormData';
import { currentUserCanPublishProductDrafts } from '../../../../../lib/visual-editing/product-drafts';
import { CortexAiPageContextRegistrar } from '../../../components/CortexAiPageContext';
import BlockEditorArea from '../../../blocks/components/BlockEditorArea';
import VisibilityControl from '../../../components/VisibilityControl';
import RevisionHistoryButton from '../../../revisions/RevisionHistoryButton';
import { buildViewUrl } from '../../../../../lib/publishing/viewUrl';
import { PageSeoProvider } from '../../../../../lib/seo/page-audit-context';
import { PageSeoAuditSection } from '../../../../../components/seo/PageSeoAuditSection';

/**
 * The product's product_stock_publishes row as the page's caller reads it (staff read the table; the
 * policy is migration 02047's), through readProductStockPublishAnswer.
 */
async function readStockPublishForEdit(
  supabase: ReturnType<typeof createClient>,
  productId: string
): Promise<ProductStockPublish> {
  const answer = await (supabase as any)
    .from('product_stock_publishes')
    .select('publish_count, stock')
    .eq('product_id', productId)
    .maybeSingle();
  return readProductStockPublishAnswer(answer);
}

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ missing_lang_id?: string; created_incomplete?: string }>;
}) {
  const [
    { id },
    { missing_lang_id, created_incomplete },
    isOnline,
    languages,
    enabledProviders,
    configStatus,
    storeReadiness,
  ] =
    await Promise.all([
      params,
      searchParams,
      verifyPackageOnline('ecommerce'),
      getActiveLanguagesServerSide(),
      getEnabledPaymentProviders(),
      getStoreConfigStatus(),
      getStoreReadiness(),
    ]);

  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  const supabase = createClient();
  // The product's last product-values publish (public.product_stock_publishes, migration 02047), read
  // BEFORE the product: the form records its count beside the stock it loads (stock_baseline_publish_count),
  // and a publish counts a baseline whose count is below the product's from the figures that publish
  // entered. A publish landing between the two reads then makes this page's baseline look older than it
  // is, never newer: read after the product, its count would vouch for a stock read before the publish,
  // whose change the next publish would apply again. A draft's stock is shown as publish decides it from
  // the same row. A database without the table (migration 02047 not applied yet) records no publish, as
  // its publish ignores the count; any other failure fails the page rather than show a stock it could not
  // check.
  const stockPublish = await readStockPublishForEdit(supabase, id);

  const product = await getCmsProduct(id);

  if (!product) {
    notFound();
  }

  const [globalAttributesRaw, translations, allCategories, assignedCategories, canPublishProduct] = await Promise.all([
    getGlobalProductAttributes(),
    product.translation_group_id ? getProductTranslations(product.translation_group_id) : Promise.resolve([]),
    getCategoriesWithCount(),
    getProductCategories(product.id),
    // Only an ADMIN past the second factor may publish a product draft (the CMS layout already
    // resolved this actor for the request), and only an ADMIN may change a product's visibility
    // (products_update_policy). Anyone else sees the draft bar's Publish and every visibility action
    // disabled with a note; the server checks again whatever this page showed.
    currentUserCanPublishProductDrafts(),
  ]);
  const { data: currenciesResult } = await supabase
    .from('currencies')
    .select(
      'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
    )
    .eq('is_active', true)
    .order('code', { ascending: true });
  const currencies = (currenciesResult ?? []).map((currency) =>
    normalizeCurrencyRecord(currency)
  );

  const missingLanguageId = missing_lang_id ? parseInt(missing_lang_id, 10) : null;
  const missingLanguage =
    missingLanguageId && Number.isFinite(missingLanguageId)
      ? languages.find((language) => language.id === missingLanguageId)
      : null;
  const translationByLanguageId = new Map(
    translations.map((translation: any) => [translation.language_id, translation])
  );
  const existingLanguages = languages.filter(
    (language) => language.id === product.language_id || translationByLanguageId.has(language.id)
  );
  const missingLanguages = languages.filter(
    (language) => language.id !== product.language_id && !translationByLanguageId.has(language.id)
  );
  const primaryCreateLanguage =
    missingLanguage && missingLanguages.some((language) => language.id === missingLanguage.id)
      ? missingLanguage
      : missingLanguages.length === 1
        ? missingLanguages[0]
        : null;
  const additionalCreateLanguages = missingLanguages.filter(
    (language) => language.id !== primaryCreateLanguage?.id
  );
  const buildTranslationCreateHref = (languageId: number) =>
    `/cms/products/new?from_group=${product.translation_group_id}&target_lang_id=${languageId}`;
  const globalAttributes = buildGlobalAttributesForForm(globalAttributesRaw || []);
  const productLanguage = languages.find((language) => language.id === product.language_id);

  // The Status select used to sit inside ProductForm, where submitting with status
  // "active" was blocked unless the payment provider was enabled and configured.
  // Publishing now happens outside the form, so that guidance travels with it — but as
  // a WARNING, not a block: an owner should be able to build a catalogue while their
  // Stripe onboarding is still in progress. The storefront covers the gap by offering
  // shoppers an enquiry form in place of Add-to-Cart.
  const productProvider = product.payment_provider as 'stripe' | 'freemius' | undefined;
  const providerReadiness = productProvider ? storeReadiness[productProvider] : null;
  const publishWarning =
    providerReadiness && !providerReadiness.ready
      ? `${providerReadiness.label} isn't set up yet${
          providerReadiness.missing.length ? ` (missing: ${providerReadiness.missing.join(', ')})` : ''
        }, so nobody can buy this product. It will still go live — visitors will see a "Contact the seller" form instead of Add to cart. Finish setting up payments at CMS → Payments.`
      : null;

  const { data: draftData } = await supabase
    .from('product_drafts')
    .select('*')
    .eq('product_id', product.id)
    .maybeSingle();

  const hasDraft = draftData !== null;
  const liveFormData = {
    ...buildProductFormInitialData(product, languages),
    category_ids: assignedCategories.map((c: any) => c.id),
  };
  // The stock the form loads, per SKU: the autosave records it in the draft, and publishing writes a
  // SKU's stock only where the draft's quantity differs from it and from the current stock, as a change
  // to the stock as it then is (buildProductStockBaseline), so a sale made while this page is open keeps
  // its deduction; beside it the product's publish count as read above, so a publish can tell a baseline
  // loaded before the product's last publish (migration 02047). With a draft open,
  // mergeProductDraftMetaIntoFormInitialData shows SKU by SKU what publishing that draft would write, and
  // records the live stock of every SKU the product stocks, with this count.
  const liveInitialData = {
    ...liveFormData,
    stock_baseline: buildProductStockBaseline(liveFormData),
    stock_baseline_publish_count: stockPublish.count,
  };
  let normalizedInitialData = liveInitialData;
  // Notes above the form for a draft publish would refuse or skip parts of (getProductDraftEditNotices).
  // One an earlier version wrote that publish refuses, shown with the live values for the fields it
  // names (findPoisonedProductDraftFields): a pre-0.23.4 form autosave over a row snapshot (amounts
  // equal to the live minor amounts or at least 20 times the live ones, a Freemius plan price in cents,
  // rebuilt or emptied variants, the snapshot's stock, an emptied gallery or description), or the
  // gallery, variants or description a pre-0.23.4 CMS draft import left empty. Or a pre-0.23.4 row
  // snapshot, or an overlay rewritten from one (its recorded legacy_snapshot_fields), whose title, short
  // description or description publish would skip. Or product values holding a stock or a SKU publish
  // cannot read (findUnreadableProductDraftValues: only a hand-written draft holds one), which publish
  // refuses; the form shows the live stock in place of a stock it cannot read. Or the SKUs whose stock the
  // form shows already live, or applied to a stock that moved since the draft's change started at another
  // figure than the draft's, each with its figures, the first five of a kind as publish's warning names
  // them (reconcileProductDraftStock, from the same merge as the figures the form shows, run again over
  // the same product): the next autosave records the live stock as the baseline, after which a publish
  // sees neither case.
  let draftNotices: string[] = [];
  // The CMS create sends the editor here when the product was created but a step after it was not saved
  // (createProductAction, ProductCreatedIncompleteError): the notice names each step it knows from the
  // URL's fixed list, and nothing else from the URL is shown.
  const createdIncompleteNotice = buildProductCreatedIncompleteNotice(created_incomplete);
  if (draftData && draftData.meta && typeof draftData.meta === 'object') {
    const meta = draftData.meta as any;
    draftNotices = getProductDraftEditNotices(meta, product, draftData.created_at, stockPublish);

    // Only the form's own autosave (or a CMS draft import) stages product values. A draft that a
    // block edit or the in-page editor created stages the title, short description and
    // description at most, and one created before 0.23.4 holds the raw products row in cents:
    // mergeProductDraftMetaIntoFormInitialData lays either over the live data instead of showing
    // it as form values (lib/visual-editing/product-draft-meta.ts).
    //
    // A draft's gallery is shown as publish will write it (resolveProductDraftGalleryForEdit): the
    // ids publish writes, in its order, each drawn from its media row, never from the draft's own
    // entries (any WRITER can write those, embedded `media` objects and `sort_order` included). The
    // ids are uuids by then, so the query cannot fail on one; if it fails anyway the page fails
    // rather than show a gallery it could not check.
    let hydratedProductMedia: ProductDraftGalleryTile[] | undefined;
    const draftGalleryMediaIds = readProductDraftGalleryMediaIds(meta);
    if (draftGalleryMediaIds) {
      let galleryMediaRows: ProductDraftGalleryMediaRow[] = [];
      if (draftGalleryMediaIds.length > 0) {
        const { data: mediaRows, error: mediaError } = await supabase
          .from('media')
          .select('id, file_path, object_key, file_name, description')
          .in('id', draftGalleryMediaIds);
        if (mediaError) {
          throw new Error(`The draft's gallery could not be read: ${mediaError.message}`);
        }
        galleryMediaRows = (mediaRows ?? []) as ProductDraftGalleryMediaRow[];
      }

      const draftGallery = resolveProductDraftGalleryForEdit(meta, product, galleryMediaRows);
      hydratedProductMedia = draftGallery?.tiles;
      if (draftGallery?.notice) {
        draftNotices.push(draftGallery.notice);
      }
    }

    // Product values merge over the live data (a key the draft lacks keeps its live value), and
    // their top-level price and sale price go back to the cents ProductForm reads; an overlay or a
    // row snapshot only lends the title, short description and description publish would write.
    // The global attributes ProductForm gets name the terms of a CMS draft import's variants, which
    // carry their attribute terms only.
    normalizedInitialData = mergeProductDraftMetaIntoFormInitialData(liveInitialData, meta, {
      productId: product.id,
      liveProduct: product,
      draftCreatedAt: draftData.created_at,
      hydratedProductMedia,
      globalAttributes,
      stockPublish,
    });
  }

  let descriptionBlocks: any[] = [];
  if (draftData && draftData.blocks && Array.isArray(draftData.blocks)) {
    descriptionBlocks = draftData.blocks;
  } else {
    const { data: liveBlocks } = await supabase
      .from('blocks')
      .select('*')
      .eq('product_id', product.id)
      .order('order', { ascending: true });
    descriptionBlocks = liveBlocks || [];
  }

  return (
    <PageSeoProvider
      documentTitle={product.title}
      documentType="product"
      initialBlocks={descriptionBlocks}
      initialMetaDescription={product.meta_description}
      initialMetaTitle={product.meta_title}
    >
      {/* One draft flag for the editor shell and the visibility control: the form's autosave creates
          a draft without revalidating this page, so `hasDraft` is stale until a reload, and the
          shell latches the shared flag on after an autosave (ProductDraftFlagProvider). */}
      <ProductDraftFlagProvider serverHasDraft={hasDraft}>
      <div className="space-y-8 w-full max-w-[1400px] mx-auto px-6 py-8">
        <CortexAiPageContextRegistrar
        context={{
          contentType: 'product',
          entityId: product.id,
          languageId: product.language_id,
          slug: product.slug,
          title: product.title,
          translationGroupId: product.translation_group_id,
        }}
      />
      <div className="flex justify-between items-center flex-wrap gap-4 w-full">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" aria-label="Back to products" asChild>
            <Link href="/cms/products">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Edit Product</h1>
            <p className="text-sm text-muted-foreground truncate max-w-md" title={product.title}>
              {product.title}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {existingLanguages.map((language) => {
            const version = translationByLanguageId.get(language.id);
            const isCurrent = language.id === product.language_id;
            const href = version
              ? `/cms/products/${version.id}/edit`
              : `/cms/products/${product.id}/edit`;

            return (
              <Button key={language.id} asChild variant={isCurrent ? 'default' : 'outline'} size="sm">
                <Link href={href}>
                  {language.name} ({language.code.toUpperCase()})
                </Link>
              </Button>
            );
          })}

          {primaryCreateLanguage && product.translation_group_id ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={buildTranslationCreateHref(primaryCreateLanguage.id)}>
                Create {primaryCreateLanguage.name} Translation
              </Link>
            </Button>
          ) : null}

          {additionalCreateLanguages.length > 0 && product.translation_group_id ? (
            <DropdownMenu>
              <DropdownMenuButtonTrigger
                id={`create-translation-trigger-${product.id}`}
                variant="outline"
                size="sm"
              >
                Create Translation
                <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">
                  {additionalCreateLanguages.length}
                </Badge>
                <ChevronDown className="ml-2 h-4 w-4" />
              </DropdownMenuButtonTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Missing Languages</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {additionalCreateLanguages.map((language) => (
                  <DropdownMenuItem key={language.id} asChild>
                    <Link href={buildTranslationCreateHref(language.id)}>
                      Create {language.name}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {product.slug ? (
            <>
              <Button variant="secondary" asChild>
                <a
                  href={buildViewUrl({
                    path: `/product/${product.slug}`,
                    languageCode: productLanguage?.code ?? null,
                    draft: true,
                  })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FilePenLine className="mr-2 h-4 w-4" /> Preview
                </a>
              </Button>
              {product.status === 'active' ? (
                <Button variant="outline" asChild>
                  <a
                    href={buildViewUrl({
                      path: `/product/${product.slug}`,
                      languageCode: productLanguage?.code ?? null,
                    })}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Eye className="mr-2 h-4 w-4" /> View Live
                  </a>
                </Button>
              ) : null}
            </>
          ) : null}

          <RevisionHistoryButton parentType="product" parentId={product.id} />

          <VisibilityControl
            type="product"
            id={product.id}
            status={product.status}
            publishedAt={(product as { published_at?: string | null }).published_at ?? null}
            publicPath={`/product/${product.slug}`}
            languageName={
              productLanguage
                ? `${productLanguage.name} (${productLanguage.code.toUpperCase()})`
                : undefined
            }
            translationGroupId={product.translation_group_id}
            languages={languages}
            hasDraft={hasDraft}
            publishWarning={publishWarning}
            canPublishProduct={canPublishProduct}
          />
        </div>
      </div>

      {[...(createdIncompleteNotice ? [createdIncompleteNotice] : []), ...draftNotices].map((notice) => (
        <div
          key={notice}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ))}

      <ProductFormClientShell
        productId={product.id}
        serverHasDraft={hasDraft}
        canPublishProduct={canPublishProduct}
        initialData={normalizedInitialData}
        isEdit
        availableLanguagesProp={languages}
        globalAttributesProp={globalAttributes}
        currenciesProp={currencies}
        enabledProviders={enabledProviders}
        configStatus={configStatus}
        updateAction={updateProductAction.bind(null, product.id)}
        availableCategoriesProp={allCategories}
      />

      <PageSeoAuditSection className="my-6" />

      <div className="border-t pt-8">
        <h2 className="text-xl font-bold mb-4">Product Description Blocks</h2>
        <BlockEditorArea
          parentId={product.id}
          parentType="product"
          initialBlocks={descriptionBlocks}
          languageId={product.language_id}
        />
      </div>
    </div>
    </ProductDraftFlagProvider>
    </PageSeoProvider>
  );
}
