'use client';

import { useLabel } from '../../../lib/i18n/use-label';

const PHRASES = {
  by: { key: 'photo_credit.by', en: 'Photo by', fr: 'Photo de' },
  on: { key: 'photo_credit.on', en: 'on', fr: 'sur' },
  anonymous: { key: 'photo_credit.anonymous', en: 'a photographer', fr: 'un photographe' },
} as const;

/**
 * The translatable words of a stock-photo credit. `StockPhotoCredit` itself stays a server
 * component (it also exports pure helpers that server renderers call), so the three words
 * that need the visitor's language live in this small client component.
 */
export function StockPhotoCreditPhrase({ part }: { part: keyof typeof PHRASES }) {
  const label = useLabel();
  const phrase = PHRASES[part];

  return <>{label(phrase.key, phrase.en, phrase.fr)}</>;
}
