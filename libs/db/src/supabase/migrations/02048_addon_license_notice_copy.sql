-- 02048: storefront copy for add-on licenses, EN + FR. Data only; no schema.
--
-- NextBlock Affiliates & Creator Storefronts is an add-on: it runs only on top of NextBlock Commerce
-- Pro (`requires` in libs/utils/src/lib/nextblock-packages.ts). The store now says so wherever the
-- add-on can be bought: a "Requires Commerce Pro" badge on its product card, a notice above its
-- purchase controls, a notice in the cart and the checkout with a button that adds Commerce Pro, and
-- the title of the Freemius window (libs/ecommerce/src/lib/components/AddonRequirementNotice.tsx).
-- Only a store that carries NextBlock's own license products (nextblock.dev, and the public sandbox,
-- whose reset imports them) has an add-on product, so no other store shows any of it; the keys are
-- seeded everywhere, like all UI copy.
--
-- {base}, {addon} and {product} are filled in by the components ({base} is the package name, e.g.
-- "Commerce Pro"). New keys only (ON CONFLICT DO NOTHING): copy an operator edited under
-- CMS -> Translations is left alone, and a second run changes nothing.

INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('ecommerce.addon_add_base', '{"en":"Add {base} to cart","fr":"Ajouter {base} au panier"}'::jsonb, now(), now()),
  ('ecommerce.addon_cart_body', '{"en":"It needs an active {base} license on the same site. Already have one? You can carry on. If not, add {base} to your cart too.","fr":"Il exige une licence {base} active sur le même site. Vous en avez déjà une? Vous pouvez poursuivre. Sinon, ajoutez aussi {base} à votre panier."}'::jsonb, now(), now()),
  ('ecommerce.addon_cart_title', '{"en":"{addon} is an add-on for {base}","fr":"{addon} est un module complémentaire de {base}"}'::jsonb, now(), now()),
  ('ecommerce.addon_checkout_window_title', '{"en":"{product} ({base} add-on)","fr":"{product} (module complémentaire de {base})"}'::jsonb, now(), now()),
  ('ecommerce.addon_for', '{"en":"Add-on for {base}","fr":"Module complémentaire de {base}"}'::jsonb, now(), now()),
  ('ecommerce.addon_requires_badge', '{"en":"Requires {base}","fr":"Exige {base}"}'::jsonb, now(), now()),
  ('ecommerce.addon_requires_license', '{"en":"It needs an active {base} license on the same site, sold separately.","fr":"Il exige une licence {base} active sur le même site, vendue séparément."}'::jsonb, now(), now()),
  ('ecommerce.addon_view_base', '{"en":"View {base}","fr":"Voir {base}"}'::jsonb, now(), now())
ON CONFLICT (key) DO NOTHING;
