import 'server-only';

import { ProductForm } from '../../components/ProductForm';
import { getProduct, getFreemiusPricingByProductId, getGlobalProductAttributes } from '../../actions';
import { FreemiusPricingDashboard } from '../../components/FreemiusPricingDashboard';

import { DeleteProductButton } from '../../components/DeleteProductButton';

import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@nextblock-cms/ui';
import { mapRawVariantRelations } from '../../../../../variation-utils';
import { deleteProductAction, updateProductAction } from '../../server-actions';
import {
  getEnabledPaymentProviders,
  getStoreConfigStatus,
} from '../../../payments/queries';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { minorUnitAmountToMajor } from '@nextblock-cms/utils';
import { normalizeCurrencyRecord } from '../../../../../currency';

interface EditProductPageProps {
  params: Promise<{
    id: string;
  }>;
  mediaPickerNode?: React.ReactNode;
  availableLanguagesProp: any[];
  languageSwitcherNode?: React.ReactNode;
  copyContentNode?: React.ReactNode;
  translationCtaNode?: React.ReactNode;
}

export async function EditProductPage({ 
  params, 
  mediaPickerNode, 
  availableLanguagesProp,
  languageSwitcherNode,
  copyContentNode,
  translationCtaNode
}: EditProductPageProps) {
  const { id } = await params;
  const product = await getProduct(id) as any;

  if (!product) {
    notFound();
  }

  const isDigitalProduct =
    product.product_type === 'digital' || product.payment_provider === 'freemius';
  const [enabledProviders, configStatus, pricingPlans, globalAttributesRaw, currenciesResult] =
    await Promise.all([
      getEnabledPaymentProviders(),
      getStoreConfigStatus(),
      isDigitalProduct && product.freemius_product_id
        ? getFreemiusPricingByProductId(product.id)
        : Promise.resolve(null),
      getGlobalProductAttributes(),
      getServiceRoleSupabaseClient()
        .from('currencies')
        .select(
          'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
        )
        .eq('is_active', true)
        .order('code', { ascending: true })
        .then((result) => result.data || []),
    ]);

  const currencies = (currenciesResult || []).map((currency) =>
    normalizeCurrencyRecord(currency)
  );
  const currentLanguageCode =
    availableLanguagesProp.find((language) => language.id === product.language_id)?.code;
  const { attributes: productAttributes, variants } = mapRawVariantRelations(
    product.product_variants || [],
    currentLanguageCode
  );
  const globalAttributes = (globalAttributesRaw || []).map((attribute: any) => ({
    id: attribute.id,
    name: attribute.name,
    name_translations: attribute.name_translations || {},
    slug: attribute.slug,
    terms: (attribute.product_attribute_terms || []).map((term: any) => ({
      ...term,
      value_translations: term.value_translations || {},
    })),
  }));
  const DeleteProductButtonComponent = DeleteProductButton;
  const FreemiusPricingDashboardComponent = FreemiusPricingDashboard;

  return (
    <div className="space-y-8 w-full max-w-[1400px] mx-auto px-6 py-8">
      <div className="flex justify-between items-center flex-wrap gap-4 w-full">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            aria-label="Back to products"
            asChild
          >
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
           {languageSwitcherNode}
           {copyContentNode}
           {translationCtaNode}
           {DeleteProductButtonComponent ? (
             <DeleteProductButtonComponent 
                  productName={product.title} 
                  redirectTo="/cms/products"
                  className="border-red-200 hover:bg-red-50 hover:text-red-700"
                  deleteAction={deleteProductAction.bind(null, product.id)}
              />
           ) : null}
            {product.slug && product.status === 'active' && (
                 <Button variant="outline" asChild>
                    <Link href={`/product/${product.slug}`} target="_blank">
                        <ExternalLink className="w-4 h-4 mr-2" />
                        View
                    </Link>
                 </Button>
             )}
        </div>
      </div>

       <ProductForm 
         initialData={{
            id: product.id,
            title: product.title,
            slug: product.slug,
            sku: product.sku,
            upc: product.upc ?? undefined,
            stock: product.stock || 0,
            price: product.price || 0,
            prices: Object.entries(product.prices || {}).reduce<Record<string, number>>(
              (accumulator, [currencyCode, amount]) => {
                accumulator[currencyCode] = minorUnitAmountToMajor(amount as number, currencyCode);
                return accumulator;
              },
              {}
            ),
            is_taxable:
              typeof product.is_taxable === 'boolean' ? product.is_taxable : true,
            product_type: product.product_type,
            payment_provider: product.payment_provider,
            status: product.status as 'draft' | 'active' | 'archived',
            short_description: product.short_description ?? undefined,
            description_json: product.description_json,
            sale_price: typeof product.sale_price === 'number' ? product.sale_price : undefined,
            sale_prices: Object.entries(product.sale_prices || {}).reduce<
              Record<string, number | null>
            >((accumulator, [currencyCode, amount]) => {
              accumulator[currencyCode] =
                typeof amount === 'number'
                  ? minorUnitAmountToMajor(amount, currencyCode)
                  : null;
              return accumulator;
            }, {}),
            freemius_plan_id: product.freemius_plan_id ?? undefined,
            freemius_product_id: product.freemius_product_id ?? undefined,
            trial_period_days: product.trial_period_days ?? 0,
            trial_requires_payment_method: product.trial_requires_payment_method ?? false,
            language_id: product.language_id,
            translation_group_id: product.translation_group_id,
            product_media: product.product_media,
            variation_attributes: productAttributes.map((attribute) => ({
              attribute_id: attribute.id,
              term_ids: attribute.terms.map((term) => term.id),
            })),
            variants: variants.map((variant) => ({
              ...variant,
              upc: variant.upc ?? null,
              price: variant.price / 100,
              prices: Object.entries(variant.prices || {}).reduce<Record<string, number>>(
                (accumulator, [currencyCode, amount]) => {
                  accumulator[currencyCode] = minorUnitAmountToMajor(amount, currencyCode);
                  return accumulator;
                },
                {}
              ),
              sale_price:
                typeof variant.sale_price === 'number' ? variant.sale_price / 100 : null,
              sale_prices: Object.entries(variant.sale_prices || {}).reduce<
                Record<string, number | null>
              >((accumulator, [currencyCode, amount]) => {
                accumulator[currencyCode] =
                  typeof amount === 'number'
                    ? minorUnitAmountToMajor(amount, currencyCode)
                    : null;
                return accumulator;
              }, {}),
              main_media_id: variant.main_media_id ?? null,
              main_image_url: variant.image_url ?? null,
            })),
         }} 
        isEdit 
        mediaPickerNode={mediaPickerNode}
        availableLanguagesProp={availableLanguagesProp}
        globalAttributesProp={globalAttributes}
        currenciesProp={currencies}
        enabledProviders={enabledProviders}
        configStatus={configStatus}
        updateAction={updateProductAction.bind(null, product.id)}
        freemiusDashboardNode={
          isDigitalProduct &&
          product.freemius_product_id &&
          pricingPlans &&
          FreemiusPricingDashboardComponent ? (
            <FreemiusPricingDashboardComponent 
              productId={product.id} 
              freemiusProductId={product.freemius_product_id}
              plans={pricingPlans}
            />
          ) : undefined
        }
      />
    </div>
  );
}
