-- AUTO-GENERATED baseline: squash generation 2 (of migrations 00000000000000..00000000000042).
-- 002 · constraints (PK / unique / check / FK) + indexes
-- Idempotent; safe to replay. Regenerate via tools/scripts/rebaseline-transform.mjs — do not hand-edit.
-- Naming: GGNNN_name.sql (GG = squash generation, NNN = sequence). See docs/04-DATABASE-AND-AUTH.md.

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_pkey' AND conrelid = 'public.blocks'::regclass) THEN
    ALTER TABLE ONLY public.blocks
        ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_pkey' AND conrelid = 'public.categories'::regclass) THEN
    ALTER TABLE ONLY public.categories
        ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_slug_key' AND conrelid = 'public.categories'::regclass) THEN
    ALTER TABLE ONLY public.categories
        ADD CONSTRAINT categories_slug_key UNIQUE (slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_interactions_pkey' AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE ONLY public.cms_interactions
        ADD CONSTRAINT cms_interactions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_redirects_pkey' AND conrelid = 'public.cms_redirects'::regclass) THEN
    ALTER TABLE ONLY public.cms_redirects
        ADD CONSTRAINT cms_redirects_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_redirects_source_path_key' AND conrelid = 'public.cms_redirects'::regclass) THEN
    ALTER TABLE ONLY public.cms_redirects
        ADD CONSTRAINT cms_redirects_source_path_key UNIQUE (source_path);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_drafts_parent_unique' AND conrelid = 'public.content_drafts'::regclass) THEN
    ALTER TABLE ONLY public.content_drafts
        ADD CONSTRAINT content_drafts_parent_unique UNIQUE (parent_type, parent_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_drafts_pkey' AND conrelid = 'public.content_drafts'::regclass) THEN
    ALTER TABLE ONLY public.content_drafts
        ADD CONSTRAINT content_drafts_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cortex_ai_db_mutation_audit_pkey' AND conrelid = 'public.cortex_ai_db_mutation_audit'::regclass) THEN
    ALTER TABLE ONLY public.cortex_ai_db_mutation_audit
        ADD CONSTRAINT cortex_ai_db_mutation_audit_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_freemius_mappings_pkey' AND conrelid = 'public.coupon_freemius_mappings'::regclass) THEN
    ALTER TABLE ONLY public.coupon_freemius_mappings
        ADD CONSTRAINT coupon_freemius_mappings_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_products_pkey' AND conrelid = 'public.coupon_products'::regclass) THEN
    ALTER TABLE ONLY public.coupon_products
        ADD CONSTRAINT coupon_products_pkey PRIMARY KEY (coupon_id, product_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_redemptions_pkey' AND conrelid = 'public.coupon_redemptions'::regclass) THEN
    ALTER TABLE ONLY public.coupon_redemptions
        ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupons_pkey' AND conrelid = 'public.coupons'::regclass) THEN
    ALTER TABLE ONLY public.coupons
        ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currencies_code_key' AND conrelid = 'public.currencies'::regclass) THEN
    ALTER TABLE ONLY public.currencies
        ADD CONSTRAINT currencies_code_key UNIQUE (code);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currencies_pkey' AND conrelid = 'public.currencies'::regclass) THEN
    ALTER TABLE ONLY public.currencies
        ADD CONSTRAINT currencies_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_block_definitions_pkey' AND conrelid = 'public.custom_block_definitions'::regclass) THEN
    ALTER TABLE ONLY public.custom_block_definitions
        ADD CONSTRAINT custom_block_definitions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_block_definitions_slug_key' AND conrelid = 'public.custom_block_definitions'::regclass) THEN
    ALTER TABLE ONLY public.custom_block_definitions
        ADD CONSTRAINT custom_block_definitions_slug_key UNIQUE (slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_2fa_challenges_pkey' AND conrelid = 'public.email_2fa_challenges'::regclass) THEN
    ALTER TABLE ONLY public.email_2fa_challenges
        ADD CONSTRAINT email_2fa_challenges_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_endpoints_pkey' AND conrelid = 'public.form_endpoints'::regclass) THEN
    ALTER TABLE ONLY public.form_endpoints
        ADD CONSTRAINT form_endpoints_pkey PRIMARY KEY (form_key);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freemius_plans_pkey' AND conrelid = 'public.freemius_plans'::regclass) THEN
    ALTER TABLE ONLY public.freemius_plans
        ADD CONSTRAINT freemius_plans_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freemius_pricing_pkey' AND conrelid = 'public.freemius_pricing'::regclass) THEN
    ALTER TABLE ONLY public.freemius_pricing
        ADD CONSTRAINT freemius_pricing_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_pkey' AND conrelid = 'public.inventory_items'::regclass) THEN
    ALTER TABLE ONLY public.inventory_items
        ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (sku);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'languages_code_key' AND conrelid = 'public.languages'::regclass) THEN
    ALTER TABLE ONLY public.languages
        ADD CONSTRAINT languages_code_key UNIQUE (code);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'languages_pkey' AND conrelid = 'public.languages'::regclass) THEN
    ALTER TABLE ONLY public.languages
        ADD CONSTRAINT languages_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logos_pkey' AND conrelid = 'public.logos'::regclass) THEN
    ALTER TABLE ONLY public.logos
        ADD CONSTRAINT logos_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_access_tokens_pkey' AND conrelid = 'public.mcp_access_tokens'::regclass) THEN
    ALTER TABLE ONLY public.mcp_access_tokens
        ADD CONSTRAINT mcp_access_tokens_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_access_tokens_token_hash_key' AND conrelid = 'public.mcp_access_tokens'::regclass) THEN
    ALTER TABLE ONLY public.mcp_access_tokens
        ADD CONSTRAINT mcp_access_tokens_token_hash_key UNIQUE (token_hash);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_object_key_key' AND conrelid = 'public.media'::regclass) THEN
    ALTER TABLE ONLY public.media
        ADD CONSTRAINT media_object_key_key UNIQUE (object_key);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_pkey' AND conrelid = 'public.media'::regclass) THEN
    ALTER TABLE ONLY public.media
        ADD CONSTRAINT media_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_threads_pkey' AND conrelid = 'public.message_threads'::regclass) THEN
    ALTER TABLE ONLY public.message_threads
        ADD CONSTRAINT message_threads_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_threads_token_hash_key' AND conrelid = 'public.message_threads'::regclass) THEN
    ALTER TABLE ONLY public.message_threads
        ADD CONSTRAINT message_threads_token_hash_key UNIQUE (token_hash);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'navigation_items_pkey' AND conrelid = 'public.navigation_items'::regclass) THEN
    ALTER TABLE ONLY public.navigation_items
        ADD CONSTRAINT navigation_items_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_pkey' AND conrelid = 'public.order_items'::regclass) THEN
    ALTER TABLE ONLY public.order_items
        ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_pkey' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE ONLY public.orders
        ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_stripe_session_id_key' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE ONLY public.orders
        ADD CONSTRAINT orders_stripe_session_id_key UNIQUE (stripe_session_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'package_activations_license_key_package_id_key' AND conrelid = 'public.package_activations'::regclass) THEN
    ALTER TABLE ONLY public.package_activations
        ADD CONSTRAINT package_activations_license_key_package_id_key UNIQUE (license_key, package_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'package_activations_pkey' AND conrelid = 'public.package_activations'::regclass) THEN
    ALTER TABLE ONLY public.package_activations
        ADD CONSTRAINT package_activations_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_revisions_page_version_key' AND conrelid = 'public.page_revisions'::regclass) THEN
    ALTER TABLE ONLY public.page_revisions
        ADD CONSTRAINT page_revisions_page_version_key UNIQUE (page_id, version);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_revisions_pkey' AND conrelid = 'public.page_revisions'::regclass) THEN
    ALTER TABLE ONLY public.page_revisions
        ADD CONSTRAINT page_revisions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_language_id_slug_key' AND conrelid = 'public.pages'::regclass) THEN
    ALTER TABLE ONLY public.pages
        ADD CONSTRAINT pages_language_id_slug_key UNIQUE (language_id, slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_pkey' AND conrelid = 'public.pages'::regclass) THEN
    ALTER TABLE ONLY public.pages
        ADD CONSTRAINT pages_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_revisions_pkey' AND conrelid = 'public.post_revisions'::regclass) THEN
    ALTER TABLE ONLY public.post_revisions
        ADD CONSTRAINT post_revisions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_revisions_post_version_key' AND conrelid = 'public.post_revisions'::regclass) THEN
    ALTER TABLE ONLY public.post_revisions
        ADD CONSTRAINT post_revisions_post_version_key UNIQUE (post_id, version);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_language_id_slug_key' AND conrelid = 'public.posts'::regclass) THEN
    ALTER TABLE ONLY public.posts
        ADD CONSTRAINT posts_language_id_slug_key UNIQUE (language_id, slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_pkey' AND conrelid = 'public.posts'::regclass) THEN
    ALTER TABLE ONLY public.posts
        ADD CONSTRAINT posts_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_consent_logs_consent_token_key' AND conrelid = 'public.privacy_consent_logs'::regclass) THEN
    ALTER TABLE ONLY public.privacy_consent_logs
        ADD CONSTRAINT privacy_consent_logs_consent_token_key UNIQUE (consent_token);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_consent_logs_pkey' AND conrelid = 'public.privacy_consent_logs'::regclass) THEN
    ALTER TABLE ONLY public.privacy_consent_logs
        ADD CONSTRAINT privacy_consent_logs_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_attribute_terms_attribute_id_slug_key' AND conrelid = 'public.product_attribute_terms'::regclass) THEN
    ALTER TABLE ONLY public.product_attribute_terms
        ADD CONSTRAINT product_attribute_terms_attribute_id_slug_key UNIQUE (attribute_id, slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_attribute_terms_pkey' AND conrelid = 'public.product_attribute_terms'::regclass) THEN
    ALTER TABLE ONLY public.product_attribute_terms
        ADD CONSTRAINT product_attribute_terms_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_attributes_pkey' AND conrelid = 'public.product_attributes'::regclass) THEN
    ALTER TABLE ONLY public.product_attributes
        ADD CONSTRAINT product_attributes_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_attributes_slug_key' AND conrelid = 'public.product_attributes'::regclass) THEN
    ALTER TABLE ONLY public.product_attributes
        ADD CONSTRAINT product_attributes_slug_key UNIQUE (slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_pkey' AND conrelid = 'public.product_categories'::regclass) THEN
    ALTER TABLE ONLY public.product_categories
        ADD CONSTRAINT product_categories_pkey PRIMARY KEY (product_id, category_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_drafts_pkey' AND conrelid = 'public.product_drafts'::regclass) THEN
    ALTER TABLE ONLY public.product_drafts
        ADD CONSTRAINT product_drafts_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_drafts_product_unique' AND conrelid = 'public.product_drafts'::regclass) THEN
    ALTER TABLE ONLY public.product_drafts
        ADD CONSTRAINT product_drafts_product_unique UNIQUE (product_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_freemius_sale_coupons_pkey' AND conrelid = 'public.product_freemius_sale_coupons'::regclass) THEN
    ALTER TABLE ONLY public.product_freemius_sale_coupons
        ADD CONSTRAINT product_freemius_sale_coupons_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_freemius_sale_coupons_product_unique' AND conrelid = 'public.product_freemius_sale_coupons'::regclass) THEN
    ALTER TABLE ONLY public.product_freemius_sale_coupons
        ADD CONSTRAINT product_freemius_sale_coupons_product_unique UNIQUE (product_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_inquiries_pkey' AND conrelid = 'public.product_inquiries'::regclass) THEN
    ALTER TABLE ONLY public.product_inquiries
        ADD CONSTRAINT product_inquiries_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_media_pkey' AND conrelid = 'public.product_media'::regclass) THEN
    ALTER TABLE ONLY public.product_media
        ADD CONSTRAINT product_media_pkey PRIMARY KEY (product_id, media_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_revisions_pkey' AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
        ADD CONSTRAINT product_revisions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_revisions_product_version_key' AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
        ADD CONSTRAINT product_revisions_product_version_key UNIQUE (product_id, version);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_pkey' AND conrelid = 'public.product_variants'::regclass) THEN
    ALTER TABLE ONLY public.product_variants
        ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_product_id_sku_key' AND conrelid = 'public.product_variants'::regclass) THEN
    ALTER TABLE ONLY public.product_variants
        ADD CONSTRAINT product_variants_product_id_sku_key UNIQUE (product_id, sku);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_language_id_sku_key' AND conrelid = 'public.products'::regclass) THEN
    ALTER TABLE ONLY public.products
        ADD CONSTRAINT products_language_id_sku_key UNIQUE (language_id, sku);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_language_id_slug_key' AND conrelid = 'public.products'::regclass) THEN
    ALTER TABLE ONLY public.products
        ADD CONSTRAINT products_language_id_slug_key UNIQUE (language_id, slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_pkey' AND conrelid = 'public.products'::regclass) THEN
    ALTER TABLE ONLY public.products
        ADD CONSTRAINT products_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_pkey' AND conrelid = 'public.profiles'::regclass) THEN
    ALTER TABLE ONLY public.profiles
        ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_zone_locations_pkey' AND conrelid = 'public.shipping_zone_locations'::regclass) THEN
    ALTER TABLE ONLY public.shipping_zone_locations
        ADD CONSTRAINT shipping_zone_locations_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_zone_methods_pkey' AND conrelid = 'public.shipping_zone_methods'::regclass) THEN
    ALTER TABLE ONLY public.shipping_zone_methods
        ADD CONSTRAINT shipping_zone_methods_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_zones_pkey' AND conrelid = 'public.shipping_zones'::regclass) THEN
    ALTER TABLE ONLY public.shipping_zones
        ADD CONSTRAINT shipping_zones_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_script_revisions_pkey' AND conrelid = 'public.site_script_revisions'::regclass) THEN
    ALTER TABLE ONLY public.site_script_revisions
        ADD CONSTRAINT site_script_revisions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_scripts_pkey' AND conrelid = 'public.site_scripts'::regclass) THEN
    ALTER TABLE ONLY public.site_scripts
        ADD CONSTRAINT site_scripts_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_settings_pkey' AND conrelid = 'public.site_settings'::regclass) THEN
    ALTER TABLE ONLY public.site_settings
        ADD CONSTRAINT site_settings_pkey PRIMARY KEY (key);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_themes_pkey' AND conrelid = 'public.site_themes'::regclass) THEN
    ALTER TABLE ONLY public.site_themes
        ADD CONSTRAINT site_themes_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_themes_slug_key' AND conrelid = 'public.site_themes'::regclass) THEN
    ALTER TABLE ONLY public.site_themes
        ADD CONSTRAINT site_themes_slug_key UNIQUE (slug);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_alerts_pkey' AND conrelid = 'public.system_alerts'::regclass) THEN
    ALTER TABLE ONLY public.system_alerts
        ADD CONSTRAINT system_alerts_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_configuration_pkey' AND conrelid = 'public.system_configuration'::regclass) THEN
    ALTER TABLE ONLY public.system_configuration
        ADD CONSTRAINT system_configuration_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_rates_pkey' AND conrelid = 'public.tax_rates'::regclass) THEN
    ALTER TABLE ONLY public.tax_rates
        ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_messages_pkey' AND conrelid = 'public.thread_messages'::regclass) THEN
    ALTER TABLE ONLY public.thread_messages
        ADD CONSTRAINT thread_messages_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'translations_pkey' AND conrelid = 'public.translations'::regclass) THEN
    ALTER TABLE ONLY public.translations
        ADD CONSTRAINT translations_pkey PRIMARY KEY (key);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ucp_cart_sessions_pkey' AND conrelid = 'public.ucp_cart_sessions'::regclass) THEN
    ALTER TABLE ONLY public.ucp_cart_sessions
        ADD CONSTRAINT ucp_cart_sessions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_addresses_pkey' AND conrelid = 'public.user_addresses'::regclass) THEN
    ALTER TABLE ONLY public.user_addresses
        ADD CONSTRAINT user_addresses_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_security_settings_pkey' AND conrelid = 'public.user_security_settings'::regclass) THEN
    ALTER TABLE ONLY public.user_security_settings
        ADD CONSTRAINT user_security_settings_pkey PRIMARY KEY (user_id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_trusted_devices_device_hash_key' AND conrelid = 'public.user_trusted_devices'::regclass) THEN
    ALTER TABLE ONLY public.user_trusted_devices
        ADD CONSTRAINT user_trusted_devices_device_hash_key UNIQUE (device_hash);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_trusted_devices_pkey' AND conrelid = 'public.user_trusted_devices'::regclass) THEN
    ALTER TABLE ONLY public.user_trusted_devices
        ADD CONSTRAINT user_trusted_devices_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_attribute_mapping_pkey' AND conrelid = 'public.variant_attribute_mapping'::regclass) THEN
    ALTER TABLE ONLY public.variant_attribute_mapping
        ADD CONSTRAINT variant_attribute_mapping_pkey PRIMARY KEY (variant_id, attribute_term_id);
  END IF;
END $rb$;

CREATE INDEX IF NOT EXISTS cms_interactions_inbox_idx ON public.cms_interactions USING btree (created_at DESC) WHERE (parent_id IS NULL);

CREATE INDEX IF NOT EXISTS cms_interactions_parent_idx ON public.cms_interactions USING btree (parent_id, created_at) WHERE (parent_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS cms_interactions_post_type_status_idx ON public.cms_interactions USING btree (post_id, type, status, created_at DESC) WHERE (post_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS cms_interactions_product_type_status_idx ON public.cms_interactions USING btree (product_id, type, status, created_at DESC) WHERE (product_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS cms_redirects_active_source_idx ON public.cms_redirects USING btree (source_path) WHERE is_active;

CREATE INDEX IF NOT EXISTS content_drafts_author_id_idx ON public.content_drafts USING btree (author_id);

CREATE INDEX IF NOT EXISTS content_drafts_parent_idx ON public.content_drafts USING btree (parent_type, parent_id);

CREATE INDEX IF NOT EXISTS content_drafts_updated_at_idx ON public.content_drafts USING btree (updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS coupon_freemius_mappings_coupon_product_unique ON public.coupon_freemius_mappings USING btree (coupon_id, freemius_product_id);

CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_order_unique ON public.coupon_redemptions USING btree (order_id) WHERE (order_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_unique ON public.coupons USING btree (upper(code));

CREATE UNIQUE INDEX IF NOT EXISTS ensure_single_default_language_idx ON public.languages USING btree (is_default) WHERE (is_default = true);

CREATE INDEX IF NOT EXISTS idx_blocks_language_id ON public.blocks USING btree (language_id);

CREATE INDEX IF NOT EXISTS idx_blocks_page_id ON public.blocks USING btree (page_id);

CREATE INDEX IF NOT EXISTS idx_blocks_post_id ON public.blocks USING btree (post_id);

CREATE INDEX IF NOT EXISTS idx_coupon_freemius_mappings_freemius_product_id ON public.coupon_freemius_mappings USING btree (freemius_product_id);

CREATE INDEX IF NOT EXISTS idx_coupon_freemius_mappings_product_id ON public.coupon_freemius_mappings USING btree (product_id) WHERE (product_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_coupon_products_product_id ON public.coupon_products USING btree (product_id);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_id ON public.coupon_redemptions USING btree (coupon_id);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user_id ON public.coupon_redemptions USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_coupons_active_dates ON public.coupons USING btree (is_active, starts_at, ends_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_currencies_single_default ON public.currencies USING btree (is_default) WHERE (is_default = true);

CREATE INDEX IF NOT EXISTS idx_custom_block_definitions_is_original ON public.custom_block_definitions USING btree (is_original);

CREATE INDEX IF NOT EXISTS idx_email_2fa_challenges_expires_at ON public.email_2fa_challenges USING btree (expires_at);

CREATE INDEX IF NOT EXISTS idx_email_2fa_challenges_user_id ON public.email_2fa_challenges USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_freemius_plans_product_id ON public.freemius_plans USING btree (product_id);

CREATE INDEX IF NOT EXISTS idx_freemius_pricing_plan_id ON public.freemius_pricing USING btree (plan_id);

CREATE INDEX IF NOT EXISTS idx_inventory_items_updated_at ON public.inventory_items USING btree (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_logos_media_id ON public.logos USING btree (media_id);

CREATE INDEX IF NOT EXISTS idx_media_uploader_id ON public.media USING btree (uploader_id);

CREATE INDEX IF NOT EXISTS idx_navigation_items_language_id ON public.navigation_items USING btree (language_id);

CREATE INDEX IF NOT EXISTS idx_navigation_items_menu_lang_order ON public.navigation_items USING btree (menu_key, language_id, "order");

CREATE INDEX IF NOT EXISTS idx_navigation_items_page_id ON public.navigation_items USING btree (page_id);

CREATE INDEX IF NOT EXISTS idx_navigation_items_parent_id ON public.navigation_items USING btree (parent_id);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items USING btree (order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON public.order_items USING btree (product_id);

CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON public.order_items USING btree (variant_id);

CREATE INDEX IF NOT EXISTS idx_orders_coupon_id ON public.orders USING btree (coupon_id) WHERE (coupon_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_orders_freemius_license_id ON public.orders USING btree (freemius_license_id) WHERE (freemius_license_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_orders_freemius_subscription_id ON public.orders USING btree (freemius_subscription_id) WHERE (freemius_subscription_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_orders_freemius_trial_id ON public.orders USING btree (freemius_trial_id) WHERE (freemius_trial_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice_number_unique ON public.orders USING btree (invoice_number) WHERE (invoice_number IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_package_activations_license_key ON public.package_activations USING btree (license_key);

CREATE INDEX IF NOT EXISTS idx_package_activations_package_id ON public.package_activations USING btree (package_id);

CREATE INDEX IF NOT EXISTS idx_page_revisions_author_id ON public.page_revisions USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_page_revisions_page_id_version ON public.page_revisions USING btree (page_id, version);

CREATE INDEX IF NOT EXISTS idx_pages_author_id ON public.pages USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_pages_feature_image_id ON public.pages USING btree (feature_image_id);

CREATE INDEX IF NOT EXISTS idx_pages_translation_group_id ON public.pages USING btree (translation_group_id);

CREATE INDEX IF NOT EXISTS idx_post_revisions_author_id ON public.post_revisions USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_post_revisions_post_id_version ON public.post_revisions USING btree (post_id, version);

CREATE INDEX IF NOT EXISTS idx_posts_author_id ON public.posts USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_posts_feature_image_id ON public.posts USING btree (feature_image_id);

CREATE INDEX IF NOT EXISTS idx_posts_translation_group_id ON public.posts USING btree (translation_group_id);

CREATE INDEX IF NOT EXISTS idx_privacy_consent_logs_created_at ON public.privacy_consent_logs USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_attribute_terms_attribute_id ON public.product_attribute_terms USING btree (attribute_id);

CREATE INDEX IF NOT EXISTS idx_product_categories_category_id ON public.product_categories USING btree (category_id);

CREATE INDEX IF NOT EXISTS idx_product_categories_product_id ON public.product_categories USING btree (product_id);

CREATE INDEX IF NOT EXISTS idx_product_freemius_sale_coupons_freemius_product_id ON public.product_freemius_sale_coupons USING btree (freemius_product_id);

CREATE INDEX IF NOT EXISTS idx_product_media_media_id ON public.product_media USING btree (media_id);

CREATE INDEX IF NOT EXISTS idx_product_media_product_id ON public.product_media USING btree (product_id);

CREATE INDEX IF NOT EXISTS idx_product_revisions_author_id ON public.product_revisions USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_product_revisions_product_id_version ON public.product_revisions USING btree (product_id, version);

CREATE INDEX IF NOT EXISTS idx_product_variants_main_media_id ON public.product_variants USING btree (main_media_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_prices_gin ON public.product_variants USING gin (prices jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON public.product_variants USING btree (product_id);

CREATE INDEX IF NOT EXISTS idx_products_prices_gin ON public.products USING gin (prices jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_products_slug ON public.products USING btree (slug);

CREATE INDEX IF NOT EXISTS idx_products_translation_group_id ON public.products USING btree (translation_group_id);

CREATE INDEX IF NOT EXISTS idx_shipping_zone_locations_country_state_postal ON public.shipping_zone_locations USING btree (country_code, state_code, postal_code);

CREATE INDEX IF NOT EXISTS idx_shipping_zone_locations_zone_id ON public.shipping_zone_locations USING btree (zone_id);

CREATE INDEX IF NOT EXISTS idx_shipping_zone_methods_name_translations ON public.shipping_zone_methods USING gin (name_translations);

CREATE INDEX IF NOT EXISTS idx_shipping_zone_methods_zone_id ON public.shipping_zone_methods USING btree (zone_id);

CREATE INDEX IF NOT EXISTS idx_system_alerts_unresolved ON public.system_alerts USING btree (is_resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tax_rates_country_state ON public.tax_rates USING btree (country_code, state_code);

CREATE INDEX IF NOT EXISTS idx_ucp_cart_sessions_created_at ON public.ucp_cart_sessions USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ucp_cart_sessions_status_expires_at ON public.ucp_cart_sessions USING btree (status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_addresses_one_default_per_type ON public.user_addresses USING btree (user_id, address_type) WHERE (is_default = true);

CREATE INDEX IF NOT EXISTS idx_user_addresses_type ON public.user_addresses USING btree (address_type);

CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON public.user_addresses USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_user_trusted_devices_expires_at ON public.user_trusted_devices USING btree (expires_at);

CREATE INDEX IF NOT EXISTS idx_user_trusted_devices_user_id ON public.user_trusted_devices USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_variant_attribute_mapping_attribute_term_id ON public.variant_attribute_mapping USING btree (attribute_term_id);

CREATE INDEX IF NOT EXISTS mcp_access_tokens_created_at_idx ON public.mcp_access_tokens USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_access_tokens_token_hash_idx ON public.mcp_access_tokens USING btree (token_hash);

CREATE INDEX IF NOT EXISTS media_folder_idx ON public.media USING btree (folder);

CREATE INDEX IF NOT EXISTS message_threads_last_message_idx ON public.message_threads USING btree (last_message_at DESC);

CREATE INDEX IF NOT EXISTS message_threads_source_last_idx ON public.message_threads USING btree (source, last_message_at DESC);

CREATE INDEX IF NOT EXISTS message_threads_subject_idx ON public.message_threads USING btree (subject_id) WHERE (subject_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS message_threads_unread_idx ON public.message_threads USING btree (last_message_at DESC) WHERE (unread_for_admin = true);

CREATE INDEX IF NOT EXISTS pages_status_published_at_idx ON public.pages USING btree (status, published_at);

CREATE INDEX IF NOT EXISTS product_drafts_author_id_idx ON public.product_drafts USING btree (author_id);

CREATE INDEX IF NOT EXISTS product_drafts_product_id_idx ON public.product_drafts USING btree (product_id);

CREATE INDEX IF NOT EXISTS product_drafts_updated_at_idx ON public.product_drafts USING btree (updated_at DESC);

CREATE INDEX IF NOT EXISTS product_inquiries_created_idx ON public.product_inquiries USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS product_inquiries_ip_created_idx ON public.product_inquiries USING btree (ip_masked, created_at DESC);

CREATE INDEX IF NOT EXISTS product_inquiries_unresolved_idx ON public.product_inquiries USING btree (created_at DESC) WHERE (is_resolved = false);

CREATE INDEX IF NOT EXISTS product_variants_sale_window_idx ON public.product_variants USING btree (sale_start_at, sale_end_at) WHERE ((sale_start_at IS NOT NULL) OR (sale_end_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS product_variants_scheduled_price_idx ON public.product_variants USING btree (scheduled_price_at) WHERE (scheduled_price_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS products_sale_window_idx ON public.products USING btree (sale_start_at, sale_end_at) WHERE ((sale_start_at IS NOT NULL) OR (sale_end_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS products_scheduled_price_idx ON public.products USING btree (scheduled_price_at) WHERE (scheduled_price_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS products_status_published_at_idx ON public.products USING btree (status, published_at);

CREATE INDEX IF NOT EXISTS site_script_revisions_created_idx ON public.site_script_revisions USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS site_script_revisions_script_created_idx ON public.site_script_revisions USING btree (script_id, created_at DESC);

CREATE INDEX IF NOT EXISTS site_scripts_active_placement_sort_idx ON public.site_scripts USING btree (is_active, placement, sort_order);

CREATE INDEX IF NOT EXISTS site_themes_active_sort_idx ON public.site_themes USING btree (is_active, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS site_themes_single_default_idx ON public.site_themes USING btree (is_default) WHERE (is_default = true);

CREATE UNIQUE INDEX IF NOT EXISTS tax_rates_country_state_name_key ON public.tax_rates USING btree (country_code, COALESCE(state_code, ''::text), lower(tax_name));

CREATE INDEX IF NOT EXISTS thread_messages_ip_created_idx ON public.thread_messages USING btree (ip_masked, created_at DESC);

CREATE INDEX IF NOT EXISTS thread_messages_thread_created_idx ON public.thread_messages USING btree (thread_id, created_at);

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_language_id_fkey' AND conrelid = 'public.blocks'::regclass) THEN
    ALTER TABLE ONLY public.blocks
        ADD CONSTRAINT blocks_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_page_id_fkey' AND conrelid = 'public.blocks'::regclass) THEN
    ALTER TABLE ONLY public.blocks
        ADD CONSTRAINT blocks_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_post_id_fkey' AND conrelid = 'public.blocks'::regclass) THEN
    ALTER TABLE ONLY public.blocks
        ADD CONSTRAINT blocks_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocks_product_id_fkey' AND conrelid = 'public.blocks'::regclass) THEN
    ALTER TABLE ONLY public.blocks
        ADD CONSTRAINT blocks_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_interactions_parent_id_fkey' AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE ONLY public.cms_interactions
        ADD CONSTRAINT cms_interactions_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.cms_interactions(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_interactions_post_id_fkey' AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE ONLY public.cms_interactions
        ADD CONSTRAINT cms_interactions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_interactions_product_id_fkey' AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE ONLY public.cms_interactions
        ADD CONSTRAINT cms_interactions_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_interactions_user_id_profiles_fkey' AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE ONLY public.cms_interactions
        ADD CONSTRAINT cms_interactions_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_drafts_author_id_fkey' AND conrelid = 'public.content_drafts'::regclass) THEN
    ALTER TABLE ONLY public.content_drafts
        ADD CONSTRAINT content_drafts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cortex_ai_db_mutation_audit_actor_user_id_fkey' AND conrelid = 'public.cortex_ai_db_mutation_audit'::regclass) THEN
    ALTER TABLE ONLY public.cortex_ai_db_mutation_audit
        ADD CONSTRAINT cortex_ai_db_mutation_audit_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_freemius_mappings_coupon_id_fkey' AND conrelid = 'public.coupon_freemius_mappings'::regclass) THEN
    ALTER TABLE ONLY public.coupon_freemius_mappings
        ADD CONSTRAINT coupon_freemius_mappings_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_freemius_mappings_product_id_fkey' AND conrelid = 'public.coupon_freemius_mappings'::regclass) THEN
    ALTER TABLE ONLY public.coupon_freemius_mappings
        ADD CONSTRAINT coupon_freemius_mappings_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_products_coupon_id_fkey' AND conrelid = 'public.coupon_products'::regclass) THEN
    ALTER TABLE ONLY public.coupon_products
        ADD CONSTRAINT coupon_products_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_products_product_id_fkey' AND conrelid = 'public.coupon_products'::regclass) THEN
    ALTER TABLE ONLY public.coupon_products
        ADD CONSTRAINT coupon_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_redemptions_coupon_id_fkey' AND conrelid = 'public.coupon_redemptions'::regclass) THEN
    ALTER TABLE ONLY public.coupon_redemptions
        ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_redemptions_order_id_fkey' AND conrelid = 'public.coupon_redemptions'::regclass) THEN
    ALTER TABLE ONLY public.coupon_redemptions
        ADD CONSTRAINT coupon_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_redemptions_user_id_fkey' AND conrelid = 'public.coupon_redemptions'::regclass) THEN
    ALTER TABLE ONLY public.coupon_redemptions
        ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_2fa_challenges_user_id_fkey' AND conrelid = 'public.email_2fa_challenges'::regclass) THEN
    ALTER TABLE ONLY public.email_2fa_challenges
        ADD CONSTRAINT email_2fa_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freemius_plans_product_id_fkey' AND conrelid = 'public.freemius_plans'::regclass) THEN
    ALTER TABLE ONLY public.freemius_plans
        ADD CONSTRAINT freemius_plans_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freemius_pricing_plan_id_fkey' AND conrelid = 'public.freemius_pricing'::regclass) THEN
    ALTER TABLE ONLY public.freemius_pricing
        ADD CONSTRAINT freemius_pricing_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.freemius_plans(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logos_media_id_fkey' AND conrelid = 'public.logos'::regclass) THEN
    ALTER TABLE ONLY public.logos
        ADD CONSTRAINT logos_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_access_tokens_created_by_fkey' AND conrelid = 'public.mcp_access_tokens'::regclass) THEN
    ALTER TABLE ONLY public.mcp_access_tokens
        ADD CONSTRAINT mcp_access_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_uploader_id_fkey' AND conrelid = 'public.media'::regclass) THEN
    ALTER TABLE ONLY public.media
        ADD CONSTRAINT media_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'navigation_items_language_id_fkey' AND conrelid = 'public.navigation_items'::regclass) THEN
    ALTER TABLE ONLY public.navigation_items
        ADD CONSTRAINT navigation_items_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'navigation_items_page_id_fkey' AND conrelid = 'public.navigation_items'::regclass) THEN
    ALTER TABLE ONLY public.navigation_items
        ADD CONSTRAINT navigation_items_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'navigation_items_parent_id_fkey' AND conrelid = 'public.navigation_items'::regclass) THEN
    ALTER TABLE ONLY public.navigation_items
        ADD CONSTRAINT navigation_items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.navigation_items(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_order_id_fkey' AND conrelid = 'public.order_items'::regclass) THEN
    ALTER TABLE ONLY public.order_items
        ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_product_id_fkey' AND conrelid = 'public.order_items'::regclass) THEN
    ALTER TABLE ONLY public.order_items
        ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_variant_id_fkey' AND conrelid = 'public.order_items'::regclass) THEN
    ALTER TABLE ONLY public.order_items
        ADD CONSTRAINT order_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_coupon_id_fkey' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE ONLY public.orders
        ADD CONSTRAINT orders_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_user_id_fkey' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE ONLY public.orders
        ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_revisions_author_id_fkey' AND conrelid = 'public.page_revisions'::regclass) THEN
    ALTER TABLE ONLY public.page_revisions
        ADD CONSTRAINT page_revisions_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_revisions_page_id_fkey' AND conrelid = 'public.page_revisions'::regclass) THEN
    ALTER TABLE ONLY public.page_revisions
        ADD CONSTRAINT page_revisions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_author_id_fkey' AND conrelid = 'public.pages'::regclass) THEN
    ALTER TABLE ONLY public.pages
        ADD CONSTRAINT pages_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_feature_image_id_fkey' AND conrelid = 'public.pages'::regclass) THEN
    ALTER TABLE ONLY public.pages
        ADD CONSTRAINT pages_feature_image_id_fkey FOREIGN KEY (feature_image_id) REFERENCES public.media(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_language_id_fkey' AND conrelid = 'public.pages'::regclass) THEN
    ALTER TABLE ONLY public.pages
        ADD CONSTRAINT pages_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_revisions_author_id_fkey' AND conrelid = 'public.post_revisions'::regclass) THEN
    ALTER TABLE ONLY public.post_revisions
        ADD CONSTRAINT post_revisions_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_revisions_post_id_fkey' AND conrelid = 'public.post_revisions'::regclass) THEN
    ALTER TABLE ONLY public.post_revisions
        ADD CONSTRAINT post_revisions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_author_id_fkey' AND conrelid = 'public.posts'::regclass) THEN
    ALTER TABLE ONLY public.posts
        ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_feature_image_id_fkey' AND conrelid = 'public.posts'::regclass) THEN
    ALTER TABLE ONLY public.posts
        ADD CONSTRAINT posts_feature_image_id_fkey FOREIGN KEY (feature_image_id) REFERENCES public.media(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_language_id_fkey' AND conrelid = 'public.posts'::regclass) THEN
    ALTER TABLE ONLY public.posts
        ADD CONSTRAINT posts_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_attribute_terms_attribute_id_fkey' AND conrelid = 'public.product_attribute_terms'::regclass) THEN
    ALTER TABLE ONLY public.product_attribute_terms
        ADD CONSTRAINT product_attribute_terms_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.product_attributes(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_category_id_fkey' AND conrelid = 'public.product_categories'::regclass) THEN
    ALTER TABLE ONLY public.product_categories
        ADD CONSTRAINT product_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_product_id_fkey' AND conrelid = 'public.product_categories'::regclass) THEN
    ALTER TABLE ONLY public.product_categories
        ADD CONSTRAINT product_categories_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_drafts_author_id_fkey' AND conrelid = 'public.product_drafts'::regclass) THEN
    ALTER TABLE ONLY public.product_drafts
        ADD CONSTRAINT product_drafts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_drafts_product_id_fkey' AND conrelid = 'public.product_drafts'::regclass) THEN
    ALTER TABLE ONLY public.product_drafts
        ADD CONSTRAINT product_drafts_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_freemius_sale_coupons_product_id_fkey' AND conrelid = 'public.product_freemius_sale_coupons'::regclass) THEN
    ALTER TABLE ONLY public.product_freemius_sale_coupons
        ADD CONSTRAINT product_freemius_sale_coupons_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_media_media_id_fkey' AND conrelid = 'public.product_media'::regclass) THEN
    ALTER TABLE ONLY public.product_media
        ADD CONSTRAINT product_media_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_media_product_id_fkey' AND conrelid = 'public.product_media'::regclass) THEN
    ALTER TABLE ONLY public.product_media
        ADD CONSTRAINT product_media_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_revisions_author_id_fkey' AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
        ADD CONSTRAINT product_revisions_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_revisions_product_id_fkey' AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
        ADD CONSTRAINT product_revisions_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_main_media_id_fkey' AND conrelid = 'public.product_variants'::regclass) THEN
    ALTER TABLE ONLY public.product_variants
        ADD CONSTRAINT product_variants_main_media_id_fkey FOREIGN KEY (main_media_id) REFERENCES public.media(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_product_id_fkey' AND conrelid = 'public.product_variants'::regclass) THEN
    ALTER TABLE ONLY public.product_variants
        ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_language_id_fkey' AND conrelid = 'public.products'::regclass) THEN
    ALTER TABLE ONLY public.products
        ADD CONSTRAINT products_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey' AND conrelid = 'public.profiles'::regclass) THEN
    ALTER TABLE ONLY public.profiles
        ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_zone_locations_zone_id_fkey' AND conrelid = 'public.shipping_zone_locations'::regclass) THEN
    ALTER TABLE ONLY public.shipping_zone_locations
        ADD CONSTRAINT shipping_zone_locations_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.shipping_zones(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_zone_methods_zone_id_fkey' AND conrelid = 'public.shipping_zone_methods'::regclass) THEN
    ALTER TABLE ONLY public.shipping_zone_methods
        ADD CONSTRAINT shipping_zone_methods_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.shipping_zones(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_messages_thread_id_fkey' AND conrelid = 'public.thread_messages'::regclass) THEN
    ALTER TABLE ONLY public.thread_messages
        ADD CONSTRAINT thread_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.message_threads(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_addresses_user_id_fkey' AND conrelid = 'public.user_addresses'::regclass) THEN
    ALTER TABLE ONLY public.user_addresses
        ADD CONSTRAINT user_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_security_settings_user_id_fkey' AND conrelid = 'public.user_security_settings'::regclass) THEN
    ALTER TABLE ONLY public.user_security_settings
        ADD CONSTRAINT user_security_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_trusted_devices_user_id_fkey' AND conrelid = 'public.user_trusted_devices'::regclass) THEN
    ALTER TABLE ONLY public.user_trusted_devices
        ADD CONSTRAINT user_trusted_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_attribute_mapping_attribute_term_id_fkey' AND conrelid = 'public.variant_attribute_mapping'::regclass) THEN
    ALTER TABLE ONLY public.variant_attribute_mapping
        ADD CONSTRAINT variant_attribute_mapping_attribute_term_id_fkey FOREIGN KEY (attribute_term_id) REFERENCES public.product_attribute_terms(id) ON DELETE CASCADE;
  END IF;
END $rb$;

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_attribute_mapping_variant_id_fkey' AND conrelid = 'public.variant_attribute_mapping'::regclass) THEN
    ALTER TABLE ONLY public.variant_attribute_mapping
        ADD CONSTRAINT variant_attribute_mapping_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;
  END IF;
END $rb$;
