import { verifyPackageOnline, getActiveLanguagesServerSide } from '@nextblock-cms/db/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, Eye, FilePenLine } from 'lucide-react';
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
} from '../../productFormData';
import { CortexAiPageContextRegistrar } from '../../../components/CortexAiPageContext';
import BlockEditorArea from '../../../blocks/components/BlockEditorArea';
import VisibilityControl from '../../../components/VisibilityControl';
import RevisionHistoryButton from '../../../revisions/RevisionHistoryButton';
import { buildViewUrl } from '../../../../../lib/publishing/viewUrl';
import { PageSeoProvider } from '../../../../../lib/seo/page-audit-context';
import { PageSeoAuditSection } from '../../../../../components/seo/PageSeoAuditSection';

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ missing_lang_id?: string }>;
}) {
  const [
    { id },
    { missing_lang_id },
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

  const product = await getCmsProduct(id);

  if (!product) {
    notFound();
  }

  const [globalAttributesRaw, translations, allCategories, assignedCategories] = await Promise.all([
    getGlobalProductAttributes(),
    product.translation_group_id ? getProductTranslations(product.translation_group_id) : Promise.resolve([]),
    getCategoriesWithCount(),
    getProductCategories(product.id),
  ]);
  const supabase = createClient();
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
  let normalizedInitialData = {
    ...buildProductFormInitialData(product, languages),
    category_ids: assignedCategories.map((c: any) => c.id),
  };
  if (draftData && draftData.meta && typeof draftData.meta === 'object') {
    const meta = draftData.meta as any;

    // Drafts store product_media as { media_id } only, so the gallery loses the
    // file_path/object_key needed to render thumbnails. Re-hydrate from the
    // media table so the main image (and the rest of the gallery) still loads.
    let hydratedProductMedia = meta.product_media;
    if (Array.isArray(meta.product_media) && meta.product_media.length > 0) {
      const draftMediaIds = meta.product_media
        .map((pm: any) => pm?.media_id)
        .filter(Boolean);
      if (draftMediaIds.length > 0) {
        const { data: mediaRows } = await supabase
          .from('media')
          .select('id, file_path, object_key, file_name, description')
          .in('id', draftMediaIds);
        const mediaById = new Map((mediaRows || []).map((m: any) => [m.id, m]));
        hydratedProductMedia = meta.product_media.map((pm: any, index: number) => {
          const media = mediaById.get(pm?.media_id);
          return {
            media_id: pm?.media_id,
            sort_order: pm?.sort_order ?? index,
            media: media
              ? {
                  file_path: media.file_path,
                  object_key: media.object_key,
                  alt_text: media.description || media.file_name || '',
                }
              : pm?.media ?? null,
          };
        });
      }
    }

    // Product drafts persist prices in major units (dollars, the ProductForm
    // value shape), but ProductForm re-divides the top-level price/sale_price by
    // 100 because it expects a raw product row (minor units/cents). Convert the
    // draft's dollars back to cents so the form shows the saved amount instead of
    // 1/100th of it (e.g. an imported $29.50 draft otherwise renders as $0.30).
    // The prices maps and variant prices are already in the dollar shape the form
    // consumes directly, so only these two scalars need converting.
    const draftDollarsToStoredCents = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : value;

    normalizedInitialData = {
      ...meta,
      id: product.id,
      price: draftDollarsToStoredCents(meta.price),
      sale_price: draftDollarsToStoredCents(meta.sale_price),
      product_media: hydratedProductMedia,
      category_ids: meta.category_ids ?? assignedCategories.map((c: any) => c.id),
    };
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
          />
        </div>
      </div>

      <ProductFormClientShell
        productId={product.id}
        serverHasDraft={hasDraft}
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
    </PageSeoProvider>
  );
}
