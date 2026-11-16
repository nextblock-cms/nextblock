import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';
import { getActiveLanguagesServerSide } from '@nextblock-cms/db/server';
import { createClient } from '@nextblock-cms/db/server';
import Link from 'next/link';
import {
  createProductAction,
  getGlobalProductAttributes,
  getEnabledPaymentProviders,
  getProduct,
  getStoreConfigStatus,
  normalizeCurrencyRecord,
  getCategoriesWithCount,
  getProductCategories,
} from '@nextblock-cms/ecommerce/server';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button } from '@nextblock-cms/ui';
import ProductFormClientShell from '../ProductFormClientShell';
import {
  buildGlobalAttributesForForm,
  buildProductFormInitialData,
  buildTranslationSourceInitialData,
} from '../productFormData';

export default async function NewProductPage({ 
  searchParams 
}: { 
  searchParams: Promise<{ from_group?: string; target_lang_id?: string }> 
}) {
  const [
    isOnline,
    languages,
    enabledProviders,
    configStatus,
    globalAttributesRaw,
    currenciesResult,
    categories,
    { from_group, target_lang_id },
  ] = await Promise.all([
    verifyPackageOnline('ecommerce'),
    getActiveLanguagesServerSide(),
    getEnabledPaymentProviders(),
    getStoreConfigStatus(),
    getGlobalProductAttributes(),
    createClient()
      .from('currencies')
      .select(
        'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
      )
      .eq('is_active', true)
      .order('code', { ascending: true }),
    getCategoriesWithCount(),
    searchParams,
  ]);

  if (!isOnline) {
      redirect('/cms/settings/packages');
  }

  let initialData = null;
  if (from_group) {
    try {
      const supabase = createClient();
      const { data: groupProducts } = await supabase
        .from('products')
        .select('id')
        .eq('translation_group_id', from_group)
        .limit(1);
      
      if (groupProducts && groupProducts[0]) {
        const [{ data: sourceProduct, error: fetchError }, sourceCategories] = await Promise.all([
          getProduct(supabase, groupProducts[0].id),
          // Categories belong to the translation group: createProduct() syncs the form's
          // category_ids to every product in it, so a translation form that started with none
          // removed the categories of the whole group (review 2026-11-15).
          getProductCategories(groupProducts[0].id),
        ]);
        if (sourceProduct && !fetchError) {
          initialData = {
            ...buildTranslationSourceInitialData(sourceProduct, from_group, target_lang_id),
            category_ids: (sourceCategories ?? []).map((category: { id: string }) => category.id),
          };
        }
      }
    } catch (e) {
      console.error('Error pre-filling translation data:', e);
    }
  }

  const targetLanguageId = target_lang_id ? Number.parseInt(target_lang_id, 10) : undefined;
  const targetLanguage =
    Number.isFinite(targetLanguageId)
      ? languages.find((language) => language.id === targetLanguageId)
      : null;
  const globalAttributes = buildGlobalAttributesForForm(globalAttributesRaw || []);
  const currencies = (currenciesResult.data ?? []).map((currency) =>
    normalizeCurrencyRecord(currency)
  );
  const normalizedInitialData = buildProductFormInitialData(
    initialData,
    languages,
    targetLanguageId
  );

  return (
    <div className="space-y-8 w-full max-w-[1400px] mx-auto px-6 py-8">
      <div className="flex justify-between items-start flex-wrap gap-4 w-full">
        <div className="flex items-start gap-3">
          <Button variant="outline" size="icon" aria-label="Back to products" asChild>
            <Link href="/cms/products">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">
                {targetLanguage ? `Create ${targetLanguage.name} Translation` : 'Create Product'}
              </h1>
              {targetLanguage ? (
                <Badge variant="secondary">
                  {targetLanguage.code.toUpperCase()}
                </Badge>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground max-w-3xl">
              {targetLanguage
                ? 'We prefilled this draft from the source product so you can localize the content and fine-tune pricing, media, and variations faster.'
                : 'Build a catalog-ready product with structured information, media, pricing, inventory, and optional variations.'}
            </p>
          </div>
        </div>
      </div>

      <ProductFormClientShell
        availableLanguagesProp={languages}
        globalAttributesProp={globalAttributes}
        currenciesProp={currencies}
        translationGroupId={from_group}
        targetLanguageId={target_lang_id}
        initialData={normalizedInitialData}
        enabledProviders={enabledProviders}
        configStatus={configStatus}
        createAction={createProductAction}
        availableCategoriesProp={categories}
      />
    </div>
  );
}

