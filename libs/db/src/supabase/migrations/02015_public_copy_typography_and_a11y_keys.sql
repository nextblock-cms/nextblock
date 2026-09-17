-- Public UI copy: typography, French accents, and the keys the accessibility pass needs.
--
-- Data only, and safe to re-run (verified: a second run changes nothing).
--   1. French corrections match the EXACT seeded text, so edited copy is left alone.
--   2. The ellipsis pass changes a trailing three dots into one ellipsis character and
--      nothing else, in edited copy too.
--   3. New keys use ON CONFLICT DO NOTHING.

-- 1. French strings seeded without their accents ("Selectionnez", "Parametres", "a l'accueil").
--    43 rows. Runs first, against the original text, so receipt_finalizing gets its accent
--    and its ellipsis in one step.
UPDATE public.translations AS t
SET translations = jsonb_set(t.translations, '{fr}', to_jsonb(fix.new_fr)),
    updated_at = now()
FROM (
  VALUES
    ('ecommerce.variant_availability_help', 'Selectionnez une combinaison pour afficher le prix exact et la disponibilite de la variante.', 'Sélectionnez une combinaison pour afficher le prix exact et la disponibilité de la variante.'),
    ('ecommerce.variant_selection_required', 'Selectionnez une valeur dans chaque liste pour afficher la variante correspondante.', 'Sélectionnez une valeur dans chaque liste pour afficher la variante correspondante.'),
    ('bill_to', 'Facturer a', 'Facturer à'),
    ('ship_to', 'Livrer a', 'Livrer à'),
    ('invoice_settings', 'Parametres de facture', 'Paramètres de facture'),
    ('print_invoice_help', 'Utilisez la boite de dialogue d''impression de votre navigateur pour enregistrer cette facture en PDF.', 'Utilisez la boîte de dialogue d''impression de votre navigateur pour enregistrer cette facture en PDF.'),
    ('return_home', 'Retour a l''accueil', 'Retour à l''accueil'),
    ('receipt_finalizing', 'Finalisation de votre facture et des details du paiement...', 'Finalisation de votre facture et des détails du paiement…'),
    ('receipt_not_ready', 'Votre facture apparaitra ici une fois la synchronisation du paiement terminee.', 'Votre facture apparaîtra ici une fois la synchronisation du paiement terminée.'),
    ('tax_breakdown', 'Detail des taxes', 'Détail des taxes'),
    ('paid_on', 'Paye le', 'Payé le'),
    ('ecommerce.checkout_trial_started', 'Essai demarre', 'Essai démarré'),
    ('select_an_option', 'Selectionnez une option', 'Sélectionnez une option'),
    ('ecommerce.shipping_method_required', 'Veuillez selectionner un mode de livraison avant de continuer.', 'Veuillez sélectionner un mode de livraison avant de continuer.'),
    ('ecommerce.waiting_on_address_info', 'Completez votre adresse de livraison pour voir les options de livraison disponibles.', 'Complétez votre adresse de livraison pour voir les options de livraison disponibles.'),
    ('ecommerce.sandbox_checkout_stripe_description', 'Cette etape simulee represente le paiement Stripe pour les produits physiques.', 'Cette étape simulée représente le paiement Stripe pour les produits physiques.'),
    ('ecommerce.sandbox_checkout_freemius_description', 'Cette etape simulee represente le paiement Freemius pour les produits numeriques.', 'Cette étape simulée représente le paiement Freemius pour les produits numériques.'),
    ('ecommerce.digital_label', 'Numerique', 'Numérique'),
    ('ecommerce.digital_products', 'Produits numeriques', 'Produits numériques'),
    ('ecommerce.estimated_total', 'Total estime', 'Total estimé'),
    ('ecommerce.shipping_taxes_collected_on_stripe', 'La livraison et les taxes sont percues uniquement a l''etape Stripe pour les produits physiques.', 'La livraison et les taxes sont perçues uniquement à l''étape Stripe pour les produits physiques.'),
    ('ecommerce.freemius_checkout_description', 'Les produits numeriques utilisent le flux de paiement Freemius.', 'Les produits numériques utilisent le flux de paiement Freemius.'),
    ('ecommerce.checkout_billing_cycle_lifetime', 'Abonnement a vie', 'Abonnement à vie'),
    ('ecommerce.checkout_digital_product', 'Payer le produit numerique', 'Payer le produit numérique'),
    ('ecommerce.digital_subtotal', 'Sous-total numerique', 'Sous-total numérique'),
    ('ecommerce.freemius_multi_checkout_notice', 'Les licences Freemius se finalisent une a la fois, donc chaque produit numerique a sa propre action de paiement.', 'Les licences Freemius se finalisent une à la fois, donc chaque produit numérique a sa propre action de paiement.'),
    ('ecommerce.freemius_tax_notice', 'Les taxes et la conformite pour les produits numeriques sont gerees dans le paiement Freemius.', 'Les taxes et la conformité pour les produits numériques sont gérées dans le paiement Freemius.'),
    ('checkout_success_sync_failed', 'Nous n''avons pas encore pu finaliser votre facture. Veuillez rafraichir la page sous peu.', 'Nous n''avons pas encore pu finaliser votre facture. Veuillez rafraîchir la page sous peu.'),
    ('ecommerce.shipping_calculation_failed', 'Nous n''avons pas pu calculer la livraison pour le moment. Veuillez reessayer.', 'Nous n''avons pas pu calculer la livraison pour le moment. Veuillez réessayer.'),
    ('ecommerce.checkout_invalid_items', 'Les articles de votre commande n''ont pas pu etre traites.', 'Les articles de votre commande n''ont pas pu être traités.'),
    ('ecommerce.checkout_provider_items_required', 'Chaque etape de paiement doit inclure des articles associes a un fournisseur de paiement.', 'Chaque étape de paiement doit inclure des articles associés à un fournisseur de paiement.'),
    ('ecommerce.checkout_mixed_provider_steps', 'Les produits utilisant differents fournisseurs de paiement doivent etre achetes en etapes separees.', 'Les produits utilisant différents fournisseurs de paiement doivent être achetés en étapes séparées.'),
    ('ecommerce.checkout_freemius_single_item', 'Les produits Freemius doivent etre achetes un a la fois.', 'Les produits Freemius doivent être achetés un à la fois.'),
    ('ecommerce.checkout_internal_server_error', 'Une erreur s''est produite lors de la preparation de votre paiement. Veuillez reessayer.', 'Une erreur s''est produite lors de la préparation de votre paiement. Veuillez réessayer.'),
    ('ecommerce.checkout_missing_session_id', 'Nous n''avons pas trouve de session de paiement a finaliser.', 'Nous n''avons pas trouvé de session de paiement à finaliser.'),
    ('ecommerce.checkout_success_order_not_found', 'Nous n''avons pas trouve la commande liee a ce paiement.', 'Nous n''avons pas trouvé la commande liée à ce paiement.'),
    ('ecommerce.checkout_success_invalid_reference', 'Cette reference de paiement ne peut pas etre finalisee depuis cette page.', 'Cette référence de paiement ne peut pas être finalisée depuis cette page.'),
    ('ecommerce.checkout_success_inventory_update_failed', 'Nous n''avons pas pu mettre a jour l''inventaire pour cette commande.', 'Nous n''avons pas pu mettre à jour l''inventaire pour cette commande.'),
    ('ecommerce.checkout_success_status_update_failed', 'Nous n''avons pas pu mettre a jour le statut de la commande.', 'Nous n''avons pas pu mettre à jour le statut de la commande.'),
    ('global_search.description', 'Rechercher dans les pages, articles et produits publies.', 'Rechercher dans les pages, articles et produits publiés.'),
    ('global_search.recent', 'Recents', 'Récents'),
    ('global_search.error_description', 'Veuillez reessayer dans un instant.', 'Veuillez réessayer dans un instant.'),
    ('global_search.empty_title', 'Aucun resultat trouve.', 'Aucun résultat trouvé.')
) AS fix(key, old_fr, new_fr)
WHERE t.key = fix.key
  AND t.translations->>'fr' = fix.old_fr;

-- 2. "Loading..." -> "Loading…" in every language of the 12 rows seeded with three dots
--    (Web Interface Guidelines: a real ellipsis character in loading and placeholder copy).
--    The pattern is a character class on purpose: no backslash to lose along the way.
UPDATE public.translations AS t
SET translations = (
      SELECT jsonb_object_agg(entry.key, to_jsonb(regexp_replace(entry.value, '[.]{3}$', '…')))
      FROM jsonb_each_text(t.translations) AS entry(key, value)
    ),
    updated_at = now()
WHERE t.key IN (
    'saving',
    'ecommerce.search_products',
    'ecommerce.processing',
    'ecommerce.calculating',
    'receipt_finalizing',
    'ecommerce.calculating_shipping',
    'global_search.placeholder',
    'signing_in_pending',
    'signing_up_pending',
    'reviews.submitting',
    'ecommerce.contact_seller_sending',
    'thread.sending'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_each_text(t.translations) AS entry(key, value)
    WHERE entry.value ~ '[.]{3}$'
  );

-- 3. 122 new keys, English and French. Until this runs the components fall back to the
--    same copy built in (useLabel in the app, translateOrFallback in the shop), which is also
--    what keeps an install that has not migrated yet from showing a raw key.
INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('account_menu', '{"en":"Account menu","fr":"Menu du compte"}'::jsonb, now(), now()),
  ('checkout_success_confirming', '{"en":"Confirming your order…","fr":"Confirmation de votre commande…"}'::jsonb, now(), now()),
  ('checkout_success_no_session', '{"en":"No order to show","fr":"Aucune commande à afficher"}'::jsonb, now(), now()),
  ('checkout_success_unconfirmed', '{"en":"We could not confirm your order","fr":"Nous n''avons pas pu confirmer votre commande"}'::jsonb, now(), now()),
  ('close', '{"en":"Close","fr":"Fermer"}'::jsonb, now(), now()),
  ('close_main_menu', '{"en":"Close main menu","fr":"Fermer le menu principal"}'::jsonb, now(), now()),
  ('comments.cancel', '{"en":"Cancel","fr":"Annuler"}'::jsonb, now(), now()),
  ('comments.submitting', '{"en":"Submitting…","fr":"Envoi en cours…"}'::jsonb, now(), now()),
  ('ecommerce.actions', '{"en":"Actions","fr":"Actions"}'::jsonb, now(), now()),
  ('ecommerce.apply', '{"en":"Apply","fr":"Appliquer"}'::jsonb, now(), now()),
  ('ecommerce.applying', '{"en":"Applying…","fr":"Application…"}'::jsonb, now(), now()),
  ('ecommerce.billing_cycle', '{"en":"Billing cycle","fr":"Cycle de facturation"}'::jsonb, now(), now()),
  ('ecommerce.cart_error_license_in_cart', '{"en":"This software license is already in your cart.","fr":"Cette licence logicielle est déjà dans votre panier."}'::jsonb, now(), now()),
  ('ecommerce.cart_error_out_of_stock', '{"en":"This item is out of stock.","fr":"Cet article est en rupture de stock."}'::jsonb, now(), now()),
  ('ecommerce.cart_error_stock_limit', '{"en":"Only {count} available.","fr":"Seulement {count} en stock."}'::jsonb, now(), now()),
  ('ecommerce.coupon', '{"en":"Coupon","fr":"Code promo"}'::jsonb, now(), now()),
  ('ecommerce.coupon_cart_empty', '{"en":"Add an item to your cart before applying a coupon.","fr":"Ajoutez un article à votre panier avant d''appliquer un code promo."}'::jsonb, now(), now()),
  ('ecommerce.coupon_code_required', '{"en":"Enter a coupon code.","fr":"Entrez un code promo."}'::jsonb, now(), now()),
  ('ecommerce.coupon_expired', '{"en":"This coupon has expired.","fr":"Ce code promo a expiré."}'::jsonb, now(), now()),
  ('ecommerce.coupon_inactive', '{"en":"This coupon is not active.","fr":"Ce code promo n''est pas actif."}'::jsonb, now(), now()),
  ('ecommerce.coupon_limit_reached', '{"en":"This coupon has reached its redemption limit.","fr":"Ce code promo a atteint sa limite d''utilisation."}'::jsonb, now(), now()),
  ('ecommerce.coupon_not_applicable', '{"en":"This coupon does not apply to the items in your cart.","fr":"Ce code promo ne s''applique pas aux articles de votre panier."}'::jsonb, now(), now()),
  ('ecommerce.coupon_not_found', '{"en":"Coupon code not found.","fr":"Code promo introuvable."}'::jsonb, now(), now()),
  ('ecommerce.coupon_not_started', '{"en":"This coupon is not active yet.","fr":"Ce code promo n''est pas encore actif."}'::jsonb, now(), now()),
  ('ecommerce.coupon_placeholder', '{"en":"SAVE10…","fr":"RABAIS10…"}'::jsonb, now(), now()),
  ('ecommerce.coupon_validation_failed', '{"en":"We couldn''t validate this coupon. Try again.","fr":"Impossible de valider ce code promo. Réessayez."}'::jsonb, now(), now()),
  ('ecommerce.currency', '{"en":"Currency","fr":"Devise"}'::jsonb, now(), now()),
  ('ecommerce.decrease_quantity', '{"en":"Decrease quantity","fr":"Diminuer la quantité"}'::jsonb, now(), now()),
  ('ecommerce.discount', '{"en":"Discount","fr":"Rabais"}'::jsonb, now(), now()),
  ('ecommerce.gallery_show_image', '{"en":"Show image {index} of {total}","fr":"Afficher l''image {index} sur {total}"}'::jsonb, now(), now()),
  ('ecommerce.in_stock_untracked', '{"en":"In stock","fr":"En stock"}'::jsonb, now(), now()),
  ('ecommerce.increase_quantity', '{"en":"Increase quantity","fr":"Augmenter la quantité"}'::jsonb, now(), now()),
  ('ecommerce.license_copied', '{"en":"Copied","fr":"Copié"}'::jsonb, now(), now()),
  ('ecommerce.license_copy', '{"en":"Copy key","fr":"Copier la clé"}'::jsonb, now(), now()),
  ('ecommerce.license_expires', '{"en":"Expires","fr":"Expire le"}'::jsonb, now(), now()),
  ('ecommerce.license_number', '{"en":"License #","fr":"Nº de licence"}'::jsonb, now(), now()),
  ('ecommerce.license_panel_email_fallback', '{"en":"Your license key was sent to your email. It will also appear here once your purchase is confirmed.","fr":"Votre clé de licence vous a été envoyée par courriel. Elle apparaîtra aussi ici une fois votre achat confirmé."}'::jsonb, now(), now()),
  ('ecommerce.license_panel_help', '{"en":"Activate this key in your NextBlock install under Settings → Packages.","fr":"Activez cette clé dans votre installation NextBlock, sous Settings → Packages."}'::jsonb, now(), now()),
  ('ecommerce.license_panel_title', '{"en":"Your license","fr":"Votre licence"}'::jsonb, now(), now()),
  ('ecommerce.license_renews', '{"en":"Renews / expires","fr":"Renouvellement / expiration"}'::jsonb, now(), now()),
  ('ecommerce.license_trial_ends', '{"en":"Trial ends","fr":"Fin de l''essai"}'::jsonb, now(), now()),
  ('ecommerce.open_cart_count', '{"en":"Open cart ({count} items)","fr":"Ouvrir le panier ({count} articles)"}'::jsonb, now(), now()),
  ('ecommerce.rating_out_of_5', '{"en":"Rated {rating} out of 5","fr":"Note de {rating} sur 5"}'::jsonb, now(), now()),
  ('ecommerce.regular_price', '{"en":"Regular price","fr":"Prix courant"}'::jsonb, now(), now()),
  ('ecommerce.remove_coupon', '{"en":"Remove coupon {code}","fr":"Retirer le code promo {code}"}'::jsonb, now(), now()),
  ('ecommerce.remove_item', '{"en":"Remove {item} from cart","fr":"Retirer {item} du panier"}'::jsonb, now(), now()),
  ('ecommerce.sale_price', '{"en":"Sale price","fr":"Prix réduit"}'::jsonb, now(), now()),
  ('ecommerce.sku', '{"en":"SKU","fr":"UGS"}'::jsonb, now(), now()),
  ('ecommerce.start_trial', '{"en":"Start {trial}","fr":"Commencer : {trial}"}'::jsonb, now(), now()),
  ('ecommerce.status', '{"en":"Status","fr":"Statut"}'::jsonb, now(), now()),
  ('ecommerce.trial_days', '{"en":"{count}-day free trial","fr":"Essai gratuit de {count} jours"}'::jsonb, now(), now()),
  ('ecommerce.trial_no_card', '{"en":"No credit card required","fr":"Aucune carte de crédit requise"}'::jsonb, now(), now()),
  ('ecommerce.trial_payment_required', '{"en":"Payment method required","fr":"Mode de paiement requis"}'::jsonb, now(), now()),
  ('footer_navigation', '{"en":"Footer navigation","fr":"Navigation du pied de page"}'::jsonb, now(), now()),
  ('forms.checkbox_default', '{"en":"I agree","fr":"J''accepte"}'::jsonb, now(), now()),
  ('forms.error_empty', '{"en":"Please fill in the form before submitting.","fr":"Veuillez remplir le formulaire avant de l''envoyer."}'::jsonb, now(), now()),
  ('forms.error_generic', '{"en":"Sorry, there was an error sending your message. Please try again later.","fr":"Désolé, une erreur s''est produite lors de l''envoi de votre message. Veuillez réessayer plus tard."}'::jsonb, now(), now()),
  ('forms.error_throttled', '{"en":"You''ve sent several messages already. Please wait a few minutes before sending another.","fr":"Vous avez déjà envoyé plusieurs messages. Veuillez patienter quelques minutes avant d''en envoyer un autre."}'::jsonb, now(), now()),
  ('forms.submitting', '{"en":"Submitting…","fr":"Envoi en cours…"}'::jsonb, now(), now()),
  ('forms.verification_failed', '{"en":"Security verification could not be completed. Please try again.","fr":"La vérification de sécurité n''a pas pu être complétée. Veuillez réessayer."}'::jsonb, now(), now()),
  ('forms.verification_load_failed', '{"en":"Security verification could not be loaded. Please refresh and try again.","fr":"La vérification de sécurité n''a pas pu être chargée. Veuillez actualiser la page et réessayer."}'::jsonb, now(), now()),
  ('forms.verification_start_failed', '{"en":"Security verification could not be started. Please try again.","fr":"La vérification de sécurité n''a pas pu démarrer. Veuillez réessayer."}'::jsonb, now(), now()),
  ('forms.verification_timeout', '{"en":"Security verification timed out. Please try again.","fr":"La vérification de sécurité a expiré. Veuillez réessayer."}'::jsonb, now(), now()),
  ('forms.verifying', '{"en":"Verifying…","fr":"Vérification…"}'::jsonb, now(), now()),
  ('global_search.loading', '{"en":"Searching…","fr":"Recherche en cours…"}'::jsonb, now(), now()),
  ('global_search.results_count', '{"en":"Results: {count}","fr":"Résultats : {count}"}'::jsonb, now(), now()),
  ('interactions.anonymous', '{"en":"Anonymous","fr":"Anonyme"}'::jsonb, now(), now()),
  ('language_switcher', '{"en":"Language","fr":"Langue"}'::jsonb, now(), now()),
  ('loading', '{"en":"Loading…","fr":"Chargement…"}'::jsonb, now(), now()),
  ('main_navigation', '{"en":"Main navigation","fr":"Navigation principale"}'::jsonb, now(), now()),
  ('nav.toggle_submenu', '{"en":"Toggle submenu for {label}","fr":"Afficher ou masquer le sous-menu de {label}"}'::jsonb, now(), now()),
  ('pagination.label', '{"en":"Pagination","fr":"Pagination"}'::jsonb, now(), now()),
  ('pagination.next', '{"en":"Next","fr":"Suivant"}'::jsonb, now(), now()),
  ('pagination.page_of', '{"en":"Page {current} of {total}","fr":"Page {current} sur {total}"}'::jsonb, now(), now()),
  ('pagination.previous', '{"en":"Previous","fr":"Précédent"}'::jsonb, now(), now()),
  ('photo_credit.anonymous', '{"en":"a photographer","fr":"un photographe"}'::jsonb, now(), now()),
  ('photo_credit.by', '{"en":"Photo by","fr":"Photo de"}'::jsonb, now(), now()),
  ('photo_credit.on', '{"en":"on","fr":"sur"}'::jsonb, now(), now()),
  ('posts_grid.empty', '{"en":"No posts found.","fr":"Aucun article trouvé."}'::jsonb, now(), now()),
  ('posts_grid.error', '{"en":"Failed to load posts.","fr":"Impossible de charger les articles."}'::jsonb, now(), now()),
  ('posts_grid.read_more', '{"en":"Read more","fr":"Lire la suite"}'::jsonb, now(), now()),
  ('product_grid.error', '{"en":"Failed to load products.","fr":"Impossible de charger les produits."}'::jsonb, now(), now()),
  ('profile', '{"en":"Profile","fr":"Profil"}'::jsonb, now(), now()),
  ('profile_change_avatar', '{"en":"Change profile picture","fr":"Changer la photo de profil"}'::jsonb, now(), now()),
  ('read_only', '{"en":"read-only","fr":"lecture seule"}'::jsonb, now(), now()),
  ('retry', '{"en":"Try again","fr":"Réessayer"}'::jsonb, now(), now()),
  ('reviews.rated', '{"en":"Rated {rating} out of 5","fr":"Note : {rating} sur 5"}'::jsonb, now(), now()),
  ('reviews.star_one', '{"en":"{count} star","fr":"{count} étoile"}'::jsonb, now(), now()),
  ('reviews.star_other', '{"en":"{count} stars","fr":"{count} étoiles"}'::jsonb, now(), now()),
  ('skip_to_content', '{"en":"Skip to main content","fr":"Aller au contenu principal"}'::jsonb, now(), now()),
  ('slider.go_to', '{"en":"Go to slide {current}","fr":"Aller à la diapositive {current}"}'::jsonb, now(), now()),
  ('slider.label', '{"en":"Slideshow","fr":"Diaporama"}'::jsonb, now(), now()),
  ('slider.next', '{"en":"Next slide","fr":"Diapositive suivante"}'::jsonb, now(), now()),
  ('slider.pause', '{"en":"Pause slideshow","fr":"Mettre le diaporama en pause"}'::jsonb, now(), now()),
  ('slider.play', '{"en":"Play slideshow","fr":"Lancer le diaporama"}'::jsonb, now(), now()),
  ('slider.previous', '{"en":"Previous slide","fr":"Diapositive précédente"}'::jsonb, now(), now()),
  ('slider.slide', '{"en":"Slide {current} of {total}","fr":"Diapositive {current} sur {total}"}'::jsonb, now(), now()),
  ('two_factor.code_incomplete', '{"en":"Enter the 6-digit code.","fr":"Entrez le code à 6 chiffres."}'::jsonb, now(), now()),
  ('two_factor.code_label', '{"en":"Verification code","fr":"Code de vérification"}'::jsonb, now(), now()),
  ('two_factor.code_sent_to', '{"en":"Enter the code we sent to {email}.","fr":"Entrez le code envoyé à {email}."}'::jsonb, now(), now()),
  ('two_factor.delivery_help', '{"en":"Codes can take a minute to arrive. If you request another, the earlier one still works: enter whichever reaches you first.","fr":"Les codes peuvent prendre une minute à arriver. Si vous en demandez un autre, le précédent reste valide : entrez celui qui vous parvient en premier."}'::jsonb, now(), now()),
  ('two_factor.email_help', '{"en":"For your security, enter the 6-digit code sent to {email}.","fr":"Pour votre sécurité, entrez le code à 6 chiffres envoyé à {email}."}'::jsonb, now(), now()),
  ('two_factor.resend', '{"en":"Resend code","fr":"Renvoyer le code"}'::jsonb, now(), now()),
  ('two_factor.resend_in', '{"en":"Resend available in {seconds}s","fr":"Renvoi possible dans {seconds} s"}'::jsonb, now(), now()),
  ('two_factor.send', '{"en":"Send me a code","fr":"Envoyez-moi un code"}'::jsonb, now(), now()),
  ('two_factor.send_failed', '{"en":"Could not send a code.","fr":"Impossible d''envoyer un code."}'::jsonb, now(), now()),
  ('two_factor.submit', '{"en":"Verify & continue","fr":"Vérifier et continuer"}'::jsonb, now(), now()),
  ('two_factor.title', '{"en":"Two-step verification","fr":"Vérification en deux étapes"}'::jsonb, now(), now()),
  ('two_factor.totp_help', '{"en":"Enter the 6-digit code from your authenticator app to finish signing in.","fr":"Entrez le code à 6 chiffres de votre application d''authentification pour terminer la connexion."}'::jsonb, now(), now()),
  ('two_factor.verification_failed', '{"en":"Verification failed.","fr":"La vérification a échoué."}'::jsonb, now(), now()),
  ('two_factor.your_email', '{"en":"your email","fr":"votre adresse courriel"}'::jsonb, now(), now()),
  ('unauthorized.contact_admin', '{"en":"Please contact your administrator if you believe this is an error.","fr":"Veuillez communiquer avec votre administrateur si vous croyez qu''il s''agit d''une erreur."}'::jsonb, now(), now()),
  ('unauthorized.description', '{"en":"You do not have the necessary permissions to view this page.","fr":"Vous n''avez pas les autorisations nécessaires pour consulter cette page."}'::jsonb, now(), now()),
  ('unauthorized.details', '{"en":"Details:","fr":"Détails :"}'::jsonb, now(), now()),
  ('unauthorized.error_code', '{"en":"Error code:","fr":"Code d''erreur :"}'::jsonb, now(), now()),
  ('unauthorized.go_home', '{"en":"Go to Homepage","fr":"Retour à l''accueil"}'::jsonb, now(), now()),
  ('unauthorized.or', '{"en":"OR","fr":"OU"}'::jsonb, now(), now()),
  ('unauthorized.requested_path', '{"en":"Requested path:","fr":"Chemin demandé :"}'::jsonb, now(), now()),
  ('unauthorized.required_roles', '{"en":"Required role(s):","fr":"Rôle(s) requis :"}'::jsonb, now(), now()),
  ('unauthorized.title', '{"en":"Access Denied","fr":"Accès refusé"}'::jsonb, now(), now()),
  ('video.play', '{"en":"Play video: {title}","fr":"Lire la vidéo : {title}"}'::jsonb, now(), now()),
  ('video.untitled', '{"en":"YouTube video","fr":"Vidéo YouTube"}'::jsonb, now(), now())
ON CONFLICT (key) DO NOTHING;
