import type { AffiliatesCopyDictionary } from '../types';

/**
 * Keys: `affiliates.copilot.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file).
 *
 * The storefront assistant panel in the partner portal (`StorefrontCopilotPanel`) and the generic
 * messages the `/api/affiliates/cortex` route streams. The `*_prompt` strings are what a quick
 * action writes into the composer for the partner to finish (the panel adds the trailing space).
 */
export const AFFILIATES_COPILOT_COPY = {
  // Panel
  'affiliates.copilot.panel_title': { en: 'Storefront assistant', fr: 'Assistant de vitrine' },
  'affiliates.copilot.panel_description': {
    en: 'Get help with your bio, new sections for your page and polished copy. Nothing changes on your page until you use a suggestion.',
    fr: "Obtenez de l'aide pour votre bio, de nouvelles sections pour votre page et des textes peaufinés. Rien ne change sur votre page tant que vous n'utilisez pas une suggestion.",
  },
  'affiliates.copilot.disclaimer': {
    en: 'Suggestions can contain mistakes. Review them before you use them.',
    fr: 'Les suggestions peuvent contenir des erreurs. Relisez-les avant de les utiliser.',
  },
  'affiliates.copilot.disabled_default': {
    en: 'The assistant is not available right now.',
    fr: "L'assistant n'est pas disponible pour le moment.",
  },
  'affiliates.copilot.new_conversation': { en: 'New conversation', fr: 'Nouvelle conversation' },

  // The visitor's own OpenRouter key (the public sandbox only; saved in that browser, never on the server)
  'affiliates.copilot.sandbox_key_label': {
    en: 'Your OpenRouter API key (demo)',
    fr: "Votre clé d'API OpenRouter (démo)",
  },
  'affiliates.copilot.sandbox_key_hint': {
    en: "It's saved only in this browser and sent only with this site's AI assistant requests.",
    fr: "Elle est enregistrée uniquement dans ce navigateur et n'est envoyée qu'avec les demandes aux assistants IA de ce site.",
  },
  'affiliates.copilot.sandbox_key_save': { en: 'Save key', fr: 'Enregistrer la clé' },
  'affiliates.copilot.sandbox_key_forget': { en: 'Remove key', fr: 'Supprimer la clé' },
  'affiliates.copilot.sandbox_key_saved': {
    en: 'Your key is saved in this browser.',
    fr: 'Votre clé est enregistrée dans ce navigateur.',
  },
  'affiliates.copilot.sandbox_key_forgotten': {
    en: 'Your key was removed from this browser.',
    fr: 'Votre clé a été supprimée de ce navigateur.',
  },
  'affiliates.copilot.sandbox_key_invalid': {
    en: "That doesn't look like an OpenRouter API key. Paste the whole key, without spaces.",
    fr: "Cette valeur ne ressemble pas à une clé d'API OpenRouter. Collez la clé complète, sans espaces.",
  },
  'affiliates.copilot.sandbox_key_storage_failed': {
    en: "This browser is blocking site storage, so your key can't be saved or removed.",
    fr: 'Ce navigateur bloque le stockage du site : votre clé ne peut être ni enregistrée ni supprimée.',
  },
  'affiliates.copilot.sandbox_key_go_to_field': { en: 'Add my key', fr: 'Ajouter ma clé' },

  // Quick actions
  'affiliates.copilot.quick_actions_label': { en: 'Quick actions', fr: 'Actions rapides' },
  'affiliates.copilot.quick_bio': { en: 'Write my bio from notes', fr: 'Rédiger ma bio à partir de notes' },
  'affiliates.copilot.quick_bio_prompt': {
    en: 'Write my bio from these notes:',
    fr: 'Rédige ma bio à partir de ces notes :',
  },
  'affiliates.copilot.quick_section': { en: 'Create a section about…', fr: 'Créer une section sur…' },
  'affiliates.copilot.quick_section_prompt': { en: 'Create a section about', fr: 'Crée une section sur' },
  'affiliates.copilot.quick_polish': { en: 'Polish the selected text', fr: 'Peaufiner le texte sélectionné' },
  'affiliates.copilot.quick_polish_prompt': {
    en: 'Polish the text I selected in my page.',
    fr: "Peaufine le texte que j'ai sélectionné dans ma page.",
  },
  'affiliates.copilot.polish_needs_selection': {
    en: 'Select the text you want to polish in your page first.',
    fr: "Sélectionnez d'abord, dans votre page, le texte à peaufiner.",
  },
  'affiliates.copilot.polish_single_block': {
    en: 'To polish text, select it within a single paragraph, heading or list item.',
    fr: 'Pour peaufiner un texte, sélectionnez-le dans un seul paragraphe, titre ou élément de liste.',
  },

  // Conversation
  'affiliates.copilot.messages_label': { en: 'Conversation with the assistant', fr: "Conversation avec l'assistant" },
  'affiliates.copilot.empty_state': {
    en: 'Ask for a bio, a section about your favorite products or a rewrite of the text you selected.',
    fr: 'Demandez une bio, une section sur vos produits préférés ou une réécriture du texte sélectionné.',
  },
  'affiliates.copilot.speaker_you': { en: 'You', fr: 'Vous' },
  'affiliates.copilot.speaker_assistant': { en: 'Assistant', fr: 'Assistant' },
  'affiliates.copilot.working': { en: 'Working on it…', fr: 'Préparation en cours…' },
  'affiliates.copilot.running_bio': { en: 'Writing your bio…', fr: 'Rédaction de votre bio…' },
  'affiliates.copilot.running_section': { en: 'Building your section…', fr: 'Création de votre section…' },
  'affiliates.copilot.running_rewrite': { en: 'Polishing your text…', fr: 'Peaufinage de votre texte…' },
  'affiliates.copilot.stopped': { en: 'Stopped.', fr: 'Arrêté.' },

  // Composer
  'affiliates.copilot.input_label': { en: 'Message to the assistant', fr: "Message à l'assistant" },
  'affiliates.copilot.input_placeholder': {
    en: 'Ask for a bio, a section or a rewrite…',
    fr: 'Demandez une bio, une section ou une réécriture…',
  },
  'affiliates.copilot.input_hint': {
    en: 'Press Enter to send and Shift+Enter for a new line.',
    fr: 'Appuyez sur Entrée pour envoyer et sur Maj+Entrée pour aller à la ligne.',
  },
  'affiliates.copilot.send': { en: 'Send', fr: 'Envoyer' },
  'affiliates.copilot.stop': { en: 'Stop', fr: 'Arrêter' },

  // Bio suggestion
  'affiliates.copilot.bio_title': { en: 'Suggested bio', fr: 'Bio suggérée' },
  'affiliates.copilot.bio_meta_label': {
    en: 'Description for search engines',
    fr: 'Description pour les moteurs de recherche',
  },
  'affiliates.copilot.apply_bio': { en: 'Apply to my profile', fr: 'Appliquer à mon profil' },
  'affiliates.copilot.bio_applied': { en: 'Applied to your profile', fr: 'Appliquée à votre profil' },

  // Section suggestion
  'affiliates.copilot.section_title': { en: 'Suggested section', fr: 'Section suggérée' },
  'affiliates.copilot.section_preview_label': { en: 'Section preview', fr: 'Aperçu de la section' },
  'affiliates.copilot.insert_section': { en: 'Insert into my page', fr: 'Insérer dans ma page' },
  'affiliates.copilot.section_inserted': { en: 'Inserted into your page', fr: 'Insérée dans votre page' },
  'affiliates.copilot.section_skipped': {
    en: 'Some products or photos could not be used and were left out.',
    fr: "Certains produits ou certaines photos n'ont pas pu être utilisés et ont été retirés.",
  },
  'affiliates.copilot.section_products_one': { en: '1 store product', fr: '1 produit de la boutique' },
  'affiliates.copilot.section_products_other': { en: '{count} store products', fr: '{count} produits de la boutique' },
  'affiliates.copilot.photo_credit': { en: 'Photo: {photographer} / {provider}', fr: 'Photo : {photographer} / {provider}' },
  'affiliates.copilot.insert_failed': {
    en: 'The section could not be inserted. Please try again.',
    fr: "La section n'a pas pu être insérée. Veuillez réessayer.",
  },

  // Rewrite suggestion
  'affiliates.copilot.rewrite_title': { en: 'Suggested rewrite', fr: 'Réécriture suggérée' },
  'affiliates.copilot.replace_selection': { en: 'Replace selection', fr: 'Remplacer la sélection' },
  'affiliates.copilot.selection_replaced': { en: 'Selection replaced', fr: 'Sélection remplacée' },
  'affiliates.copilot.replace_needs_selection': {
    en: 'Select the text to replace in your page first.',
    fr: "Sélectionnez d'abord, dans votre page, le texte à remplacer.",
  },
  'affiliates.copilot.replace_single_block': {
    en: 'To replace text, select it within a single paragraph, heading or list item. Nothing was changed.',
    fr: "Pour remplacer un texte, sélectionnez-le dans un seul paragraphe, titre ou élément de liste. Rien n'a été modifié.",
  },
  'affiliates.copilot.editor_not_ready': {
    en: 'Your page editor is not ready yet. Try again in a moment.',
    fr: "L'éditeur de votre page n'est pas encore prêt. Réessayez dans un instant.",
  },

  // Errors (tool results keyed by their `error` code, HTTP statuses, stream failures)
  'affiliates.copilot.error_invalid_input': {
    en: 'The suggestion was incomplete. Ask again, or add a few more details.',
    fr: 'La suggestion était incomplète. Redemandez-la, ou ajoutez quelques détails.',
  },
  'affiliates.copilot.error_empty_output': {
    en: 'The suggestion came back empty. Try asking again with more details.',
    fr: 'La suggestion est revenue vide. Redemandez-la avec plus de détails.',
  },
  'affiliates.copilot.error_empty_section': {
    en: 'Nothing usable came back for this section. Add details or name products from the store.',
    fr: "Rien d'utilisable n'est revenu pour cette section. Ajoutez des détails ou nommez des produits de la boutique.",
  },
  'affiliates.copilot.error_section_limit': {
    en: 'This message reached its limit of new sections. Ask again for the next ones.',
    fr: 'Ce message a atteint sa limite de nouvelles sections. Redemandez pour obtenir les suivantes.',
  },
  'affiliates.copilot.error_tool': {
    en: 'That suggestion could not be prepared. Please try again.',
    fr: "Cette suggestion n'a pas pu être préparée. Veuillez réessayer.",
  },
  'affiliates.copilot.error_generic': {
    en: 'The assistant ran into a problem. Please try again.',
    fr: "L'assistant a rencontré un problème. Veuillez réessayer.",
  },
  'affiliates.copilot.error_timeout': {
    en: 'The assistant took too long to answer. Please try again.',
    fr: "L'assistant a mis trop de temps à répondre. Veuillez réessayer.",
  },
  'affiliates.copilot.error_network': {
    en: 'The assistant could not be reached. Check your connection and try again.',
    fr: "Impossible de joindre l'assistant. Vérifiez votre connexion et réessayez.",
  },
  'affiliates.copilot.error_forbidden': {
    en: 'The assistant is not available for your account right now.',
    fr: "L'assistant n'est pas disponible pour votre compte en ce moment.",
  },
  'affiliates.copilot.error_rate_limited': {
    en: "You've reached the assistant's limit for now. Try again in about {minutes} min.",
    fr: "Vous avez atteint la limite de l'assistant pour le moment. Réessayez dans environ {minutes} min.",
  },
  'affiliates.copilot.error_rate_limited_later': {
    en: "You've reached the assistant's limit for now. Please try again later.",
    fr: "Vous avez atteint la limite de l'assistant pour le moment. Veuillez réessayer plus tard.",
  },
  'affiliates.copilot.error_unavailable': {
    en: 'The assistant is unavailable right now. Please try again later.',
    fr: "L'assistant est indisponible pour le moment. Veuillez réessayer plus tard.",
  },
  'affiliates.copilot.error_unavailable_sandbox': {
    en: 'The assistant is unavailable in this demo right now. Add your own OpenRouter API key in the field above, then try again.',
    fr: "L'assistant est indisponible dans cette démo pour le moment. Ajoutez votre propre clé d'API OpenRouter dans le champ ci-dessus, puis réessayez.",
  },
  'affiliates.copilot.error_invalid_request': {
    en: 'That message could not be sent. Shorten it and try again.',
    fr: "Ce message n'a pas pu être envoyé. Raccourcissez-le et réessayez.",
  },
} as const satisfies AffiliatesCopyDictionary;

/** A key of the copilot dictionary. */
export type AffiliatesCopilotCopyKey = keyof typeof AFFILIATES_COPILOT_COPY;
