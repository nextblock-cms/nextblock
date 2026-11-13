// components/LanguageSwitcher.tsx
'use client';

import { useLanguage } from '../context/LanguageContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@nextblock-cms/ui';
import { useRouter, usePathname } from 'next/navigation';
import { getContentTranslations, getContentMetadataBySlugAndLocale } from '../app/actions/languageActions';
import { Language } from '../app/actions/languageActions';
import { useCurrentContent } from '../context/CurrentContentContext';
import { useLabel } from '../lib/i18n/use-label';
import { contentLookupForPath, resolveLocalePathTarget } from './language-switcher-path';

interface CurrentPageInfo {
  slug: string;
  translation_group_id: string | null;
}

interface LanguageSwitcherProps {
  currentPageData?: CurrentPageInfo;
}

export default function LanguageSwitcher({ currentPageData }: LanguageSwitcherProps) {
  const { currentContent } = useCurrentContent();
  const { currentLocale, setCurrentLocale, availableLanguages, isLoadingLanguages } = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const label = useLabel();

  if (isLoadingLanguages || availableLanguages.length <= 1) {
    return null;
  }

  const handleValueChange = async (newLocaleCode: string) => {
    await setCurrentLocale(newLocaleCode);

    let targetPath = pathname; // Default to current path

    // Determine if it's a homepage (e.g., /en, /fr, or just /)
    const isHomePage = pathname === '/' || availableLanguages.some(lang => pathname === `/${lang.code}`);

    if (isHomePage) {
      targetPath = '/'; // For any homepage, new language path is root
    } else if (currentContent.localePaths) {
      // A code route that declared its own address per language (the partner program's
      // /partners and /partenaires): go there, or refresh in place when it has none for this language.
      targetPath = resolveLocalePathTarget(currentContent.localePaths, newLocaleCode) ?? pathname;
    } else {
    // Only a path shaped like a CMS document (/<slug>, /article/<slug>, /product/<slug>) is looked
    // up by slug; any other route (a partner storefront, the portal, checkout) refreshes in place.
    const lookup = contentLookupForPath(pathname);

    let contentMetadata = currentContent.id ? {
      slug: currentContent.slug || '',
      translation_group_id: currentContent.translation_group_id || null,
      type: currentContent.type
    } : null;

    // Fallback to fetching if context is missing but the path addresses a CMS document
    if (!contentMetadata && lookup) {
      try {
        const fetchedMetadata = await getContentMetadataBySlugAndLocale(lookup.slug, currentLocale, lookup.type);
        if (fetchedMetadata) {
          contentMetadata = fetchedMetadata as any;
        }
      } catch (error) {
        console.error('Error fetching content metadata:', error);
      }
    }

    if (contentMetadata?.translation_group_id) {
      try {
        const typePlural = contentMetadata.type === 'product' ? 'products' : (contentMetadata.type === 'post' ? 'posts' : 'pages');
        const translations = await getContentTranslations(contentMetadata.translation_group_id, typePlural);
        const foundTranslation = translations.find(t => t.language_code === newLocaleCode);

        if (foundTranslation) {
          // Construct target path based on type
          if (contentMetadata.type === 'product') {
            targetPath = `/product/${foundTranslation.slug}`;
          } else if (contentMetadata.type === 'post') {
            targetPath = `/article/${foundTranslation.slug}`;
          } else {
            targetPath = `/${foundTranslation.slug}`;
          }
        } else {
          console.warn(`No translation found for ${contentMetadata.slug} to ${newLocaleCode}. Falling back to current path.`);
        }
      } catch (error) {
        console.error("Error fetching translations:", error);
      }
    } else if (lookup) {
      console.warn(`No translation_group_id for content: ${contentMetadata?.slug || lookup.slug}. Current path will be used.`);
    }
    }

    setTimeout(() => {
      if (pathname !== targetPath) {
        router.push(targetPath);
        // Force Next.js to re-fetch the root layout since the language cookie changed.
        // This ensures the Header/Footer navigation links update accurately.
        setTimeout(() => {
           router.refresh();
        }, 50);
      } else {
        // If path is the same, refresh to ensure content updates for the new locale
        router.refresh();
      }
    }, 50); // Adjust delay as needed
  };

  const languageLabel = label('language_switcher', 'Language', 'Langue');

  return (
    <div className="flex items-center">
      <Select value={currentLocale} onValueChange={handleValueChange}>
        <SelectTrigger className="h-9 text-xs sm:text-sm" aria-label={languageLabel}>
          <SelectValue placeholder={languageLabel} />
        </SelectTrigger>
        <SelectContent>
          {availableLanguages.map((lang: Language) => (
            // `lang` so a screen reader pronounces each language name in that language.
            <SelectItem key={lang.code} value={lang.code} lang={lang.code}>
              {lang.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
