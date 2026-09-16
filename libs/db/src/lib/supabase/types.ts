export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      blocks: {
        Row: {
          block_type: string
          content: Json | null
          created_at: string
          id: number
          language_id: number
          order: number
          page_id: number | null
          post_id: number | null
          product_id: string | null
          updated_at: string
        }
        Insert: {
          block_type: string
          content?: Json | null
          created_at?: string
          id?: number
          language_id: number
          order?: number
          page_id?: number | null
          post_id?: number | null
          product_id?: string | null
          updated_at?: string
        }
        Update: {
          block_type?: string
          content?: Json | null
          created_at?: string
          id?: number
          language_id?: number
          order?: number
          page_id?: number | null
          post_id?: number | null
          product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_language_id_fkey"
            columns: ["language_id"]
            isOneToOne: false
            referencedRelation: "languages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          description: string | null
          description_translations: Json
          id: string
          name: string
          name_translations: Json
          slug: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          description_translations?: Json
          id?: string
          name: string
          name_translations?: Json
          slug: string
        }
        Update: {
          created_at?: string
          description?: string | null
          description_translations?: Json
          id?: string
          name?: string
          name_translations?: Json
          slug?: string
        }
        Relationships: []
      }
      cms_interactions: {
        Row: {
          content: string
          created_at: string
          id: string
          parent_id: string | null
          post_id: number | null
          product_id: string | null
          rating: number | null
          reactions: Json
          status: Database["public"]["Enums"]["approval_status"]
          type: Database["public"]["Enums"]["interaction_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          parent_id?: string | null
          post_id?: number | null
          product_id?: string | null
          rating?: number | null
          reactions?: Json
          status?: Database["public"]["Enums"]["approval_status"]
          type: Database["public"]["Enums"]["interaction_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          parent_id?: string | null
          post_id?: number | null
          product_id?: string | null
          rating?: number | null
          reactions?: Json
          status?: Database["public"]["Enums"]["approval_status"]
          type?: Database["public"]["Enums"]["interaction_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cms_interactions_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "cms_interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cms_interactions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cms_interactions_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cms_interactions_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cms_redirects: {
        Row: {
          created_at: string
          destination_path: string
          id: string
          is_active: boolean
          source_path: string
          status_code: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          destination_path: string
          id?: string
          is_active?: boolean
          source_path: string
          status_code?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          destination_path?: string
          id?: string
          is_active?: boolean
          source_path?: string
          status_code?: number
          updated_at?: string
        }
        Relationships: []
      }
      content_drafts: {
        Row: {
          author_id: string | null
          base_version: number
          blocks: Json
          created_at: string
          id: number
          meta: Json
          parent_id: number
          parent_type: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          base_version?: number
          blocks?: Json
          created_at?: string
          id?: number
          meta?: Json
          parent_id: number
          parent_type: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          base_version?: number
          blocks?: Json
          created_at?: string
          id?: number
          meta?: Json
          parent_id?: number
          parent_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_drafts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cortex_ai_db_mutation_audit: {
        Row: {
          action_name: string
          actor_user_id: string | null
          created_at: string
          error_message: string | null
          id: string
          operation_summary: string
          payload: Json
          payload_hash: string
          preview: Json
          status: string
          target_tables: string[]
          tool_name: string
        }
        Insert: {
          action_name: string
          actor_user_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          operation_summary: string
          payload?: Json
          payload_hash: string
          preview?: Json
          status: string
          target_tables?: string[]
          tool_name: string
        }
        Update: {
          action_name?: string
          actor_user_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          operation_summary?: string
          payload?: Json
          payload_hash?: string
          preview?: Json
          status?: string
          target_tables?: string[]
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "cortex_ai_db_mutation_audit_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_freemius_mappings: {
        Row: {
          coupon_id: string
          created_at: string
          freemius_coupon_code: string
          freemius_coupon_id: string | null
          freemius_product_id: string
          id: string
          last_synced_at: string | null
          product_id: string | null
          remote_payload: Json | null
          sync_error: string | null
          sync_status: string
          updated_at: string
        }
        Insert: {
          coupon_id: string
          created_at?: string
          freemius_coupon_code: string
          freemius_coupon_id?: string | null
          freemius_product_id: string
          id?: string
          last_synced_at?: string | null
          product_id?: string | null
          remote_payload?: Json | null
          sync_error?: string | null
          sync_status?: string
          updated_at?: string
        }
        Update: {
          coupon_id?: string
          created_at?: string
          freemius_coupon_code?: string
          freemius_coupon_id?: string | null
          freemius_product_id?: string
          id?: string
          last_synced_at?: string | null
          product_id?: string | null
          remote_payload?: Json | null
          sync_error?: string | null
          sync_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_freemius_mappings_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_freemius_mappings_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_products: {
        Row: {
          coupon_id: string
          created_at: string
          product_id: string
        }
        Insert: {
          coupon_id: string
          created_at?: string
          product_id: string
        }
        Update: {
          coupon_id?: string
          created_at?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_products_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_redemptions: {
        Row: {
          coupon_code: string
          coupon_id: string | null
          customer_email: string | null
          discount_total: number
          id: string
          metadata: Json
          order_id: string | null
          provider: string
          redeemed_at: string
          user_id: string | null
        }
        Insert: {
          coupon_code: string
          coupon_id?: string | null
          customer_email?: string | null
          discount_total?: number
          id?: string
          metadata?: Json
          order_id?: string | null
          provider: string
          redeemed_at?: string
          user_id?: string | null
        }
        Update: {
          coupon_code?: string
          coupon_id?: string | null
          customer_email?: string | null
          discount_total?: number
          id?: string
          metadata?: Json
          order_id?: string | null
          provider?: string
          redeemed_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          code: string
          created_at: string
          discount_amount: number
          discount_type: string
          ends_at: string | null
          freemius_sync_error: string | null
          freemius_sync_status: string
          id: string
          internal_note: string | null
          is_active: boolean
          name: string
          provider_scope: string
          redemption_limit: number | null
          redemptions_count: number
          starts_at: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          discount_amount: number
          discount_type: string
          ends_at?: string | null
          freemius_sync_error?: string | null
          freemius_sync_status?: string
          id?: string
          internal_note?: string | null
          is_active?: boolean
          name: string
          provider_scope?: string
          redemption_limit?: number | null
          redemptions_count?: number
          starts_at?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          discount_amount?: number
          discount_type?: string
          ends_at?: string | null
          freemius_sync_error?: string | null
          freemius_sync_status?: string
          id?: string
          internal_note?: string | null
          is_active?: boolean
          name?: string
          provider_scope?: string
          redemption_limit?: number | null
          redemptions_count?: number
          starts_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      currencies: {
        Row: {
          auto_sync_product_prices: boolean
          auto_update_exchange_rate: boolean
          code: string
          created_at: string
          exchange_rate: number
          exchange_rate_source: string | null
          exchange_rate_updated_at: string | null
          id: string
          is_active: boolean
          is_default: boolean
          rounding_charm_amount: number | null
          rounding_increment: number
          rounding_mode: string
          symbol: string
          updated_at: string
        }
        Insert: {
          auto_sync_product_prices?: boolean
          auto_update_exchange_rate?: boolean
          code: string
          created_at?: string
          exchange_rate: number
          exchange_rate_source?: string | null
          exchange_rate_updated_at?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          rounding_charm_amount?: number | null
          rounding_increment?: number
          rounding_mode?: string
          symbol: string
          updated_at?: string
        }
        Update: {
          auto_sync_product_prices?: boolean
          auto_update_exchange_rate?: boolean
          code?: string
          created_at?: string
          exchange_rate?: number
          exchange_rate_source?: string | null
          exchange_rate_updated_at?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          rounding_charm_amount?: number | null
          rounding_increment?: number
          rounding_mode?: string
          symbol?: string
          updated_at?: string
        }
        Relationships: []
      }
      custom_block_definitions: {
        Row: {
          description: string
          fields: Json
          id: string
          is_original: boolean
          layout_schema: Json
          name: string
          slug: string
        }
        Insert: {
          description?: string
          fields?: Json
          id?: string
          is_original?: boolean
          layout_schema: Json
          name: string
          slug: string
        }
        Update: {
          description?: string
          fields?: Json
          id?: string
          is_original?: boolean
          layout_schema?: Json
          name?: string
          slug?: string
        }
        Relationships: []
      }
      email_2fa_challenges: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          token_hash: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          token_hash: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      form_endpoints: {
        Row: {
          created_at: string
          fields: Json
          form_key: string
          label: string
          recipient_email: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          fields?: Json
          form_key: string
          label?: string
          recipient_email?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          fields?: Json
          form_key?: string
          label?: string
          recipient_email?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      freemius_plans: {
        Row: {
          created_at: string
          id: string
          name: string
          product_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          product_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          product_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "freemius_plans_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      freemius_pricing: {
        Row: {
          api_annual_price: number | null
          api_lifetime_price: number | null
          api_monthly_price: number | null
          created_at: string
          id: string
          is_active: boolean
          license_quota: number | null
          override_annual_price: number | null
          override_lifetime_price: number | null
          override_monthly_price: number | null
          plan_id: string
          updated_at: string
        }
        Insert: {
          api_annual_price?: number | null
          api_lifetime_price?: number | null
          api_monthly_price?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          license_quota?: number | null
          override_annual_price?: number | null
          override_lifetime_price?: number | null
          override_monthly_price?: number | null
          plan_id: string
          updated_at?: string
        }
        Update: {
          api_annual_price?: number | null
          api_lifetime_price?: number | null
          api_monthly_price?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          license_quota?: number | null
          override_annual_price?: number | null
          override_lifetime_price?: number | null
          override_monthly_price?: number | null
          plan_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "freemius_pricing_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "freemius_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          created_at: string
          quantity: number
          sku: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          quantity?: number
          sku: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          quantity?: number
          sku?: string
          updated_at?: string
        }
        Relationships: []
      }
      languages: {
        Row: {
          code: string
          created_at: string
          id: number
          is_active: boolean | null
          is_default: boolean
          name: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: number
          is_active?: boolean | null
          is_default?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: number
          is_active?: boolean | null
          is_default?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      logos: {
        Row: {
          created_at: string
          id: string
          media_id: string | null
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          media_id?: string | null
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          media_id?: string | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "logos_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_access_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          token_hash: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes?: string[]
          token_hash: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string
          token_prefix?: string
        }
        Relationships: []
      }
      media: {
        Row: {
          blur_data_url: string | null
          created_at: string
          description: string | null
          file_name: string
          file_path: string | null
          file_type: string | null
          folder: string | null
          height: number | null
          id: string
          object_key: string
          size_bytes: number | null
          updated_at: string
          uploader_id: string | null
          variants: Json | null
          width: number | null
        }
        Insert: {
          blur_data_url?: string | null
          created_at?: string
          description?: string | null
          file_name: string
          file_path?: string | null
          file_type?: string | null
          folder?: string | null
          height?: number | null
          id?: string
          object_key: string
          size_bytes?: number | null
          updated_at?: string
          uploader_id?: string | null
          variants?: Json | null
          width?: number | null
        }
        Update: {
          blur_data_url?: string | null
          created_at?: string
          description?: string | null
          file_name?: string
          file_path?: string | null
          file_type?: string | null
          folder?: string | null
          height?: number | null
          id?: string
          object_key?: string
          size_bytes?: number | null
          updated_at?: string
          uploader_id?: string | null
          variants?: Json | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "media_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      message_threads: {
        Row: {
          created_at: string
          fields: Json
          form_key: string | null
          id: string
          ip_masked: string | null
          last_message_at: string
          locale: string | null
          sender_email: string | null
          sender_name: string | null
          source: string
          status: string
          subject_id: string | null
          subject_label: string
          token_expires_at: string | null
          token_hash: string | null
          token_last_used_at: string | null
          token_revoked_at: string | null
          unread_for_admin: boolean
          unread_for_visitor: boolean
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          fields?: Json
          form_key?: string | null
          id?: string
          ip_masked?: string | null
          last_message_at?: string
          locale?: string | null
          sender_email?: string | null
          sender_name?: string | null
          source: string
          status?: string
          subject_id?: string | null
          subject_label?: string
          token_expires_at?: string | null
          token_hash?: string | null
          token_last_used_at?: string | null
          token_revoked_at?: string | null
          unread_for_admin?: boolean
          unread_for_visitor?: boolean
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          fields?: Json
          form_key?: string | null
          id?: string
          ip_masked?: string | null
          last_message_at?: string
          locale?: string | null
          sender_email?: string | null
          sender_name?: string | null
          source?: string
          status?: string
          subject_id?: string | null
          subject_label?: string
          token_expires_at?: string | null
          token_hash?: string | null
          token_last_used_at?: string | null
          token_revoked_at?: string | null
          unread_for_admin?: boolean
          unread_for_visitor?: boolean
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      navigation_items: {
        Row: {
          created_at: string
          id: number
          label: string
          language_id: number
          menu_key: Database["public"]["Enums"]["menu_location"]
          order: number
          page_id: number | null
          parent_id: number | null
          translation_group_id: string
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          id?: number
          label: string
          language_id: number
          menu_key: Database["public"]["Enums"]["menu_location"]
          order?: number
          page_id?: number | null
          parent_id?: number | null
          translation_group_id?: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          id?: number
          label?: string
          language_id?: number
          menu_key?: Database["public"]["Enums"]["menu_location"]
          order?: number
          page_id?: number | null
          parent_id?: number | null
          translation_group_id?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "navigation_items_language_id_fkey"
            columns: ["language_id"]
            isOneToOne: false
            referencedRelation: "languages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "navigation_items_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "navigation_items_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "navigation_items"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          id: string
          order_id: string
          price_at_purchase: number
          product_id: string | null
          quantity: number
          variant_id: string | null
        }
        Insert: {
          id?: string
          order_id: string
          price_at_purchase: number
          product_id?: string | null
          quantity: number
          variant_id?: string | null
        }
        Update: {
          id?: string
          order_id?: string
          price_at_purchase?: number
          product_id?: string | null
          quantity?: number
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          coupon_code: string | null
          coupon_id: string | null
          created_at: string | null
          currency: string
          customer_details: Json | null
          discount_details: Json | null
          discount_total: number
          exchange_rate_at_purchase: number
          freemius_last_event_type: string | null
          freemius_last_synced_at: string | null
          freemius_license_id: string | null
          freemius_plan_id: string | null
          freemius_product_id: string | null
          freemius_subscription_id: string | null
          freemius_trial_ends_at: string | null
          freemius_trial_id: string | null
          freemius_user_id: string | null
          id: string
          inventory_deducted_at: string | null
          invoice_number: string | null
          paid_at: string | null
          payment_intent_id: string | null
          provider: string | null
          shipping_total: number | null
          status: string
          stripe_session_id: string | null
          subtotal: number | null
          tax_details: Json | null
          tax_total: number
          total: number
          user_id: string | null
        }
        Insert: {
          coupon_code?: string | null
          coupon_id?: string | null
          created_at?: string | null
          currency?: string
          customer_details?: Json | null
          discount_details?: Json | null
          discount_total?: number
          exchange_rate_at_purchase?: number
          freemius_last_event_type?: string | null
          freemius_last_synced_at?: string | null
          freemius_license_id?: string | null
          freemius_plan_id?: string | null
          freemius_product_id?: string | null
          freemius_subscription_id?: string | null
          freemius_trial_ends_at?: string | null
          freemius_trial_id?: string | null
          freemius_user_id?: string | null
          id?: string
          inventory_deducted_at?: string | null
          invoice_number?: string | null
          paid_at?: string | null
          payment_intent_id?: string | null
          provider?: string | null
          shipping_total?: number | null
          status?: string
          stripe_session_id?: string | null
          subtotal?: number | null
          tax_details?: Json | null
          tax_total?: number
          total: number
          user_id?: string | null
        }
        Update: {
          coupon_code?: string | null
          coupon_id?: string | null
          created_at?: string | null
          currency?: string
          customer_details?: Json | null
          discount_details?: Json | null
          discount_total?: number
          exchange_rate_at_purchase?: number
          freemius_last_event_type?: string | null
          freemius_last_synced_at?: string | null
          freemius_license_id?: string | null
          freemius_plan_id?: string | null
          freemius_product_id?: string | null
          freemius_subscription_id?: string | null
          freemius_trial_ends_at?: string | null
          freemius_trial_id?: string | null
          freemius_user_id?: string | null
          id?: string
          inventory_deducted_at?: string | null
          invoice_number?: string | null
          paid_at?: string | null
          payment_intent_id?: string | null
          provider?: string | null
          shipping_total?: number | null
          status?: string
          stripe_session_id?: string | null
          subtotal?: number | null
          tax_details?: Json | null
          tax_total?: number
          total?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
        ]
      }
      package_activations: {
        Row: {
          created_at: string | null
          id: string
          instance_name: string
          last_validated_at: string | null
          license_key: string
          meta: Json | null
          package_id: string
          status: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          instance_name: string
          last_validated_at?: string | null
          license_key: string
          meta?: Json | null
          package_id: string
          status?: string
        }
        Update: {
          created_at?: string | null
          id?: string
          instance_name?: string
          last_validated_at?: string | null
          license_key?: string
          meta?: Json | null
          package_id?: string
          status?: string
        }
        Relationships: []
      }
      page_revisions: {
        Row: {
          author_id: string | null
          content: Json
          created_at: string
          id: number
          page_id: number
          revision_type: Database["public"]["Enums"]["revision_type"]
          version: number
        }
        Insert: {
          author_id?: string | null
          content: Json
          created_at?: string
          id?: number
          page_id: number
          revision_type: Database["public"]["Enums"]["revision_type"]
          version: number
        }
        Update: {
          author_id?: string | null
          content?: Json
          created_at?: string
          id?: number
          page_id?: number
          revision_type?: Database["public"]["Enums"]["revision_type"]
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "page_revisions_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "page_revisions_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          author_id: string | null
          created_at: string
          custom_canonical: string | null
          feature_image_id: string | null
          id: number
          language_id: number
          meta_description: string | null
          meta_title: string | null
          published_at: string | null
          slug: string
          status: Database["public"]["Enums"]["page_status"]
          title: string
          translation_group_id: string
          updated_at: string
          version: number
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          custom_canonical?: string | null
          feature_image_id?: string | null
          id?: number
          language_id: number
          meta_description?: string | null
          meta_title?: string | null
          published_at?: string | null
          slug: string
          status?: Database["public"]["Enums"]["page_status"]
          title: string
          translation_group_id?: string
          updated_at?: string
          version?: number
        }
        Update: {
          author_id?: string | null
          created_at?: string
          custom_canonical?: string | null
          feature_image_id?: string | null
          id?: number
          language_id?: number
          meta_description?: string | null
          meta_title?: string | null
          published_at?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["page_status"]
          title?: string
          translation_group_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "pages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pages_feature_image_id_fkey"
            columns: ["feature_image_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pages_language_id_fkey"
            columns: ["language_id"]
            isOneToOne: false
            referencedRelation: "languages"
            referencedColumns: ["id"]
          },
        ]
      }
      post_revisions: {
        Row: {
          author_id: string | null
          content: Json
          created_at: string
          id: number
          post_id: number
          revision_type: Database["public"]["Enums"]["revision_type"]
          version: number
        }
        Insert: {
          author_id?: string | null
          content: Json
          created_at?: string
          id?: number
          post_id: number
          revision_type: Database["public"]["Enums"]["revision_type"]
          version: number
        }
        Update: {
          author_id?: string | null
          content?: Json
          created_at?: string
          id?: number
          post_id?: number
          revision_type?: Database["public"]["Enums"]["revision_type"]
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_revisions_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_revisions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          author_id: string | null
          created_at: string
          custom_canonical: string | null
          excerpt: string | null
          feature_image_id: string | null
          id: number
          label: string | null
          language_id: number
          meta_description: string | null
          meta_title: string | null
          published_at: string | null
          slug: string
          status: Database["public"]["Enums"]["page_status"]
          subtitle: string | null
          title: string
          translation_group_id: string
          updated_at: string
          version: number
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          custom_canonical?: string | null
          excerpt?: string | null
          feature_image_id?: string | null
          id?: number
          label?: string | null
          language_id: number
          meta_description?: string | null
          meta_title?: string | null
          published_at?: string | null
          slug: string
          status?: Database["public"]["Enums"]["page_status"]
          subtitle?: string | null
          title: string
          translation_group_id?: string
          updated_at?: string
          version?: number
        }
        Update: {
          author_id?: string | null
          created_at?: string
          custom_canonical?: string | null
          excerpt?: string | null
          feature_image_id?: string | null
          id?: number
          label?: string | null
          language_id?: number
          meta_description?: string | null
          meta_title?: string | null
          published_at?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["page_status"]
          subtitle?: string | null
          title?: string
          translation_group_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_feature_image_id_fkey"
            columns: ["feature_image_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_language_id_fkey"
            columns: ["language_id"]
            isOneToOne: false
            referencedRelation: "languages"
            referencedColumns: ["id"]
          },
        ]
      }
      privacy_consent_logs: {
        Row: {
          categories: Json
          consent_token: string
          created_at: string
          id: string
          ip_masked: string | null
          user_agent: string | null
        }
        Insert: {
          categories?: Json
          consent_token: string
          created_at?: string
          id?: string
          ip_masked?: string | null
          user_agent?: string | null
        }
        Update: {
          categories?: Json
          consent_token?: string
          created_at?: string
          id?: string
          ip_masked?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      product_attribute_terms: {
        Row: {
          attribute_id: string
          created_at: string | null
          id: string
          slug: string
          sort_order: number
          updated_at: string | null
          value: string
          value_translations: Json
        }
        Insert: {
          attribute_id: string
          created_at?: string | null
          id?: string
          slug: string
          sort_order?: number
          updated_at?: string | null
          value: string
          value_translations?: Json
        }
        Update: {
          attribute_id?: string
          created_at?: string | null
          id?: string
          slug?: string
          sort_order?: number
          updated_at?: string | null
          value?: string
          value_translations?: Json
        }
        Relationships: [
          {
            foreignKeyName: "product_attribute_terms_attribute_id_fkey"
            columns: ["attribute_id"]
            isOneToOne: false
            referencedRelation: "product_attributes"
            referencedColumns: ["id"]
          },
        ]
      }
      product_attributes: {
        Row: {
          created_at: string | null
          id: string
          name: string
          name_translations: Json
          slug: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          name: string
          name_translations?: Json
          slug: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
          name_translations?: Json
          slug?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      product_categories: {
        Row: {
          category_id: string
          product_id: string
        }
        Insert: {
          category_id: string
          product_id: string
        }
        Update: {
          category_id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_categories_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_drafts: {
        Row: {
          author_id: string | null
          blocks: Json
          created_at: string
          id: number
          meta: Json
          product_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          blocks?: Json
          created_at?: string
          id?: number
          meta?: Json
          product_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          blocks?: Json
          created_at?: string
          id?: number
          meta?: Json
          product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_drafts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_drafts_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_freemius_sale_coupons: {
        Row: {
          created_at: string
          discount_percent: number | null
          ends_at: string | null
          freemius_coupon_code: string
          freemius_coupon_id: string | null
          freemius_plan_id: string | null
          freemius_product_id: string
          id: string
          is_active: boolean
          last_synced_at: string | null
          product_id: string
          remote_payload: Json | null
          starts_at: string | null
          sync_error: string | null
          sync_status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          discount_percent?: number | null
          ends_at?: string | null
          freemius_coupon_code: string
          freemius_coupon_id?: string | null
          freemius_plan_id?: string | null
          freemius_product_id: string
          id?: string
          is_active?: boolean
          last_synced_at?: string | null
          product_id: string
          remote_payload?: Json | null
          starts_at?: string | null
          sync_error?: string | null
          sync_status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          discount_percent?: number | null
          ends_at?: string | null
          freemius_coupon_code?: string
          freemius_coupon_id?: string | null
          freemius_plan_id?: string | null
          freemius_product_id?: string
          id?: string
          is_active?: boolean
          last_synced_at?: string | null
          product_id?: string
          remote_payload?: Json | null
          starts_at?: string | null
          sync_error?: string | null
          sync_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_freemius_sale_coupons_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_inquiries: {
        Row: {
          created_at: string
          email_delivered: boolean
          id: string
          ip_masked: string | null
          is_resolved: boolean
          locale: string | null
          message: string
          product_id: string | null
          product_slug: string | null
          product_title: string | null
          sender_email: string
          sender_name: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          email_delivered?: boolean
          id?: string
          ip_masked?: string | null
          is_resolved?: boolean
          locale?: string | null
          message: string
          product_id?: string | null
          product_slug?: string | null
          product_title?: string | null
          sender_email: string
          sender_name: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          email_delivered?: boolean
          id?: string
          ip_masked?: string | null
          is_resolved?: boolean
          locale?: string | null
          message?: string
          product_id?: string | null
          product_slug?: string | null
          product_title?: string | null
          sender_email?: string
          sender_name?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      product_media: {
        Row: {
          media_id: string
          product_id: string
          sort_order: number | null
        }
        Insert: {
          media_id: string
          product_id: string
          sort_order?: number | null
        }
        Update: {
          media_id?: string
          product_id?: string
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_media_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_media_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_revisions: {
        Row: {
          author_id: string | null
          content: Json
          created_at: string
          id: number
          product_id: string
          revision_type: Database["public"]["Enums"]["revision_type"]
          version: number
        }
        Insert: {
          author_id?: string | null
          content: Json
          created_at?: string
          id?: number
          product_id: string
          revision_type: Database["public"]["Enums"]["revision_type"]
          version: number
        }
        Update: {
          author_id?: string | null
          content?: Json
          created_at?: string
          id?: number
          product_id?: string
          revision_type?: Database["public"]["Enums"]["revision_type"]
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_revisions_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_revisions_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_variants: {
        Row: {
          created_at: string | null
          id: string
          main_media_id: string | null
          price: number
          price_adjustment: number
          prices: Json
          product_id: string
          sale_end_at: string | null
          sale_price: number | null
          sale_prices: Json | null
          sale_start_at: string | null
          scheduled_price: number | null
          scheduled_price_at: string | null
          scheduled_prices: Json | null
          sku: string
          stock_quantity: number
          upc: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          main_media_id?: string | null
          price?: number
          price_adjustment?: number
          prices?: Json
          product_id: string
          sale_end_at?: string | null
          sale_price?: number | null
          sale_prices?: Json | null
          sale_start_at?: string | null
          scheduled_price?: number | null
          scheduled_price_at?: string | null
          scheduled_prices?: Json | null
          sku: string
          stock_quantity?: number
          upc?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          main_media_id?: string | null
          price?: number
          price_adjustment?: number
          prices?: Json
          product_id?: string
          sale_end_at?: string | null
          sale_price?: number | null
          sale_prices?: Json | null
          sale_start_at?: string | null
          scheduled_price?: number | null
          scheduled_price_at?: string | null
          scheduled_prices?: Json | null
          sku?: string
          stock_quantity?: number
          upc?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_main_media_id_fkey"
            columns: ["main_media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          average_rating: number
          created_at: string | null
          custom_canonical: string | null
          description_json: Json | null
          freemius_plan_id: string | null
          freemius_product_id: string | null
          id: string
          is_taxable: boolean
          language_id: number
          meta_description: string | null
          meta_title: string | null
          metadata: Json | null
          payment_provider: string
          price: number
          prices: Json
          product_type: string
          published_at: string | null
          sale_end_at: string | null
          sale_price: number | null
          sale_prices: Json | null
          sale_start_at: string | null
          scheduled_price: number | null
          scheduled_price_at: string | null
          scheduled_prices: Json | null
          short_description: string | null
          sku: string
          slug: string
          status: string
          stock: number | null
          title: string
          total_reviews: number
          translation_group_id: string
          trial_period_days: number
          trial_requires_payment_method: boolean
          upc: string | null
          updated_at: string | null
          version: number
        }
        Insert: {
          average_rating?: number
          created_at?: string | null
          custom_canonical?: string | null
          description_json?: Json | null
          freemius_plan_id?: string | null
          freemius_product_id?: string | null
          id?: string
          is_taxable?: boolean
          language_id: number
          meta_description?: string | null
          meta_title?: string | null
          metadata?: Json | null
          payment_provider: string
          price: number
          prices?: Json
          product_type: string
          published_at?: string | null
          sale_end_at?: string | null
          sale_price?: number | null
          sale_prices?: Json | null
          sale_start_at?: string | null
          scheduled_price?: number | null
          scheduled_price_at?: string | null
          scheduled_prices?: Json | null
          short_description?: string | null
          sku: string
          slug: string
          status?: string
          stock?: number | null
          title: string
          total_reviews?: number
          translation_group_id?: string
          trial_period_days?: number
          trial_requires_payment_method?: boolean
          upc?: string | null
          updated_at?: string | null
          version?: number
        }
        Update: {
          average_rating?: number
          created_at?: string | null
          custom_canonical?: string | null
          description_json?: Json | null
          freemius_plan_id?: string | null
          freemius_product_id?: string | null
          id?: string
          is_taxable?: boolean
          language_id?: number
          meta_description?: string | null
          meta_title?: string | null
          metadata?: Json | null
          payment_provider?: string
          price?: number
          prices?: Json
          product_type?: string
          published_at?: string | null
          sale_end_at?: string | null
          sale_price?: number | null
          sale_prices?: Json | null
          sale_start_at?: string | null
          scheduled_price?: number | null
          scheduled_price_at?: string | null
          scheduled_prices?: Json | null
          short_description?: string | null
          sku?: string
          slug?: string
          status?: string
          stock?: number | null
          title?: string
          total_reviews?: number
          translation_group_id?: string
          trial_period_days?: number
          trial_requires_payment_method?: boolean
          upc?: string | null
          updated_at?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "products_language_id_fkey"
            columns: ["language_id"]
            isOneToOne: false
            referencedRelation: "languages"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          full_name: string | null
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string | null
          website: string | null
        }
        Insert: {
          avatar_url?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          avatar_url?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string | null
          website?: string | null
        }
        Relationships: []
      }
      shipping_zone_locations: {
        Row: {
          country_code: string
          created_at: string | null
          id: string
          postal_code: string | null
          state_code: string | null
          zone_id: string
        }
        Insert: {
          country_code: string
          created_at?: string | null
          id?: string
          postal_code?: string | null
          state_code?: string | null
          zone_id: string
        }
        Update: {
          country_code?: string
          created_at?: string | null
          id?: string
          postal_code?: string | null
          state_code?: string | null
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipping_zone_locations_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "shipping_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      shipping_zone_methods: {
        Row: {
          cost_amount: number
          cost_amounts: Json
          cost_currency: string
          created_at: string | null
          currency_pricing_mode: string
          id: string
          method_type: string
          min_order_amount: number
          min_order_amounts: Json
          name: string
          name_translations: Json
          updated_at: string | null
          zone_id: string
        }
        Insert: {
          cost_amount?: number
          cost_amounts?: Json
          cost_currency?: string
          created_at?: string | null
          currency_pricing_mode?: string
          id?: string
          method_type: string
          min_order_amount?: number
          min_order_amounts?: Json
          name: string
          name_translations?: Json
          updated_at?: string | null
          zone_id: string
        }
        Update: {
          cost_amount?: number
          cost_amounts?: Json
          cost_currency?: string
          created_at?: string | null
          currency_pricing_mode?: string
          id?: string
          method_type?: string
          min_order_amount?: number
          min_order_amounts?: Json
          name?: string
          name_translations?: Json
          updated_at?: string | null
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipping_zone_methods_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "shipping_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      shipping_zones: {
        Row: {
          created_at: string | null
          id: string
          name: string
          priority_order: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          name: string
          priority_order?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
          priority_order?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      site_script_revisions: {
        Row: {
          actor_user_id: string | null
          created_at: string
          id: string
          revision_type: string
          script_id: string | null
          script_name: string
          snapshot: Json
          source: string
          summary: string | null
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          id?: string
          revision_type: string
          script_id?: string | null
          script_name: string
          snapshot: Json
          source?: string
          summary?: string | null
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          id?: string
          revision_type?: string
          script_id?: string | null
          script_name?: string
          snapshot?: Json
          source?: string
          summary?: string | null
        }
        Relationships: []
      }
      site_scripts: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          load_strategy: string
          name: string
          placement: string
          sort_order: number
          src: string | null
          updated_at: string
        }
        Insert: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          load_strategy?: string
          name: string
          placement?: string
          sort_order?: number
          src?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          load_strategy?: string
          name?: string
          placement?: string
          sort_order?: number
          src?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      site_settings: {
        Row: {
          key: string
          value: Json | null
        }
        Insert: {
          key: string
          value?: Json | null
        }
        Update: {
          key?: string
          value?: Json | null
        }
        Relationships: []
      }
      site_themes: {
        Row: {
          color_scheme: string
          created_at: string
          description: string | null
          extra_css: string | null
          icon: string
          id: string
          is_active: boolean
          is_default: boolean
          is_system: boolean
          name: string
          slug: string
          sort_order: number
          tokens: Json
          updated_at: string
        }
        Insert: {
          color_scheme?: string
          created_at?: string
          description?: string | null
          extra_css?: string | null
          icon?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          is_system?: boolean
          name: string
          slug: string
          sort_order?: number
          tokens?: Json
          updated_at?: string
        }
        Update: {
          color_scheme?: string
          created_at?: string
          description?: string | null
          extra_css?: string | null
          icon?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          is_system?: boolean
          name?: string
          slug?: string
          sort_order?: number
          tokens?: Json
          updated_at?: string
        }
        Relationships: []
      }
      system_alerts: {
        Row: {
          alert_type: string
          created_at: string
          id: string
          is_resolved: boolean
          message: string
          metadata: Json
          resolved_at: string | null
          title: string
          updated_at: string
        }
        Insert: {
          alert_type: string
          created_at?: string
          id?: string
          is_resolved?: boolean
          message: string
          metadata?: Json
          resolved_at?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          alert_type?: string
          created_at?: string
          id?: string
          is_resolved?: boolean
          message?: string
          metadata?: Json
          resolved_at?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      system_configuration: {
        Row: {
          auto_accept_signups: boolean
          id: number
          settings: Json
          updated_at: string
        }
        Insert: {
          auto_accept_signups?: boolean
          id?: number
          settings?: Json
          updated_at?: string
        }
        Update: {
          auto_accept_signups?: boolean
          id?: number
          settings?: Json
          updated_at?: string
        }
        Relationships: []
      }
      tax_rates: {
        Row: {
          country_code: string
          created_at: string
          id: string
          state_code: string | null
          tax_name: string
          tax_rate: number
          updated_at: string
        }
        Insert: {
          country_code: string
          created_at?: string
          id?: string
          state_code?: string | null
          tax_name: string
          tax_rate: number
          updated_at?: string
        }
        Update: {
          country_code?: string
          created_at?: string
          id?: string
          state_code?: string | null
          tax_name?: string
          tax_rate?: number
          updated_at?: string
        }
        Relationships: []
      }
      thread_messages: {
        Row: {
          author_id: string | null
          author_name: string | null
          body: string
          created_at: string
          direction: string
          email_delivered: boolean
          email_error: string | null
          id: string
          ip_masked: string | null
          thread_id: string
        }
        Insert: {
          author_id?: string | null
          author_name?: string | null
          body: string
          created_at?: string
          direction: string
          email_delivered?: boolean
          email_error?: string | null
          id?: string
          ip_masked?: string | null
          thread_id: string
        }
        Update: {
          author_id?: string | null
          author_name?: string | null
          body?: string
          created_at?: string
          direction?: string
          email_delivered?: boolean
          email_error?: string | null
          id?: string
          ip_masked?: string | null
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "message_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      translations: {
        Row: {
          created_at: string
          key: string
          translations: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          key: string
          translations: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          key?: string
          translations?: Json
          updated_at?: string
        }
        Relationships: []
      }
      ucp_cart_sessions: {
        Row: {
          attribution: Json
          buyer_identity: Json
          checkout_url: string | null
          context: Json
          created_at: string
          currency: string
          expires_at: string
          id: string
          line_items: Json
          locale: string | null
          metadata: Json
          signals: Json
          status: string
          totals: Json
          updated_at: string
        }
        Insert: {
          attribution?: Json
          buyer_identity?: Json
          checkout_url?: string | null
          context?: Json
          created_at?: string
          currency?: string
          expires_at?: string
          id?: string
          line_items?: Json
          locale?: string | null
          metadata?: Json
          signals?: Json
          status?: string
          totals?: Json
          updated_at?: string
        }
        Update: {
          attribution?: Json
          buyer_identity?: Json
          checkout_url?: string | null
          context?: Json
          created_at?: string
          currency?: string
          expires_at?: string
          id?: string
          line_items?: Json
          locale?: string | null
          metadata?: Json
          signals?: Json
          status?: string
          totals?: Json
          updated_at?: string
        }
        Relationships: []
      }
      user_addresses: {
        Row: {
          address_type: string
          city: string | null
          company_name: string | null
          country_code: string | null
          created_at: string
          id: string
          is_default: boolean
          line1: string | null
          line2: string | null
          postal_code: string | null
          recipient_name: string | null
          state: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address_type: string
          city?: string | null
          company_name?: string | null
          country_code?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          line1?: string | null
          line2?: string | null
          postal_code?: string | null
          recipient_name?: string | null
          state?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address_type?: string
          city?: string | null
          company_name?: string | null
          country_code?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          line1?: string | null
          line2?: string | null
          postal_code?: string | null
          recipient_name?: string | null
          state?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_addresses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_security_settings: {
        Row: {
          mfa_enabled: boolean
          mfa_type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          mfa_enabled?: boolean
          mfa_type?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          mfa_enabled?: boolean
          mfa_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_trusted_devices: {
        Row: {
          browser_metadata: string | null
          created_at: string
          device_hash: string
          expires_at: string
          id: string
          user_id: string
        }
        Insert: {
          browser_metadata?: string | null
          created_at?: string
          device_hash: string
          expires_at: string
          id?: string
          user_id: string
        }
        Update: {
          browser_metadata?: string | null
          created_at?: string
          device_hash?: string
          expires_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      variant_attribute_mapping: {
        Row: {
          attribute_term_id: string
          variant_id: string
        }
        Insert: {
          attribute_term_id: string
          variant_id: string
        }
        Update: {
          attribute_term_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "variant_attribute_mapping_attribute_term_id_fkey"
            columns: ["attribute_term_id"]
            isOneToOne: false
            referencedRelation: "product_attribute_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "variant_attribute_mapping_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_order_inventory_deduction: {
        Args: { p_order_id: string }
        Returns: undefined
      }
      assign_order_invoice_metadata: {
        Args: { p_order_id: string; p_paid_at?: string }
        Returns: {
          invoice_number: string
          paid_at: string
        }[]
      }
      clear_currency_price_overrides: {
        Args: { target_currency: string }
        Returns: undefined
      }
      duplicate_block_definition: {
        Args: { target_id: string }
        Returns: {
          description: string
          fields: Json
          id: string
          is_original: boolean
          layout_schema: Json
          name: string
          slug: string
        }
        SetofOptions: {
          from: "*"
          to: "custom_block_definitions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      format_order_invoice_number: {
        Args: { p_value: number }
        Returns: string
      }
      generate_order_invoice_number: { Args: never; Returns: string }
      get_current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      get_default_currency_code: { Args: never; Returns: string }
      get_ecommerce_track_quantities: { Args: never; Returns: boolean }
      get_my_claim: { Args: { claim: string }; Returns: Json }
      is_admin: { Args: never; Returns: boolean }
      is_valid_currency_amount_map: {
        Args: { amounts: Json }
        Returns: boolean
      }
      is_valid_custom_block_fields: {
        Args: { candidate: Json }
        Returns: boolean
      }
      is_valid_custom_block_layout_schema: {
        Args: { candidate: Json }
        Returns: boolean
      }
      is_valid_sale_price_map: {
        Args: { prices: Json; sale_prices: Json }
        Returns: boolean
      }
      normalize_currency_amount_map: { Args: { amounts: Json }; Returns: Json }
      sync_inventory_cache_for_sku: {
        Args: { p_sku: string }
        Returns: undefined
      }
      sync_legacy_price_columns_for_currency: {
        Args: { target_currency: string }
        Returns: undefined
      }
      upsert_product_with_variants: {
        Args: { product_payload: Json }
        Returns: string
      }
    }
    Enums: {
      approval_status: "pending" | "approved" | "denied"
      interaction_type: "review" | "comment"
      menu_location: "HEADER" | "FOOTER" | "SIDEBAR"
      page_status: "draft" | "published" | "archived"
      revision_type: "snapshot" | "diff"
      user_role: "ADMIN" | "WRITER" | "USER"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      approval_status: ["pending", "approved", "denied"],
      interaction_type: ["review", "comment"],
      menu_location: ["HEADER", "FOOTER", "SIDEBAR"],
      page_status: ["draft", "published", "archived"],
      revision_type: ["snapshot", "diff"],
      user_role: ["ADMIN", "WRITER", "USER"],
    },
  },
} as const
