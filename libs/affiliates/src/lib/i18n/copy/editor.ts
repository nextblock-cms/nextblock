import type { AffiliatesCopyDictionary } from '../types';

/**
 * Keys: `affiliates.editor.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file).
 * The storefront editor (`@nextblock-cms/affiliates/editor`): toolbar, slash menu, placeholders,
 * link and image dialogs, the product grid block and the product picker.
 */
export const AFFILIATES_EDITOR_COPY = {
  // Editor frame
  'affiliates.editor.region_label': { en: 'Storefront editor', fr: 'Éditeur de vitrine' },
  'affiliates.editor.content_label': { en: 'Storefront content', fr: 'Contenu de la vitrine' },
  'affiliates.editor.loading': { en: 'Loading the editor…', fr: "Chargement de l'éditeur…" },
  'affiliates.editor.content_error': {
    en: "Your saved storefront couldn't be opened in the editor, so editing is turned off to keep your draft safe. Reload the page, and contact us if this keeps happening.",
    fr: "Votre vitrine enregistrée n'a pas pu s'ouvrir dans l'éditeur. La modification est désactivée pour protéger votre brouillon. Rechargez la page et communiquez avec nous si le problème persiste.",
  },
  'affiliates.editor.insert_failed': {
    en: "That block couldn't be added. Try again.",
    fr: "Ce bloc n'a pas pu être ajouté. Réessayez.",
  },
  'affiliates.editor.cancel': { en: 'Cancel', fr: 'Annuler' },
  'affiliates.editor.save': { en: 'Save', fr: 'Enregistrer' },
  'affiliates.editor.skip': { en: 'Skip', fr: 'Passer' },

  // Toolbar
  'affiliates.editor.toolbar_label': { en: 'Text formatting', fr: 'Mise en forme du texte' },
  'affiliates.editor.bold': { en: 'Bold', fr: 'Gras' },
  'affiliates.editor.italic': { en: 'Italic', fr: 'Italique' },
  'affiliates.editor.underline': { en: 'Underline', fr: 'Souligné' },
  'affiliates.editor.strike': { en: 'Strikethrough', fr: 'Barré' },
  'affiliates.editor.link': { en: 'Link', fr: 'Lien' },
  'affiliates.editor.heading_2': { en: 'Heading 2', fr: 'Titre 2' },
  'affiliates.editor.heading_3': { en: 'Heading 3', fr: 'Titre 3' },
  'affiliates.editor.bullet_list': { en: 'Bulleted list', fr: 'Liste à puces' },
  'affiliates.editor.ordered_list': { en: 'Numbered list', fr: 'Liste numérotée' },
  'affiliates.editor.quote': { en: 'Quote', fr: 'Citation' },
  'affiliates.editor.callout': { en: 'Callout', fr: 'Encadré' },
  'affiliates.editor.callout_style': { en: 'Callout style', fr: "Style de l'encadré" },
  'affiliates.editor.callout_tone_info': { en: 'Info', fr: 'Information' },
  'affiliates.editor.callout_tone_tip': { en: 'Tip', fr: 'Astuce' },
  'affiliates.editor.callout_tone_highlight': { en: 'Highlight', fr: 'Mise en valeur' },
  'affiliates.editor.divider': { en: 'Divider', fr: 'Séparateur' },
  'affiliates.editor.add_products': { en: 'Add products', fr: 'Ajouter des produits' },
  'affiliates.editor.add_image': { en: 'Add an image', fr: 'Ajouter une image' },
  'affiliates.editor.image_description': { en: 'Image description', fr: "Description de l'image" },
  'affiliates.editor.undo': { en: 'Undo', fr: 'Annuler' },
  'affiliates.editor.redo': { en: 'Redo', fr: 'Rétablir' },

  // Placeholders
  'affiliates.editor.placeholder': {
    en: 'Write your story, or type / to add a block…',
    fr: 'Racontez votre histoire, ou tapez / pour ajouter un bloc…',
  },
  'affiliates.editor.placeholder_heading': { en: 'Heading', fr: 'Titre' },
  'affiliates.editor.placeholder_callout': {
    en: 'Write a tip or a highlight…',
    fr: 'Écrivez une astuce ou un point fort…',
  },

  // Slash menu (type / in an empty line or after a space)
  'affiliates.editor.slash_menu_label': { en: 'Blocks', fr: 'Blocs' },
  'affiliates.editor.slash_no_results': { en: 'No matching blocks', fr: 'Aucun bloc correspondant' },
  'affiliates.editor.slash_active_option': { en: '{title}, {position} of {count}', fr: '{title}, {position} sur {count}' },
  'affiliates.editor.slash_heading_2_description': { en: 'Large section heading', fr: 'Grand titre de section' },
  'affiliates.editor.slash_heading_3_description': { en: 'Smaller subsection heading', fr: 'Titre de sous-section' },
  'affiliates.editor.slash_bullet_list_description': { en: 'A simple bulleted list', fr: 'Une liste à puces simple' },
  'affiliates.editor.slash_ordered_list_description': { en: 'A list with numbers', fr: 'Une liste avec des numéros' },
  'affiliates.editor.slash_quote_description': {
    en: 'Highlight a quote or a testimonial',
    fr: 'Mettez en valeur une citation ou un témoignage',
  },
  'affiliates.editor.slash_divider_description': {
    en: 'A visual break between sections',
    fr: 'Une séparation visuelle entre les sections',
  },
  'affiliates.editor.slash_callout_description': {
    en: 'A tip, note or highlight box',
    fr: 'Un encadré pour une astuce, une note ou un point fort',
  },
  'affiliates.editor.slash_image_title': { en: 'Image', fr: 'Image' },
  'affiliates.editor.slash_image_description': { en: 'Upload a photo', fr: 'Téléversez une photo' },
  'affiliates.editor.slash_products_title': { en: 'Promote products', fr: 'Promouvoir des produits' },
  'affiliates.editor.slash_products_description': {
    en: 'Showcase products from the store',
    fr: 'Présentez des produits de la boutique',
  },

  // Link dialog
  'affiliates.editor.link_dialog_title_add': { en: 'Add a link', fr: 'Ajouter un lien' },
  'affiliates.editor.link_dialog_title_edit': { en: 'Edit link', fr: 'Modifier le lien' },
  'affiliates.editor.link_dialog_description': {
    en: 'Link to a web page, an email address or a page of this site.',
    fr: 'Liez une page Web, une adresse courriel ou une page de ce site.',
  },
  'affiliates.editor.link_url_label': { en: 'Link address', fr: 'Adresse du lien' },
  'affiliates.editor.link_url_placeholder': { en: 'https://example.com', fr: 'https://exemple.com' },
  'affiliates.editor.link_url_hint': {
    en: 'Examples: https://example.com, mailto:name@example.com or /products/candle',
    fr: 'Exemples : https://exemple.com, mailto:nom@exemple.com ou /produits/chandelle',
  },
  'affiliates.editor.link_apply': { en: 'Apply', fr: 'Appliquer' },
  'affiliates.editor.link_remove': { en: 'Remove link', fr: 'Retirer le lien' },
  'affiliates.editor.link_error_empty': { en: 'Enter a link address.', fr: "Entrez l'adresse du lien." },
  'affiliates.editor.link_error_invalid': {
    en: 'Use a web address (https://…), an email address (mailto:…) or a page path that starts with /.',
    fr: 'Utilisez une adresse Web (https://…), une adresse courriel (mailto:…) ou un chemin de page qui commence par /.',
  },

  // Images
  'affiliates.editor.image_file_label': { en: 'Choose an image to upload', fr: 'Choisissez une image à téléverser' },
  'affiliates.editor.image_uploading': { en: 'Uploading the image…', fr: "Téléversement de l'image…" },
  'affiliates.editor.image_uploaded': { en: 'Image added', fr: 'Image ajoutée' },
  'affiliates.editor.image_upload_failed': {
    en: "The image couldn't be uploaded. Try another file.",
    fr: "L'image n'a pas pu être téléversée. Essayez un autre fichier.",
  },
  'affiliates.editor.image_type_invalid': {
    en: 'Choose a JPEG, PNG, WebP or GIF image.',
    fr: 'Choisissez une image JPEG, PNG, WebP ou GIF.',
  },
  'affiliates.editor.image_not_allowed': {
    en: "This image can't be used on your storefront.",
    fr: 'Cette image ne peut pas être utilisée dans votre vitrine.',
  },
  'affiliates.editor.image_alt_dialog_title': { en: 'Describe this image', fr: 'Décrivez cette image' },
  'affiliates.editor.image_alt_dialog_description': {
    en: 'A short description helps visitors who use screen readers, and helps search engines understand your page.',
    fr: "Une courte description aide les personnes qui utilisent un lecteur d'écran ainsi que les moteurs de recherche à comprendre votre page.",
  },
  'affiliates.editor.image_alt_placeholder': {
    en: 'Example: Hand-poured soy candle on a wooden table',
    fr: 'Exemple : chandelle de soya coulée à la main sur une table en bois',
  },

  // Product grid block
  'affiliates.editor.grid_label': { en: 'Product grid', fr: 'Grille de produits' },
  'affiliates.editor.grid_count': { en: '{count} of {max} products', fr: '{count} sur {max} produits' },
  'affiliates.editor.grid_empty': {
    en: 'No products yet. Choose up to {max} products from the store.',
    fr: "Aucun produit pour l'instant. Choisissez jusqu'à {max} produits de la boutique.",
  },
  'affiliates.editor.grid_title_label': { en: 'Grid title (optional)', fr: 'Titre de la grille (facultatif)' },
  'affiliates.editor.grid_title_placeholder': { en: 'My favorite products', fr: 'Mes produits préférés' },
  'affiliates.editor.grid_columns_label': { en: 'Columns', fr: 'Colonnes' },
  'affiliates.editor.grid_columns_option': { en: '{count} columns', fr: '{count} colonnes' },
  'affiliates.editor.grid_choose_products': { en: 'Choose products', fr: 'Choisir des produits' },
  'affiliates.editor.grid_edit_products': { en: 'Edit products', fr: 'Modifier les produits' },
  'affiliates.editor.grid_remove': { en: 'Remove grid', fr: 'Retirer la grille' },
  'affiliates.editor.grid_drag_handle': { en: 'Drag to move the grid', fr: 'Glissez pour déplacer la grille' },
  'affiliates.editor.remove_product': { en: 'Remove {name}', fr: 'Retirer {name}' },
  'affiliates.editor.product_fallback': { en: 'Product', fr: 'Produit' },
  'affiliates.editor.product_unavailable': { en: 'Unavailable product', fr: 'Produit non disponible' },
  'affiliates.editor.product_loading': { en: 'Loading product…', fr: 'Chargement du produit…' },

  // Product picker
  'affiliates.editor.picker_title': { en: 'Choose products', fr: 'Choisir des produits' },
  'affiliates.editor.picker_description': {
    en: 'Select up to {max} products. They appear in the order you pick them.',
    fr: "Sélectionnez jusqu'à {max} produits. Ils s'affichent dans l'ordre où vous les choisissez.",
  },
  'affiliates.editor.picker_search_label': { en: 'Search the store', fr: 'Rechercher dans la boutique' },
  'affiliates.editor.picker_search_placeholder': {
    en: 'Search by product name…',
    fr: 'Recherchez par nom de produit…',
  },
  'affiliates.editor.picker_searching': { en: 'Searching…', fr: 'Recherche en cours…' },
  'affiliates.editor.picker_results_label': { en: 'Products', fr: 'Produits' },
  'affiliates.editor.picker_result_count_one': { en: '1 product found', fr: '1 produit trouvé' },
  'affiliates.editor.picker_result_count_other': { en: '{count} products found', fr: '{count} produits trouvés' },
  'affiliates.editor.picker_no_results': {
    en: 'No products match your search.',
    fr: 'Aucun produit ne correspond à votre recherche.',
  },
  'affiliates.editor.picker_error': {
    en: "Products couldn't be loaded. Try again.",
    fr: "Les produits n'ont pas pu être chargés. Réessayez.",
  },
  'affiliates.editor.picker_retry': { en: 'Try again', fr: 'Réessayer' },
  'affiliates.editor.picker_selected_label': { en: 'Selected ({count}/{max})', fr: 'Sélection ({count}/{max})' },
  'affiliates.editor.picker_selected_empty': {
    en: 'No products selected yet.',
    fr: "Aucun produit sélectionné pour l'instant.",
  },
  'affiliates.editor.picker_limit_reached': {
    en: "You've reached the limit of {max} products for this grid.",
    fr: 'Vous avez atteint la limite de {max} produits pour cette grille.',
  },
  'affiliates.editor.picker_page_limit_reached': {
    en: 'Your page can feature up to {max} different products.',
    fr: "Votre page peut présenter jusqu'à {max} produits différents.",
  },
  'affiliates.editor.picker_move_up': { en: 'Move {name} up', fr: 'Monter {name}' },
  'affiliates.editor.picker_move_down': { en: 'Move {name} down', fr: 'Descendre {name}' },
  'affiliates.editor.picker_confirm': { en: 'Save selection', fr: 'Enregistrer la sélection' },
} as const satisfies AffiliatesCopyDictionary;

/** A key of the editor dictionary. */
export type AffiliatesEditorCopyKey = keyof typeof AFFILIATES_EDITOR_COPY;
