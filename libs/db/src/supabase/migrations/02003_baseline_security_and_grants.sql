-- AUTO-GENERATED baseline: squash generation 2 (of migrations 00000000000000..00000000000042).
-- 003 · row-level security, policies, triggers, grants
-- Idempotent; safe to replay. Regenerate via tools/scripts/rebaseline-transform.mjs — do not hand-edit.
-- Naming: GGNNN_name.sql (GG = squash generation, NNN = sequence). See docs/04-DATABASE-AND-AUTH.md.

DROP TRIGGER IF EXISTS on_blocks_update ON public.blocks;
CREATE TRIGGER on_blocks_update BEFORE UPDATE ON public.blocks FOR EACH ROW EXECUTE FUNCTION public.handle_blocks_update();

DROP TRIGGER IF EXISTS on_content_drafts_update ON public.content_drafts;
CREATE TRIGGER on_content_drafts_update BEFORE UPDATE ON public.content_drafts FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS on_coupon_freemius_mappings_write ON public.coupon_freemius_mappings;
CREATE TRIGGER on_coupon_freemius_mappings_write BEFORE INSERT OR UPDATE ON public.coupon_freemius_mappings FOR EACH ROW EXECUTE FUNCTION public.handle_coupon_freemius_mappings_write();

DROP TRIGGER IF EXISTS on_coupons_write ON public.coupons;
CREATE TRIGGER on_coupons_write BEFORE INSERT OR UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.handle_coupons_write();

DROP TRIGGER IF EXISTS on_inventory_item_change ON public.inventory_items;
CREATE TRIGGER on_inventory_item_change AFTER INSERT OR DELETE OR UPDATE OF quantity ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION public.handle_inventory_item_change();

DROP TRIGGER IF EXISTS on_inventory_items_update ON public.inventory_items;
CREATE TRIGGER on_inventory_items_update BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION public.handle_inventory_items_update();

DROP TRIGGER IF EXISTS on_languages_update ON public.languages;
CREATE TRIGGER on_languages_update BEFORE UPDATE ON public.languages FOR EACH ROW EXECUTE FUNCTION public.handle_languages_update();

DROP TRIGGER IF EXISTS on_media_update ON public.media;
CREATE TRIGGER on_media_update BEFORE UPDATE ON public.media FOR EACH ROW EXECUTE FUNCTION public.handle_media_update();

DROP TRIGGER IF EXISTS on_navigation_items_update ON public.navigation_items;
CREATE TRIGGER on_navigation_items_update BEFORE UPDATE ON public.navigation_items FOR EACH ROW EXECUTE FUNCTION public.handle_navigation_items_update();

DROP TRIGGER IF EXISTS on_pages_update ON public.pages;
CREATE TRIGGER on_pages_update BEFORE UPDATE ON public.pages FOR EACH ROW EXECUTE FUNCTION public.handle_pages_update();

DROP TRIGGER IF EXISTS on_posts_update ON public.posts;
CREATE TRIGGER on_posts_update BEFORE UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.handle_posts_update();

DROP TRIGGER IF EXISTS on_product_drafts_update ON public.product_drafts;
CREATE TRIGGER on_product_drafts_update BEFORE UPDATE ON public.product_drafts FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS on_product_freemius_sale_coupons_write ON public.product_freemius_sale_coupons;
CREATE TRIGGER on_product_freemius_sale_coupons_write BEFORE INSERT OR UPDATE ON public.product_freemius_sale_coupons FOR EACH ROW EXECUTE FUNCTION public.handle_product_freemius_sale_coupons_write();

DROP TRIGGER IF EXISTS on_shipping_zone_locations_write ON public.shipping_zone_locations;
CREATE TRIGGER on_shipping_zone_locations_write BEFORE INSERT OR UPDATE ON public.shipping_zone_locations FOR EACH ROW EXECUTE FUNCTION public.handle_shipping_zone_locations_write();

DROP TRIGGER IF EXISTS on_tax_rates_write ON public.tax_rates;
CREATE TRIGGER on_tax_rates_write BEFORE INSERT OR UPDATE ON public.tax_rates FOR EACH ROW EXECUTE FUNCTION public.handle_tax_rates_write();

DROP TRIGGER IF EXISTS set_cms_redirects_updated_at ON public.cms_redirects;
CREATE TRIGGER set_cms_redirects_updated_at BEFORE UPDATE ON public.cms_redirects FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS set_form_endpoints_updated_at ON public.form_endpoints;
CREATE TRIGGER set_form_endpoints_updated_at BEFORE UPDATE ON public.form_endpoints FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS set_message_threads_updated_at ON public.message_threads;
CREATE TRIGGER set_message_threads_updated_at BEFORE UPDATE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS set_site_scripts_updated_at ON public.site_scripts;
CREATE TRIGGER set_site_scripts_updated_at BEFORE UPDATE ON public.site_scripts FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS set_site_themes_updated_at ON public.site_themes;
CREATE TRIGGER set_site_themes_updated_at BEFORE UPDATE ON public.site_themes FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON public.cms_interactions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.cms_interactions FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON public.translations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.translations FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS trg_handle_default_currency_change ON public.currencies;
CREATE TRIGGER trg_handle_default_currency_change AFTER INSERT OR UPDATE ON public.currencies FOR EACH ROW EXECUTE FUNCTION public.handle_default_currency_change();

DROP TRIGGER IF EXISTS trg_handle_default_theme_change ON public.site_themes;
CREATE TRIGGER trg_handle_default_theme_change AFTER INSERT OR UPDATE OF is_default ON public.site_themes FOR EACH ROW WHEN (new.is_default) EXECUTE FUNCTION public.handle_default_theme_change();

DROP TRIGGER IF EXISTS trg_handle_ucp_cart_sessions_update ON public.ucp_cart_sessions;
CREATE TRIGGER trg_handle_ucp_cart_sessions_update BEFORE UPDATE ON public.ucp_cart_sessions FOR EACH ROW EXECUTE FUNCTION public.handle_ucp_cart_sessions_update();

DROP TRIGGER IF EXISTS trg_prevent_system_theme_delete ON public.site_themes;
CREATE TRIGGER trg_prevent_system_theme_delete BEFORE DELETE ON public.site_themes FOR EACH ROW EXECUTE FUNCTION public.prevent_system_theme_delete();

DROP TRIGGER IF EXISTS trg_set_currency_defaults ON public.currencies;
CREATE TRIGGER trg_set_currency_defaults BEFORE INSERT OR UPDATE ON public.currencies FOR EACH ROW EXECUTE FUNCTION public.set_currency_defaults();

DROP TRIGGER IF EXISTS trg_site_script_revisions_append_only ON public.site_script_revisions;
CREATE TRIGGER trg_site_script_revisions_append_only BEFORE DELETE OR UPDATE ON public.site_script_revisions FOR EACH ROW EXECUTE FUNCTION public.prevent_site_script_revision_rewrite();

DROP TRIGGER IF EXISTS trg_sync_product_variants_currency_prices ON public.product_variants;
CREATE TRIGGER trg_sync_product_variants_currency_prices BEFORE INSERT OR UPDATE OF price, sale_price, prices, sale_prices ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.sync_currency_price_maps();

DROP TRIGGER IF EXISTS trg_sync_products_currency_prices ON public.products;
CREATE TRIGGER trg_sync_products_currency_prices BEFORE INSERT OR UPDATE OF price, sale_price, prices, sale_prices ON public.products FOR EACH ROW EXECUTE FUNCTION public.sync_currency_price_maps();

DROP TRIGGER IF EXISTS trg_sync_shipping_method_currency_maps ON public.shipping_zone_methods;
CREATE TRIGGER trg_sync_shipping_method_currency_maps BEFORE INSERT OR UPDATE OF cost_amount, cost_currency, min_order_amount, currency_pricing_mode, cost_amounts, min_order_amounts ON public.shipping_zone_methods FOR EACH ROW EXECUTE FUNCTION public.sync_shipping_method_currency_maps();

DROP TRIGGER IF EXISTS trg_system_alerts_updated_at ON public.system_alerts;
CREATE TRIGGER trg_system_alerts_updated_at BEFORE UPDATE ON public.system_alerts FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DROP TRIGGER IF EXISTS trg_thread_messages_append_only ON public.thread_messages;
CREATE TRIGGER trg_thread_messages_append_only BEFORE DELETE OR UPDATE ON public.thread_messages FOR EACH ROW EXECUTE FUNCTION public.prevent_thread_message_rewrite();

DROP TRIGGER IF EXISTS trigger_update_product_ratings ON public.cms_interactions;
CREATE TRIGGER trigger_update_product_ratings AFTER INSERT OR DELETE OR UPDATE ON public.cms_interactions FOR EACH ROW EXECUTE FUNCTION public.update_product_ratings();

DROP POLICY IF EXISTS "Admin can delete categories" ON public.categories;
CREATE POLICY "Admin can delete categories" ON public.categories FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS "Admin can delete product_categories" ON public.product_categories;
CREATE POLICY "Admin can delete product_categories" ON public.product_categories FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS "Admin can insert categories" ON public.categories;
CREATE POLICY "Admin can insert categories" ON public.categories FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS "Admin can insert product_categories" ON public.product_categories;
CREATE POLICY "Admin can insert product_categories" ON public.product_categories FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS "Admin can update categories" ON public.categories;
CREATE POLICY "Admin can update categories" ON public.categories FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS "Admin can update product_categories" ON public.product_categories;
CREATE POLICY "Admin can update product_categories" ON public.product_categories FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS "Admins delete redirects" ON public.cms_redirects;
CREATE POLICY "Admins delete redirects" ON public.cms_redirects FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins delete site scripts" ON public.site_scripts;
CREATE POLICY "Admins delete site scripts" ON public.site_scripts FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins delete themes" ON public.site_themes;
CREATE POLICY "Admins delete themes" ON public.site_themes FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert redirects" ON public.cms_redirects;
CREATE POLICY "Admins insert redirects" ON public.cms_redirects FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert site script revisions" ON public.site_script_revisions;
CREATE POLICY "Admins insert site script revisions" ON public.site_script_revisions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert site scripts" ON public.site_scripts;
CREATE POLICY "Admins insert site scripts" ON public.site_scripts FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert themes" ON public.site_themes;
CREATE POLICY "Admins insert themes" ON public.site_themes FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins read all redirects" ON public.cms_redirects;
CREATE POLICY "Admins read all redirects" ON public.cms_redirects FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins read all site scripts" ON public.site_scripts;
CREATE POLICY "Admins read all site scripts" ON public.site_scripts FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins read site script revisions" ON public.site_script_revisions;
CREATE POLICY "Admins read site script revisions" ON public.site_script_revisions FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins update redirects" ON public.cms_redirects;
CREATE POLICY "Admins update redirects" ON public.cms_redirects FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins update site scripts" ON public.site_scripts;
CREATE POLICY "Admins update site scripts" ON public.site_scripts FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins update themes" ON public.site_themes;
CREATE POLICY "Admins update themes" ON public.site_themes FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Allow authenticated read access" ON public.package_activations;
CREATE POLICY "Allow authenticated read access" ON public.package_activations FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow service role full access" ON public.package_activations;
CREATE POLICY "Allow service role full access" ON public.package_activations TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public can view categories" ON public.categories;
CREATE POLICY "Public can view categories" ON public.categories FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can view inventory items" ON public.inventory_items;
CREATE POLICY "Public can view inventory items" ON public.inventory_items FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can view product media" ON public.product_media;
CREATE POLICY "Public can view product media" ON public.product_media FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can view product_categories" ON public.product_categories;
CREATE POLICY "Public can view product_categories" ON public.product_categories FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can view products" ON public.products;
CREATE POLICY "Public can view products" ON public.products FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read access for freemius_plans" ON public.freemius_plans;
CREATE POLICY "Public read access for freemius_plans" ON public.freemius_plans FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read access for freemius_pricing" ON public.freemius_pricing;
CREATE POLICY "Public read access for freemius_pricing" ON public.freemius_pricing FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read active currencies" ON public.currencies;
CREATE POLICY "Public read active currencies" ON public.currencies FOR SELECT TO authenticated, anon USING ((is_active = true));

DROP POLICY IF EXISTS "Public read active redirects" ON public.cms_redirects;
CREATE POLICY "Public read active redirects" ON public.cms_redirects FOR SELECT TO authenticated, anon USING (is_active);

DROP POLICY IF EXISTS "Public read active site scripts" ON public.site_scripts;
CREATE POLICY "Public read active site scripts" ON public.site_scripts FOR SELECT TO authenticated, anon USING (is_active);

DROP POLICY IF EXISTS "Public read active themes" ON public.site_themes;
CREATE POLICY "Public read active themes" ON public.site_themes FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS "Public read product_attribute_terms" ON public.product_attribute_terms;
CREATE POLICY "Public read product_attribute_terms" ON public.product_attribute_terms FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read product_attributes" ON public.product_attributes;
CREATE POLICY "Public read product_attributes" ON public.product_attributes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read product_variants" ON public.product_variants;
CREATE POLICY "Public read product_variants" ON public.product_variants FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read shipping_zone_locations" ON public.shipping_zone_locations;
CREATE POLICY "Public read shipping_zone_locations" ON public.shipping_zone_locations FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read shipping_zone_methods" ON public.shipping_zone_methods;
CREATE POLICY "Public read shipping_zone_methods" ON public.shipping_zone_methods FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read shipping_zones" ON public.shipping_zones;
CREATE POLICY "Public read shipping_zones" ON public.shipping_zones FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read tax_rates" ON public.tax_rates;
CREATE POLICY "Public read tax_rates" ON public.tax_rates FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read variant_attribute_mapping" ON public.variant_attribute_mapping;
CREATE POLICY "Public read variant_attribute_mapping" ON public.variant_attribute_mapping FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service Role manages inventory items" ON public.inventory_items;
CREATE POLICY "Service Role manages inventory items" ON public.inventory_items TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service Role manages order items" ON public.order_items;
CREATE POLICY "Service Role manages order items" ON public.order_items TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service Role manages orders" ON public.orders;
CREATE POLICY "Service Role manages orders" ON public.orders TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service Role manages tax_rates" ON public.tax_rates;
CREATE POLICY "Service Role manages tax_rates" ON public.tax_rates TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manages all addresses" ON public.user_addresses;
CREATE POLICY "Service role manages all addresses" ON public.user_addresses TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manages currencies" ON public.currencies;
CREATE POLICY "Service role manages currencies" ON public.currencies TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manages themes" ON public.site_themes;
CREATE POLICY "Service role manages themes" ON public.site_themes TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can manage own addresses" ON public.user_addresses;
CREATE POLICY "Users can manage own addresses" ON public.user_addresses TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

DROP POLICY IF EXISTS "Users can view own order items" ON public.order_items;
CREATE POLICY "Users can view own order items" ON public.order_items FOR SELECT TO authenticated USING (((( SELECT public.is_admin() AS is_admin) IS TRUE) OR (EXISTS ( SELECT 1
   FROM public.orders
  WHERE ((orders.id = order_items.order_id) AND (orders.user_id = ( SELECT auth.uid() AS uid)))))));

DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
CREATE POLICY "Users can view own orders" ON public.orders FOR SELECT TO authenticated USING (((( SELECT public.is_admin() AS is_admin) IS TRUE) OR (user_id = ( SELECT auth.uid() AS uid))));

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS blocks_anon_read_policy ON public.blocks;
CREATE POLICY blocks_anon_read_policy ON public.blocks FOR SELECT TO anon USING ((((page_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.pages p
  WHERE ((p.id = blocks.page_id) AND (p.status = 'published'::public.page_status))))) OR ((post_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.posts pt
  WHERE ((pt.id = blocks.post_id) AND (pt.status = 'published'::public.page_status) AND ((pt.published_at IS NULL) OR (pt.published_at <= now())))))) OR ((product_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.products pr
  WHERE ((pr.id = blocks.product_id) AND (pr.status = 'active'::text)))))));

DROP POLICY IF EXISTS blocks_delete_policy ON public.blocks;
CREATE POLICY blocks_delete_policy ON public.blocks FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS blocks_insert_policy ON public.blocks;
CREATE POLICY blocks_insert_policy ON public.blocks FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS blocks_read_policy ON public.blocks;
CREATE POLICY blocks_read_policy ON public.blocks FOR SELECT TO authenticated USING (((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])) OR (((page_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.pages p
  WHERE ((p.id = blocks.page_id) AND (p.status = 'published'::public.page_status))))) OR ((post_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.posts pt
  WHERE ((pt.id = blocks.post_id) AND (pt.status = 'published'::public.page_status) AND ((pt.published_at IS NULL) OR (pt.published_at <= now())))))) OR ((product_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.products pr
  WHERE ((pr.id = blocks.product_id) AND (pr.status = 'active'::text))))))));

DROP POLICY IF EXISTS blocks_update_policy ON public.blocks;
CREATE POLICY blocks_update_policy ON public.blocks FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cms_interactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cms_interactions_delete_policy ON public.cms_interactions;
CREATE POLICY cms_interactions_delete_policy ON public.cms_interactions FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS cms_interactions_insert_policy ON public.cms_interactions;
CREATE POLICY cms_interactions_insert_policy ON public.cms_interactions FOR INSERT TO authenticated WITH CHECK (((auth.uid() = user_id) AND ((status = 'pending'::public.approval_status) OR (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])))));

DROP POLICY IF EXISTS cms_interactions_read_policy ON public.cms_interactions;
CREATE POLICY cms_interactions_read_policy ON public.cms_interactions FOR SELECT USING (((status = 'approved'::public.approval_status) OR (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))));

DROP POLICY IF EXISTS cms_interactions_update_policy ON public.cms_interactions;
CREATE POLICY cms_interactions_update_policy ON public.cms_interactions FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.cms_redirects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.content_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_drafts_delete_policy ON public.content_drafts;
CREATE POLICY content_drafts_delete_policy ON public.content_drafts FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS content_drafts_insert_policy ON public.content_drafts;
CREATE POLICY content_drafts_insert_policy ON public.content_drafts FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS content_drafts_select_policy ON public.content_drafts;
CREATE POLICY content_drafts_select_policy ON public.content_drafts FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS content_drafts_update_policy ON public.content_drafts;
CREATE POLICY content_drafts_update_policy ON public.content_drafts FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.cortex_ai_db_mutation_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cortex_ai_db_mutation_audit_admin_read_policy ON public.cortex_ai_db_mutation_audit;
CREATE POLICY cortex_ai_db_mutation_audit_admin_read_policy ON public.cortex_ai_db_mutation_audit FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS cortex_ai_db_mutation_audit_service_role_policy ON public.cortex_ai_db_mutation_audit;
CREATE POLICY cortex_ai_db_mutation_audit_service_role_policy ON public.cortex_ai_db_mutation_audit TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.coupon_freemius_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupon_freemius_mappings_admin_policy ON public.coupon_freemius_mappings;
CREATE POLICY coupon_freemius_mappings_admin_policy ON public.coupon_freemius_mappings TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupon_freemius_mappings_service_role_policy ON public.coupon_freemius_mappings;
CREATE POLICY coupon_freemius_mappings_service_role_policy ON public.coupon_freemius_mappings TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.coupon_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupon_products_admin_policy ON public.coupon_products;
CREATE POLICY coupon_products_admin_policy ON public.coupon_products TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupon_products_service_role_policy ON public.coupon_products;
CREATE POLICY coupon_products_service_role_policy ON public.coupon_products TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupon_redemptions_admin_select_policy ON public.coupon_redemptions;
CREATE POLICY coupon_redemptions_admin_select_policy ON public.coupon_redemptions FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupon_redemptions_service_role_policy ON public.coupon_redemptions;
CREATE POLICY coupon_redemptions_service_role_policy ON public.coupon_redemptions TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupons_admin_delete_policy ON public.coupons;
CREATE POLICY coupons_admin_delete_policy ON public.coupons FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupons_admin_insert_policy ON public.coupons;
CREATE POLICY coupons_admin_insert_policy ON public.coupons FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupons_admin_select_policy ON public.coupons;
CREATE POLICY coupons_admin_select_policy ON public.coupons FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupons_admin_update_policy ON public.coupons;
CREATE POLICY coupons_admin_update_policy ON public.coupons FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS coupons_service_role_policy ON public.coupons;
CREATE POLICY coupons_service_role_policy ON public.coupons TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS currencies_delete_policy ON public.currencies;
CREATE POLICY currencies_delete_policy ON public.currencies FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS currencies_insert_policy ON public.currencies;
CREATE POLICY currencies_insert_policy ON public.currencies FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS currencies_update_policy ON public.currencies;
CREATE POLICY currencies_update_policy ON public.currencies FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.custom_block_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_block_definitions_delete_policy ON public.custom_block_definitions;
CREATE POLICY custom_block_definitions_delete_policy ON public.custom_block_definitions FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS custom_block_definitions_insert_policy ON public.custom_block_definitions;
CREATE POLICY custom_block_definitions_insert_policy ON public.custom_block_definitions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS custom_block_definitions_public_read_policy ON public.custom_block_definitions;
CREATE POLICY custom_block_definitions_public_read_policy ON public.custom_block_definitions FOR SELECT USING (true);

DROP POLICY IF EXISTS custom_block_definitions_service_role_policy ON public.custom_block_definitions;
CREATE POLICY custom_block_definitions_service_role_policy ON public.custom_block_definitions TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS custom_block_definitions_update_policy ON public.custom_block_definitions;
CREATE POLICY custom_block_definitions_update_policy ON public.custom_block_definitions FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.email_2fa_challenges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_2fa_challenges_service_role_policy ON public.email_2fa_challenges;
CREATE POLICY email_2fa_challenges_service_role_policy ON public.email_2fa_challenges TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.form_endpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_endpoints_admin_write_policy ON public.form_endpoints;
CREATE POLICY form_endpoints_admin_write_policy ON public.form_endpoints TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS form_endpoints_editor_read_policy ON public.form_endpoints;
CREATE POLICY form_endpoints_editor_read_policy ON public.form_endpoints FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS form_endpoints_service_role_policy ON public.form_endpoints;
CREATE POLICY form_endpoints_service_role_policy ON public.form_endpoints TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.freemius_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.freemius_pricing ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_items_delete_policy ON public.inventory_items;
CREATE POLICY inventory_items_delete_policy ON public.inventory_items FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS inventory_items_insert_policy ON public.inventory_items;
CREATE POLICY inventory_items_insert_policy ON public.inventory_items FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS inventory_items_update_policy ON public.inventory_items;
CREATE POLICY inventory_items_update_policy ON public.inventory_items FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.languages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS languages_delete_policy ON public.languages;
CREATE POLICY languages_delete_policy ON public.languages FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS languages_insert_policy ON public.languages;
CREATE POLICY languages_insert_policy ON public.languages FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS languages_read_policy ON public.languages;
CREATE POLICY languages_read_policy ON public.languages FOR SELECT USING (true);

DROP POLICY IF EXISTS languages_update_policy ON public.languages;
CREATE POLICY languages_update_policy ON public.languages FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

ALTER TABLE public.logos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS logos_delete_policy ON public.logos;
CREATE POLICY logos_delete_policy ON public.logos FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS logos_insert_policy ON public.logos;
CREATE POLICY logos_insert_policy ON public.logos FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS logos_read_policy ON public.logos;
CREATE POLICY logos_read_policy ON public.logos FOR SELECT USING (true);

DROP POLICY IF EXISTS logos_update_policy ON public.logos;
CREATE POLICY logos_update_policy ON public.logos FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

ALTER TABLE public.mcp_access_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcp_access_tokens_admin_delete ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_delete ON public.mcp_access_tokens FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS mcp_access_tokens_admin_insert ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_insert ON public.mcp_access_tokens FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS mcp_access_tokens_admin_select ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_select ON public.mcp_access_tokens FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS mcp_access_tokens_admin_update ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_update ON public.mcp_access_tokens FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

ALTER TABLE public.media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_delete_policy ON public.media;
CREATE POLICY media_delete_policy ON public.media FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS media_insert_policy ON public.media;
CREATE POLICY media_insert_policy ON public.media FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS media_read_policy ON public.media;
CREATE POLICY media_read_policy ON public.media FOR SELECT USING (true);

DROP POLICY IF EXISTS media_service_role_policy ON public.media;
CREATE POLICY media_service_role_policy ON public.media TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS media_update_policy ON public.media;
CREATE POLICY media_update_policy ON public.media FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.message_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_threads_admin_read_policy ON public.message_threads;
CREATE POLICY message_threads_admin_read_policy ON public.message_threads FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS message_threads_admin_update_policy ON public.message_threads;
CREATE POLICY message_threads_admin_update_policy ON public.message_threads FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS message_threads_service_role_policy ON public.message_threads;
CREATE POLICY message_threads_service_role_policy ON public.message_threads TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.navigation_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS navigation_items_delete_policy ON public.navigation_items;
CREATE POLICY navigation_items_delete_policy ON public.navigation_items FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS navigation_items_insert_policy ON public.navigation_items;
CREATE POLICY navigation_items_insert_policy ON public.navigation_items FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS navigation_items_update_policy ON public.navigation_items;
CREATE POLICY navigation_items_update_policy ON public.navigation_items FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS navigation_read_policy ON public.navigation_items;
CREATE POLICY navigation_read_policy ON public.navigation_items FOR SELECT USING (true);

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_items_delete_policy ON public.order_items;
CREATE POLICY order_items_delete_policy ON public.order_items FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS order_items_insert_policy ON public.order_items;
CREATE POLICY order_items_insert_policy ON public.order_items FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS order_items_update_policy ON public.order_items;
CREATE POLICY order_items_update_policy ON public.order_items FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_delete_policy ON public.orders;
CREATE POLICY orders_delete_policy ON public.orders FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS orders_insert_policy ON public.orders;
CREATE POLICY orders_insert_policy ON public.orders FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS orders_update_policy ON public.orders;
CREATE POLICY orders_update_policy ON public.orders FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.package_activations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.page_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS page_revisions_delete_policy ON public.page_revisions;
CREATE POLICY page_revisions_delete_policy ON public.page_revisions FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS page_revisions_insert_policy ON public.page_revisions;
CREATE POLICY page_revisions_insert_policy ON public.page_revisions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS page_revisions_read_policy ON public.page_revisions;
CREATE POLICY page_revisions_read_policy ON public.page_revisions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS page_revisions_update_policy ON public.page_revisions;
CREATE POLICY page_revisions_update_policy ON public.page_revisions FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pages_anon_read_policy ON public.pages;
CREATE POLICY pages_anon_read_policy ON public.pages FOR SELECT TO anon USING ((status = 'published'::public.page_status));

DROP POLICY IF EXISTS pages_delete_policy ON public.pages;
CREATE POLICY pages_delete_policy ON public.pages FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS pages_insert_policy ON public.pages;
CREATE POLICY pages_insert_policy ON public.pages FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS pages_read_policy ON public.pages;
CREATE POLICY pages_read_policy ON public.pages FOR SELECT TO authenticated USING (((status = 'published'::public.page_status) OR ((author_id = ( SELECT auth.uid() AS uid)) AND (status <> 'published'::public.page_status)) OR (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))));

DROP POLICY IF EXISTS pages_update_policy ON public.pages;
CREATE POLICY pages_update_policy ON public.pages FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.post_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS post_revisions_delete_policy ON public.post_revisions;
CREATE POLICY post_revisions_delete_policy ON public.post_revisions FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS post_revisions_insert_policy ON public.post_revisions;
CREATE POLICY post_revisions_insert_policy ON public.post_revisions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS post_revisions_read_policy ON public.post_revisions;
CREATE POLICY post_revisions_read_policy ON public.post_revisions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS post_revisions_update_policy ON public.post_revisions;
CREATE POLICY post_revisions_update_policy ON public.post_revisions FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posts_anon_read_policy ON public.posts;
CREATE POLICY posts_anon_read_policy ON public.posts FOR SELECT TO anon USING (((status = 'published'::public.page_status) AND ((published_at IS NULL) OR (published_at <= now()))));

DROP POLICY IF EXISTS posts_delete_policy ON public.posts;
CREATE POLICY posts_delete_policy ON public.posts FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS posts_insert_policy ON public.posts;
CREATE POLICY posts_insert_policy ON public.posts FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS posts_read_policy ON public.posts;
CREATE POLICY posts_read_policy ON public.posts FOR SELECT TO authenticated USING ((((status = 'published'::public.page_status) AND ((published_at IS NULL) OR (published_at <= now()))) OR ((author_id = ( SELECT auth.uid() AS uid)) AND (status <> 'published'::public.page_status)) OR (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))));

DROP POLICY IF EXISTS posts_update_policy ON public.posts;
CREATE POLICY posts_update_policy ON public.posts FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.privacy_consent_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS privacy_consent_logs_admin_read_policy ON public.privacy_consent_logs;
CREATE POLICY privacy_consent_logs_admin_read_policy ON public.privacy_consent_logs FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS privacy_consent_logs_service_role_policy ON public.privacy_consent_logs;
CREATE POLICY privacy_consent_logs_service_role_policy ON public.privacy_consent_logs TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.product_attribute_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_attribute_terms_delete_policy ON public.product_attribute_terms;
CREATE POLICY product_attribute_terms_delete_policy ON public.product_attribute_terms FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_attribute_terms_insert_policy ON public.product_attribute_terms;
CREATE POLICY product_attribute_terms_insert_policy ON public.product_attribute_terms FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_attribute_terms_update_policy ON public.product_attribute_terms;
CREATE POLICY product_attribute_terms_update_policy ON public.product_attribute_terms FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.product_attributes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_attributes_delete_policy ON public.product_attributes;
CREATE POLICY product_attributes_delete_policy ON public.product_attributes FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_attributes_insert_policy ON public.product_attributes;
CREATE POLICY product_attributes_insert_policy ON public.product_attributes FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_attributes_update_policy ON public.product_attributes;
CREATE POLICY product_attributes_update_policy ON public.product_attributes FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.product_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_drafts_delete_policy ON public.product_drafts;
CREATE POLICY product_drafts_delete_policy ON public.product_drafts FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS product_drafts_insert_policy ON public.product_drafts;
CREATE POLICY product_drafts_insert_policy ON public.product_drafts FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS product_drafts_select_policy ON public.product_drafts;
CREATE POLICY product_drafts_select_policy ON public.product_drafts FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS product_drafts_update_policy ON public.product_drafts;
CREATE POLICY product_drafts_update_policy ON public.product_drafts FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.product_freemius_sale_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_freemius_sale_coupons_admin_policy ON public.product_freemius_sale_coupons;
CREATE POLICY product_freemius_sale_coupons_admin_policy ON public.product_freemius_sale_coupons TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_freemius_sale_coupons_service_role_policy ON public.product_freemius_sale_coupons;
CREATE POLICY product_freemius_sale_coupons_service_role_policy ON public.product_freemius_sale_coupons TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.product_inquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_inquiries_admin_read_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_admin_read_policy ON public.product_inquiries FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS product_inquiries_admin_update_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_admin_update_policy ON public.product_inquiries FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS product_inquiries_service_role_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_service_role_policy ON public.product_inquiries TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.product_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_media_delete_policy ON public.product_media;
CREATE POLICY product_media_delete_policy ON public.product_media FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_media_insert_policy ON public.product_media;
CREATE POLICY product_media_insert_policy ON public.product_media FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_media_update_policy ON public.product_media;
CREATE POLICY product_media_update_policy ON public.product_media FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.product_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_revisions_delete_policy ON public.product_revisions;
CREATE POLICY product_revisions_delete_policy ON public.product_revisions FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_revisions_insert_policy ON public.product_revisions;
CREATE POLICY product_revisions_insert_policy ON public.product_revisions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_revisions_read_policy ON public.product_revisions;
CREATE POLICY product_revisions_read_policy ON public.product_revisions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS product_revisions_update_policy ON public.product_revisions;
CREATE POLICY product_revisions_update_policy ON public.product_revisions FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_variants_delete_policy ON public.product_variants;
CREATE POLICY product_variants_delete_policy ON public.product_variants FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_variants_insert_policy ON public.product_variants;
CREATE POLICY product_variants_insert_policy ON public.product_variants FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_variants_update_policy ON public.product_variants;
CREATE POLICY product_variants_update_policy ON public.product_variants FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_delete_policy ON public.products;
CREATE POLICY products_delete_policy ON public.products FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS products_insert_policy ON public.products;
CREATE POLICY products_insert_policy ON public.products FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS products_update_policy ON public.products;
CREATE POLICY products_update_policy ON public.products FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_insert_policy ON public.profiles;
CREATE POLICY profiles_insert_policy ON public.profiles FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS profiles_read_policy ON public.profiles;
CREATE POLICY profiles_read_policy ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS profiles_service_role_policy ON public.profiles;
CREATE POLICY profiles_service_role_policy ON public.profiles TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles FOR UPDATE TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))) WITH CHECK (((id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)));

ALTER TABLE public.shipping_zone_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipping_zone_locations_delete_policy ON public.shipping_zone_locations;
CREATE POLICY shipping_zone_locations_delete_policy ON public.shipping_zone_locations FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS shipping_zone_locations_insert_policy ON public.shipping_zone_locations;
CREATE POLICY shipping_zone_locations_insert_policy ON public.shipping_zone_locations FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS shipping_zone_locations_update_policy ON public.shipping_zone_locations;
CREATE POLICY shipping_zone_locations_update_policy ON public.shipping_zone_locations FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.shipping_zone_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipping_zone_methods_delete_policy ON public.shipping_zone_methods;
CREATE POLICY shipping_zone_methods_delete_policy ON public.shipping_zone_methods FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS shipping_zone_methods_insert_policy ON public.shipping_zone_methods;
CREATE POLICY shipping_zone_methods_insert_policy ON public.shipping_zone_methods FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS shipping_zone_methods_update_policy ON public.shipping_zone_methods;
CREATE POLICY shipping_zone_methods_update_policy ON public.shipping_zone_methods FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.shipping_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipping_zones_delete_policy ON public.shipping_zones;
CREATE POLICY shipping_zones_delete_policy ON public.shipping_zones FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS shipping_zones_insert_policy ON public.shipping_zones;
CREATE POLICY shipping_zones_insert_policy ON public.shipping_zones FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS shipping_zones_update_policy ON public.shipping_zones;
CREATE POLICY shipping_zones_update_policy ON public.shipping_zones FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.site_script_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.site_scripts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings FOR DELETE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings FOR INSERT TO authenticated WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_read_policy ON public.site_settings;
CREATE POLICY site_settings_read_policy ON public.site_settings FOR SELECT USING (((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT auth.role() AS role) = 'authenticated'::text) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings FOR UPDATE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)))) WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

ALTER TABLE public.site_themes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_alerts_select_admin ON public.system_alerts;
CREATE POLICY system_alerts_select_admin ON public.system_alerts FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS system_alerts_update_admin ON public.system_alerts;
CREATE POLICY system_alerts_update_admin ON public.system_alerts FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

ALTER TABLE public.system_configuration ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_configuration_admin_delete ON public.system_configuration;
CREATE POLICY system_configuration_admin_delete ON public.system_configuration FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS system_configuration_admin_insert ON public.system_configuration;
CREATE POLICY system_configuration_admin_insert ON public.system_configuration FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS system_configuration_admin_select ON public.system_configuration;
CREATE POLICY system_configuration_admin_select ON public.system_configuration FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS system_configuration_admin_update ON public.system_configuration;
CREATE POLICY system_configuration_admin_update ON public.system_configuration FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS system_configuration_service_role_all ON public.system_configuration;
CREATE POLICY system_configuration_service_role_all ON public.system_configuration TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_rates_delete_policy ON public.tax_rates;
CREATE POLICY tax_rates_delete_policy ON public.tax_rates FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS tax_rates_insert_policy ON public.tax_rates;
CREATE POLICY tax_rates_insert_policy ON public.tax_rates FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS tax_rates_update_policy ON public.tax_rates;
CREATE POLICY tax_rates_update_policy ON public.tax_rates FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

ALTER TABLE public.thread_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thread_messages_admin_read_policy ON public.thread_messages;
CREATE POLICY thread_messages_admin_read_policy ON public.thread_messages FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS thread_messages_service_role_policy ON public.thread_messages;
CREATE POLICY thread_messages_service_role_policy ON public.thread_messages TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS translations_delete_policy ON public.translations;
CREATE POLICY translations_delete_policy ON public.translations FOR DELETE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS translations_insert_policy ON public.translations;
CREATE POLICY translations_insert_policy ON public.translations FOR INSERT TO authenticated WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS translations_read_policy ON public.translations;
CREATE POLICY translations_read_policy ON public.translations FOR SELECT USING (true);

DROP POLICY IF EXISTS translations_update_policy ON public.translations;
CREATE POLICY translations_update_policy ON public.translations FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

ALTER TABLE public.ucp_cart_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ucp_cart_sessions_service_role_policy ON public.ucp_cart_sessions;
CREATE POLICY ucp_cart_sessions_service_role_policy ON public.ucp_cart_sessions TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.user_addresses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_security_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_security_settings_insert_own_policy ON public.user_security_settings;
CREATE POLICY user_security_settings_insert_own_policy ON public.user_security_settings FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));

DROP POLICY IF EXISTS user_security_settings_select_own_policy ON public.user_security_settings;
CREATE POLICY user_security_settings_select_own_policy ON public.user_security_settings FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));

DROP POLICY IF EXISTS user_security_settings_service_role_policy ON public.user_security_settings;
CREATE POLICY user_security_settings_service_role_policy ON public.user_security_settings TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS user_security_settings_update_own_policy ON public.user_security_settings;
CREATE POLICY user_security_settings_update_own_policy ON public.user_security_settings FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));

ALTER TABLE public.user_trusted_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_trusted_devices_delete_own_policy ON public.user_trusted_devices;
CREATE POLICY user_trusted_devices_delete_own_policy ON public.user_trusted_devices FOR DELETE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));

DROP POLICY IF EXISTS user_trusted_devices_select_own_policy ON public.user_trusted_devices;
CREATE POLICY user_trusted_devices_select_own_policy ON public.user_trusted_devices FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));

DROP POLICY IF EXISTS user_trusted_devices_service_role_policy ON public.user_trusted_devices;
CREATE POLICY user_trusted_devices_service_role_policy ON public.user_trusted_devices TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.variant_attribute_mapping ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS variant_attribute_mapping_delete_policy ON public.variant_attribute_mapping;
CREATE POLICY variant_attribute_mapping_delete_policy ON public.variant_attribute_mapping FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS variant_attribute_mapping_insert_policy ON public.variant_attribute_mapping;
CREATE POLICY variant_attribute_mapping_insert_policy ON public.variant_attribute_mapping FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS variant_attribute_mapping_update_policy ON public.variant_attribute_mapping;
CREATE POLICY variant_attribute_mapping_update_policy ON public.variant_attribute_mapping FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) IS TRUE)) WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

GRANT USAGE ON SCHEMA public TO postgres;

GRANT USAGE ON SCHEMA public TO anon;

GRANT USAGE ON SCHEMA public TO authenticated;

GRANT USAGE ON SCHEMA public TO service_role;

GRANT ALL ON FUNCTION public.apply_order_inventory_deduction(p_order_id uuid) TO anon;

GRANT ALL ON FUNCTION public.apply_order_inventory_deduction(p_order_id uuid) TO authenticated;

GRANT ALL ON FUNCTION public.apply_order_inventory_deduction(p_order_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.assign_order_invoice_metadata(p_order_id uuid, p_paid_at timestamp with time zone) TO anon;

GRANT ALL ON FUNCTION public.assign_order_invoice_metadata(p_order_id uuid, p_paid_at timestamp with time zone) TO authenticated;

GRANT ALL ON FUNCTION public.assign_order_invoice_metadata(p_order_id uuid, p_paid_at timestamp with time zone) TO service_role;

GRANT ALL ON FUNCTION public.clear_currency_price_overrides(target_currency text) TO anon;

GRANT ALL ON FUNCTION public.clear_currency_price_overrides(target_currency text) TO authenticated;

GRANT ALL ON FUNCTION public.clear_currency_price_overrides(target_currency text) TO service_role;

GRANT ALL ON FUNCTION public.is_valid_custom_block_fields(candidate jsonb) TO anon;

GRANT ALL ON FUNCTION public.is_valid_custom_block_fields(candidate jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.is_valid_custom_block_fields(candidate jsonb) TO service_role;

GRANT ALL ON FUNCTION public.is_valid_custom_block_layout_schema(candidate jsonb) TO anon;

GRANT ALL ON FUNCTION public.is_valid_custom_block_layout_schema(candidate jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.is_valid_custom_block_layout_schema(candidate jsonb) TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.custom_block_definitions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.custom_block_definitions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.custom_block_definitions TO service_role;

REVOKE ALL ON FUNCTION public.duplicate_block_definition(target_id uuid) FROM PUBLIC;

GRANT ALL ON FUNCTION public.duplicate_block_definition(target_id uuid) TO anon;

GRANT ALL ON FUNCTION public.duplicate_block_definition(target_id uuid) TO authenticated;

GRANT ALL ON FUNCTION public.duplicate_block_definition(target_id uuid) TO service_role;

GRANT ALL ON FUNCTION public.format_order_invoice_number(p_value bigint) TO anon;

GRANT ALL ON FUNCTION public.format_order_invoice_number(p_value bigint) TO authenticated;

GRANT ALL ON FUNCTION public.format_order_invoice_number(p_value bigint) TO service_role;

GRANT ALL ON FUNCTION public.generate_order_invoice_number() TO anon;

GRANT ALL ON FUNCTION public.generate_order_invoice_number() TO authenticated;

GRANT ALL ON FUNCTION public.generate_order_invoice_number() TO service_role;

GRANT ALL ON FUNCTION public.get_current_user_role() TO anon;

GRANT ALL ON FUNCTION public.get_current_user_role() TO authenticated;

GRANT ALL ON FUNCTION public.get_current_user_role() TO service_role;

GRANT ALL ON FUNCTION public.get_default_currency_code() TO anon;

GRANT ALL ON FUNCTION public.get_default_currency_code() TO authenticated;

GRANT ALL ON FUNCTION public.get_default_currency_code() TO service_role;

GRANT ALL ON FUNCTION public.get_ecommerce_track_quantities() TO anon;

GRANT ALL ON FUNCTION public.get_ecommerce_track_quantities() TO authenticated;

GRANT ALL ON FUNCTION public.get_ecommerce_track_quantities() TO service_role;

GRANT ALL ON FUNCTION public.get_my_claim(claim text) TO anon;

GRANT ALL ON FUNCTION public.get_my_claim(claim text) TO authenticated;

GRANT ALL ON FUNCTION public.get_my_claim(claim text) TO service_role;

GRANT ALL ON FUNCTION public.handle_blocks_update() TO anon;

GRANT ALL ON FUNCTION public.handle_blocks_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_blocks_update() TO service_role;

GRANT ALL ON FUNCTION public.handle_coupon_freemius_mappings_write() TO anon;

GRANT ALL ON FUNCTION public.handle_coupon_freemius_mappings_write() TO authenticated;

GRANT ALL ON FUNCTION public.handle_coupon_freemius_mappings_write() TO service_role;

GRANT ALL ON FUNCTION public.handle_coupons_write() TO anon;

GRANT ALL ON FUNCTION public.handle_coupons_write() TO authenticated;

GRANT ALL ON FUNCTION public.handle_coupons_write() TO service_role;

GRANT ALL ON FUNCTION public.handle_default_currency_change() TO anon;

GRANT ALL ON FUNCTION public.handle_default_currency_change() TO authenticated;

GRANT ALL ON FUNCTION public.handle_default_currency_change() TO service_role;

GRANT ALL ON FUNCTION public.handle_default_theme_change() TO anon;

GRANT ALL ON FUNCTION public.handle_default_theme_change() TO authenticated;

GRANT ALL ON FUNCTION public.handle_default_theme_change() TO service_role;

GRANT ALL ON FUNCTION public.handle_inventory_item_change() TO anon;

GRANT ALL ON FUNCTION public.handle_inventory_item_change() TO authenticated;

GRANT ALL ON FUNCTION public.handle_inventory_item_change() TO service_role;

GRANT ALL ON FUNCTION public.handle_inventory_items_update() TO anon;

GRANT ALL ON FUNCTION public.handle_inventory_items_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_inventory_items_update() TO service_role;

GRANT ALL ON FUNCTION public.handle_languages_update() TO anon;

GRANT ALL ON FUNCTION public.handle_languages_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_languages_update() TO service_role;

GRANT ALL ON FUNCTION public.handle_media_update() TO anon;

GRANT ALL ON FUNCTION public.handle_media_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_media_update() TO service_role;

GRANT ALL ON FUNCTION public.handle_navigation_items_update() TO anon;

GRANT ALL ON FUNCTION public.handle_navigation_items_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_navigation_items_update() TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;

GRANT ALL ON FUNCTION public.handle_pages_update() TO anon;

GRANT ALL ON FUNCTION public.handle_pages_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_pages_update() TO service_role;

GRANT ALL ON FUNCTION public.handle_posts_update() TO anon;

GRANT ALL ON FUNCTION public.handle_posts_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_posts_update() TO service_role;

GRANT ALL ON FUNCTION public.handle_product_freemius_sale_coupons_write() TO anon;

GRANT ALL ON FUNCTION public.handle_product_freemius_sale_coupons_write() TO authenticated;

GRANT ALL ON FUNCTION public.handle_product_freemius_sale_coupons_write() TO service_role;

GRANT ALL ON FUNCTION public.handle_shipping_zone_locations_write() TO anon;

GRANT ALL ON FUNCTION public.handle_shipping_zone_locations_write() TO authenticated;

GRANT ALL ON FUNCTION public.handle_shipping_zone_locations_write() TO service_role;

GRANT ALL ON FUNCTION public.handle_tax_rates_write() TO anon;

GRANT ALL ON FUNCTION public.handle_tax_rates_write() TO authenticated;

GRANT ALL ON FUNCTION public.handle_tax_rates_write() TO service_role;

GRANT ALL ON FUNCTION public.handle_ucp_cart_sessions_update() TO anon;

GRANT ALL ON FUNCTION public.handle_ucp_cart_sessions_update() TO authenticated;

GRANT ALL ON FUNCTION public.handle_ucp_cart_sessions_update() TO service_role;

GRANT ALL ON FUNCTION public.is_admin() TO anon;

GRANT ALL ON FUNCTION public.is_admin() TO authenticated;

GRANT ALL ON FUNCTION public.is_admin() TO service_role;

GRANT ALL ON FUNCTION public.is_valid_currency_amount_map(amounts jsonb) TO anon;

GRANT ALL ON FUNCTION public.is_valid_currency_amount_map(amounts jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.is_valid_currency_amount_map(amounts jsonb) TO service_role;

GRANT ALL ON FUNCTION public.is_valid_sale_price_map(prices jsonb, sale_prices jsonb) TO anon;

GRANT ALL ON FUNCTION public.is_valid_sale_price_map(prices jsonb, sale_prices jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.is_valid_sale_price_map(prices jsonb, sale_prices jsonb) TO service_role;

GRANT ALL ON FUNCTION public.normalize_currency_amount_map(amounts jsonb) TO anon;

GRANT ALL ON FUNCTION public.normalize_currency_amount_map(amounts jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.normalize_currency_amount_map(amounts jsonb) TO service_role;

GRANT ALL ON FUNCTION public.prevent_site_script_revision_rewrite() TO anon;

GRANT ALL ON FUNCTION public.prevent_site_script_revision_rewrite() TO authenticated;

GRANT ALL ON FUNCTION public.prevent_site_script_revision_rewrite() TO service_role;

GRANT ALL ON FUNCTION public.prevent_system_theme_delete() TO anon;

GRANT ALL ON FUNCTION public.prevent_system_theme_delete() TO authenticated;

GRANT ALL ON FUNCTION public.prevent_system_theme_delete() TO service_role;

GRANT ALL ON FUNCTION public.prevent_thread_message_rewrite() TO anon;

GRANT ALL ON FUNCTION public.prevent_thread_message_rewrite() TO authenticated;

GRANT ALL ON FUNCTION public.prevent_thread_message_rewrite() TO service_role;

GRANT ALL ON FUNCTION public.set_currency_defaults() TO anon;

GRANT ALL ON FUNCTION public.set_currency_defaults() TO authenticated;

GRANT ALL ON FUNCTION public.set_currency_defaults() TO service_role;

GRANT ALL ON FUNCTION public.set_current_timestamp_updated_at() TO anon;

GRANT ALL ON FUNCTION public.set_current_timestamp_updated_at() TO authenticated;

GRANT ALL ON FUNCTION public.set_current_timestamp_updated_at() TO service_role;

GRANT ALL ON FUNCTION public.sync_currency_price_maps() TO anon;

GRANT ALL ON FUNCTION public.sync_currency_price_maps() TO authenticated;

GRANT ALL ON FUNCTION public.sync_currency_price_maps() TO service_role;

GRANT ALL ON FUNCTION public.sync_inventory_cache_for_sku(p_sku text) TO anon;

GRANT ALL ON FUNCTION public.sync_inventory_cache_for_sku(p_sku text) TO authenticated;

GRANT ALL ON FUNCTION public.sync_inventory_cache_for_sku(p_sku text) TO service_role;

GRANT ALL ON FUNCTION public.sync_legacy_price_columns_for_currency(target_currency text) TO anon;

GRANT ALL ON FUNCTION public.sync_legacy_price_columns_for_currency(target_currency text) TO authenticated;

GRANT ALL ON FUNCTION public.sync_legacy_price_columns_for_currency(target_currency text) TO service_role;

GRANT ALL ON FUNCTION public.sync_shipping_method_currency_maps() TO anon;

GRANT ALL ON FUNCTION public.sync_shipping_method_currency_maps() TO authenticated;

GRANT ALL ON FUNCTION public.sync_shipping_method_currency_maps() TO service_role;

GRANT ALL ON FUNCTION public.update_product_ratings() TO anon;

GRANT ALL ON FUNCTION public.update_product_ratings() TO authenticated;

GRANT ALL ON FUNCTION public.update_product_ratings() TO service_role;

GRANT ALL ON FUNCTION public.upsert_product_with_variants(product_payload jsonb) TO anon;

GRANT ALL ON FUNCTION public.upsert_product_with_variants(product_payload jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.upsert_product_with_variants(product_payload jsonb) TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.blocks TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.blocks TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.blocks TO service_role;

GRANT ALL ON SEQUENCE public.blocks_id_seq TO anon;

GRANT ALL ON SEQUENCE public.blocks_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.blocks_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.categories TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.categories TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.categories TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cms_interactions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cms_interactions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cms_interactions TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cms_redirects TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cms_redirects TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cms_redirects TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.content_drafts TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.content_drafts TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.content_drafts TO service_role;

GRANT ALL ON SEQUENCE public.content_drafts_id_seq TO anon;

GRANT ALL ON SEQUENCE public.content_drafts_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.content_drafts_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cortex_ai_db_mutation_audit TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cortex_ai_db_mutation_audit TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cortex_ai_db_mutation_audit TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_freemius_mappings TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_freemius_mappings TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_freemius_mappings TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_products TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_products TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_products TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_redemptions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_redemptions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupon_redemptions TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupons TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupons TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.coupons TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.currencies TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.currencies TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.currencies TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.email_2fa_challenges TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.email_2fa_challenges TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.email_2fa_challenges TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.form_endpoints TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.form_endpoints TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.form_endpoints TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.freemius_plans TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.freemius_plans TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.freemius_plans TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.freemius_pricing TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.freemius_pricing TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.freemius_pricing TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.inventory_items TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.inventory_items TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.inventory_items TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.languages TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.languages TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.languages TO service_role;

GRANT ALL ON SEQUENCE public.languages_id_seq TO anon;

GRANT ALL ON SEQUENCE public.languages_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.languages_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.logos TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.logos TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.logos TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.mcp_access_tokens TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.mcp_access_tokens TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.mcp_access_tokens TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.media TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.media TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.media TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.message_threads TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.message_threads TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.message_threads TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.navigation_items TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.navigation_items TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.navigation_items TO service_role;

GRANT ALL ON SEQUENCE public.navigation_items_id_seq TO anon;

GRANT ALL ON SEQUENCE public.navigation_items_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.navigation_items_id_seq TO service_role;

GRANT ALL ON SEQUENCE public.order_invoice_number_seq TO anon;

GRANT ALL ON SEQUENCE public.order_invoice_number_seq TO authenticated;

GRANT ALL ON SEQUENCE public.order_invoice_number_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.order_items TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.order_items TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.order_items TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.orders TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.orders TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.orders TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.package_activations TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.package_activations TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.package_activations TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.page_revisions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.page_revisions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.page_revisions TO service_role;

GRANT ALL ON SEQUENCE public.page_revisions_id_seq TO anon;

GRANT ALL ON SEQUENCE public.page_revisions_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.page_revisions_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.pages TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.pages TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.pages TO service_role;

GRANT ALL ON SEQUENCE public.pages_id_seq TO anon;

GRANT ALL ON SEQUENCE public.pages_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.pages_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.post_revisions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.post_revisions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.post_revisions TO service_role;

GRANT ALL ON SEQUENCE public.post_revisions_id_seq TO anon;

GRANT ALL ON SEQUENCE public.post_revisions_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.post_revisions_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.posts TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.posts TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.posts TO service_role;

GRANT ALL ON SEQUENCE public.posts_id_seq TO anon;

GRANT ALL ON SEQUENCE public.posts_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.posts_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.privacy_consent_logs TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.privacy_consent_logs TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.privacy_consent_logs TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_attribute_terms TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_attribute_terms TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_attribute_terms TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_attributes TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_attributes TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_attributes TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_categories TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_categories TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_categories TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_drafts TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_drafts TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_drafts TO service_role;

GRANT ALL ON SEQUENCE public.product_drafts_id_seq TO anon;

GRANT ALL ON SEQUENCE public.product_drafts_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.product_drafts_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_freemius_sale_coupons TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_freemius_sale_coupons TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_freemius_sale_coupons TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_inquiries TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_inquiries TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_inquiries TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_media TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_media TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_media TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_revisions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_revisions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_revisions TO service_role;

GRANT ALL ON SEQUENCE public.product_revisions_id_seq TO anon;

GRANT ALL ON SEQUENCE public.product_revisions_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.product_revisions_id_seq TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_variants TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_variants TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.product_variants TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.products TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.products TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.products TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.profiles TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.profiles TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.profiles TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zone_locations TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zone_locations TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zone_locations TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zone_methods TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zone_methods TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zone_methods TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zones TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zones TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.shipping_zones TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_script_revisions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_script_revisions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_script_revisions TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_scripts TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_scripts TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_scripts TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_settings TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_settings TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_settings TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_themes TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_themes TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.site_themes TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.system_alerts TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.system_alerts TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.system_alerts TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.system_configuration TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.system_configuration TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.system_configuration TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.tax_rates TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.tax_rates TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.tax_rates TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.thread_messages TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.thread_messages TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.thread_messages TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.translations TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.translations TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.translations TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.ucp_cart_sessions TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.ucp_cart_sessions TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.ucp_cart_sessions TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_addresses TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_addresses TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_addresses TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_security_settings TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_security_settings TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_security_settings TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_trusted_devices TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_trusted_devices TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_trusted_devices TO service_role;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.variant_attribute_mapping TO anon;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.variant_attribute_mapping TO authenticated;

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.variant_attribute_mapping TO service_role;

-- Re-attached: trigger lives on auth.users, which a public-only pg_dump omits.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
