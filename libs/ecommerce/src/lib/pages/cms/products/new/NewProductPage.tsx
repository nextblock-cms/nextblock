import 'server-only';

import { ProductForm } from '../components/ProductForm';
import { getGlobalProductAttributes } from '../actions';
import { mapRawVariantRelations } from '../../../../variation-utils';
import { createProductAction } from '../server-actions';
import {
  getEnabledPaymentProviders,
  getStoreConfigStatus,
} from '../../payments/queries';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { minorUnitAmountToMajor } from '@nextblock-cms/utils';
import { normalizeCurrencyRecord } from '../../../../currency';

interface NewProductPageProps {
  mediaPickerNode?: React.ReactNode;
  availableLanguagesProp: any[];
  translationGroupId?: string;
  targetLanguageId?: string;
  initialData?: any;
}

export async function NewProductPage({ 
  mediaPickerNode, 
  availableLanguagesProp,
  translationGroupId,
  targetLanguageId,
  initialData
}: NewProductPageProps) {
  const [enabledProviders, configStatus, globalAttributesRaw, currenciesResult] =
    await Promise.all([
      getEnabledPaymentProviders(),
      getStoreConfigStatus(),
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
  const initialLanguageCode =
    availableLanguagesProp.find((lang) => lang.id === initialData?.language_id)?.code ||
    availableLanguagesProp.find((lang) => lang.id === (targetLanguageId ? parseInt(targetLanguageId, 10) : undefined))?.code ||
    availableLanguagesProp.find((lang) => lang.is_default)?.code;
  const { attributes: productAttributes, variants } = mapRawVariantRelations(
    initialData?.product_variants || [],
    initialLanguageCode
  );
  const normalizedInitialData = initialData
    ? {
        ...initialData,
        variation_attributes:
          initialData.variation_attributes ||
          productAttributes.map((attribute) => ({
            attribute_id: attribute.id,
            term_ids: attribute.terms.map((term) => term.id),
          })),
        variants:
          initialData.variants ||
          variants.map((variant) => ({
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
      }
    : initialData;

  return (
    <div className="p-8">
      <ProductForm 
         mediaPickerNode={mediaPickerNode} 
         availableLanguagesProp={availableLanguagesProp}
         globalAttributesProp={globalAttributes}
         currenciesProp={currencies}
         translationGroupId={translationGroupId}
         targetLanguageId={targetLanguageId}
         initialData={normalizedInitialData}
         enabledProviders={enabledProviders}
         configStatus={configStatus}
         createAction={createProductAction}
      />
    </div>
  );
}

