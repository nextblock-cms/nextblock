import 'server-only';

import { ProductsPage as ProductsPageUI } from '@nextblock-cms/ecommerce/server';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

import { getActiveLanguagesServerSide, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import LanguageFilterSelect from '../components/LanguageFilterSelect';
import { ContentTransferControls } from '../import-export/ContentTransferControls';

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
      redirect('/cms/settings/packages');
  }

  const resolvedSearchParams = await searchParams;
  const allLanguages = await getActiveLanguagesServerSide();
  const selectedLangId = resolvedSearchParams?.lang ? parseInt(resolvedSearchParams.lang, 10) : undefined;
  const isValidLangId = selectedLangId
    ? allLanguages.some((language) => language.id === selectedLangId)
    : true;
  const filterLangId = isValidLangId ? selectedLangId : undefined;

  // Cheap existence check so the Export button can disable when there is nothing
  // to export. Filtered by language to match what the export action produces.
  const supabase = getServiceRoleSupabaseClient();
  let productCountQuery = supabase
    .from('products')
    .select('id', { count: 'exact', head: true });
  if (filterLangId) {
    productCountQuery = productCountQuery.eq('language_id', filterLangId);
  }
  const { count: productCount } = await productCountQuery;

  return (
    <ProductsPageUI
      searchParams={resolvedSearchParams}
      transferControlsNode={
        <ContentTransferControls
          contentType="products"
          label="Products"
          languageId={filterLangId}
          hasContent={(productCount ?? 0) > 0}
        />
      }
      languageFilterNode={
        <LanguageFilterSelect 
          allLanguages={allLanguages}
          currentFilterLangId={filterLangId}
          basePath="/cms/products"
        />
      }
    />
  );
}
