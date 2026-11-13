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
      affiliate_click_events: {
        Row: {
          affiliate_id: string
          created_at: string
          id: string
          visitor_hash: string
        }
        Insert: {
          affiliate_id: string
          created_at?: string
          id?: string
          visitor_hash: string
        }
        Update: {
          affiliate_id?: string
          created_at?: string
          id?: string
          visitor_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "affiliate_click_events_affiliate_id_fkey"
            columns: ["affiliate_id"]
            isOneToOne: false
            referencedRelation: "affiliate_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      affiliate_commissions: {
        Row: {
          affiliate_id: string
          cleared_at: string | null
          clears_at: string
          commission_amount_cents: number
          commission_rate_snapshot: number
          created_at: string
          currency: string
          disputed_at: string | null
          exchange_rate_snapshot: number
          gateway: Database["public"]["Enums"]["affiliate_gateway"]
          id: string
          livemode: boolean
          net_order_amount_cents: number
          notified_at: string | null
          order_currency: string
          order_id: string | null
          order_net_amount_minor: number
          paid_at: string | null
          payout_id: string | null
          refund_pending_cents: number
          refunded_amount_cents: number
          status: Database["public"]["Enums"]["affiliate_commission_status"]
          stripe_transfer_id: string | null
          updated_at: string
          void_reason: string | null
          void_requested_at: string | null
          voided_at: string | null
        }
        Insert: {
          affiliate_id: string
          cleared_at?: string | null
          clears_at?: string
          commission_amount_cents: number
          commission_rate_snapshot: number
          created_at?: string
          currency?: string
          disputed_at?: string | null
          exchange_rate_snapshot?: number
          gateway: Database["public"]["Enums"]["affiliate_gateway"]
          id?: string
          livemode?: boolean
          net_order_amount_cents: number
          notified_at?: string | null
          order_currency: string
          order_id?: string | null
          order_net_amount_minor: number
          paid_at?: string | null
          payout_id?: string | null
          refund_pending_cents?: number
          refunded_amount_cents?: number
          status?: Database["public"]["Enums"]["affiliate_commission_status"]
          stripe_transfer_id?: string | null
          updated_at?: string
          void_reason?: string | null
          void_requested_at?: string | null
          voided_at?: string | null
        }
        Update: {
          affiliate_id?: string
          cleared_at?: string | null
          clears_at?: string
          commission_amount_cents?: number
          commission_rate_snapshot?: number
          created_at?: string
          currency?: string
          disputed_at?: string | null
          exchange_rate_snapshot?: number
          gateway?: Database["public"]["Enums"]["affiliate_gateway"]
          id?: string
          livemode?: boolean
          net_order_amount_cents?: number
          notified_at?: string | null
          order_currency?: string
          order_id?: string | null
          order_net_amount_minor?: number
          paid_at?: string | null
          payout_id?: string | null
          refund_pending_cents?: number
          refunded_amount_cents?: number
          status?: Database["public"]["Enums"]["affiliate_commission_status"]
          stripe_transfer_id?: string | null
          updated_at?: string
          void_reason?: string | null
          void_requested_at?: string | null
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "affiliate_commissions_affiliate_id_fkey"
            columns: ["affiliate_id"]
            isOneToOne: false
            referencedRelation: "affiliate_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "affiliate_commissions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "affiliate_commissions_payout_id_fkey"
            columns: ["payout_id"]
            isOneToOne: false
            referencedRelation: "affiliate_payouts"
            referencedColumns: ["id"]
          },
        ]
      }
      affiliate_pages: {
        Row: {
          admin_feedback_note: string | null
          affiliate_id: string
          approval_status: Database["public"]["Enums"]["affiliate_page_status"]
          created_at: string
          draft_content: Json
          draft_updated_at: string
          draft_version: number
          featured_product_ids: string[]
          id: string
          meta_description: string
          published_at: string | null
          published_content: Json | null
          published_featured_product_ids: string[]
          published_meta_description: string | null
          published_profile: Json | null
          published_title: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          submitted_at: string | null
          submitted_version: number | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_feedback_note?: string | null
          affiliate_id: string
          approval_status?: Database["public"]["Enums"]["affiliate_page_status"]
          created_at?: string
          draft_content?: Json
          draft_updated_at?: string
          draft_version?: number
          featured_product_ids?: string[]
          id?: string
          meta_description?: string
          published_at?: string | null
          published_content?: Json | null
          published_featured_product_ids?: string[]
          published_meta_description?: string | null
          published_profile?: Json | null
          published_title?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          submitted_at?: string | null
          submitted_version?: number | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_feedback_note?: string | null
          affiliate_id?: string
          approval_status?: Database["public"]["Enums"]["affiliate_page_status"]
          created_at?: string
          draft_content?: Json
          draft_updated_at?: string
          draft_version?: number
          featured_product_ids?: string[]
          id?: string
          meta_description?: string
          published_at?: string | null
          published_content?: Json | null
          published_featured_product_ids?: string[]
          published_meta_description?: string | null
          published_profile?: Json | null
          published_title?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          submitted_at?: string | null
          submitted_version?: number | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "affiliate_pages_affiliate_owner_fkey"
            columns: ["affiliate_id", "user_id"]
            isOneToOne: false
            referencedRelation: "affiliate_profiles"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      affiliate_payout_runs: {
        Row: {
          finished_at: string | null
          run_date: string
          started_at: string
          summary: Json
          trigger: string
        }
        Insert: {
          finished_at?: string | null
          run_date: string
          started_at?: string
          summary?: Json
          trigger: string
        }
        Update: {
          finished_at?: string | null
          run_date?: string
          started_at?: string
          summary?: Json
          trigger?: string
        }
        Relationships: []
      }
      affiliate_payouts: {
        Row: {
          affiliate_id: string
          amount_cents: number
          attempt_count: number
          created_at: string
          currency: string
          external_reference: string | null
          failure_reason: string | null
          id: string
          last_attempt_at: string
          livemode: boolean
          manual_channel: string | null
          method: string
          note: string | null
          paid_at: string | null
          paypal_batch_id: string | null
          paypal_checked_at: string | null
          paypal_fee_cents: number | null
          paypal_item_id: string | null
          paypal_item_status: string | null
          paypal_receiver: string | null
          paypal_sender_batch_id: string | null
          paypal_transaction_id: string | null
          recorded_by: string | null
          status: Database["public"]["Enums"]["affiliate_payout_status"]
          stripe_destination_account: string | null
          stripe_transfer_id: string | null
          trigger: string
          updated_at: string
        }
        Insert: {
          affiliate_id: string
          amount_cents: number
          attempt_count?: number
          created_at?: string
          currency: string
          external_reference?: string | null
          failure_reason?: string | null
          id?: string
          last_attempt_at?: string
          livemode?: boolean
          manual_channel?: string | null
          method?: string
          note?: string | null
          paid_at?: string | null
          paypal_batch_id?: string | null
          paypal_checked_at?: string | null
          paypal_fee_cents?: number | null
          paypal_item_id?: string | null
          paypal_item_status?: string | null
          paypal_receiver?: string | null
          paypal_sender_batch_id?: string | null
          paypal_transaction_id?: string | null
          recorded_by?: string | null
          status?: Database["public"]["Enums"]["affiliate_payout_status"]
          stripe_destination_account?: string | null
          stripe_transfer_id?: string | null
          trigger?: string
          updated_at?: string
        }
        Update: {
          affiliate_id?: string
          amount_cents?: number
          attempt_count?: number
          created_at?: string
          currency?: string
          external_reference?: string | null
          failure_reason?: string | null
          id?: string
          last_attempt_at?: string
          livemode?: boolean
          manual_channel?: string | null
          method?: string
          note?: string | null
          paid_at?: string | null
          paypal_batch_id?: string | null
          paypal_checked_at?: string | null
          paypal_fee_cents?: number | null
          paypal_item_id?: string | null
          paypal_item_status?: string | null
          paypal_receiver?: string | null
          paypal_sender_batch_id?: string | null
          paypal_transaction_id?: string | null
          recorded_by?: string | null
          status?: Database["public"]["Enums"]["affiliate_payout_status"]
          stripe_destination_account?: string | null
          stripe_transfer_id?: string | null
          trigger?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "affiliate_payouts_affiliate_id_fkey"
            columns: ["affiliate_id"]
            isOneToOne: false
            referencedRelation: "affiliate_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      affiliate_profiles: {
        Row: {
          avatar_object_key: string | null
          bio: string | null
          created_at: string
          display_name: string
          first_published_at: string | null
          handle: string
          id: string
          last_click_at: string | null
          onboarding_step: Database["public"]["Enums"]["affiliate_onboarding_step"]
          page_submitted_at: string | null
          payout_configured_at: string | null
          payout_email: string | null
          payout_email_kind: string
          payout_email_saved_at: string | null
          preferred_locale: string
          profile_completed_at: string | null
          signup_ip_masked: string | null
          social_links: Json
          status: Database["public"]["Enums"]["affiliate_status"]
          stripe_connect_account_id: string | null
          stripe_connect_checked_at: string | null
          stripe_connect_details_submitted: boolean
          stripe_connect_livemode: boolean | null
          stripe_connect_onboarding_complete: boolean
          stripe_connect_payouts_enabled: boolean
          suspended_reason: string | null
          tier_changed_at: string | null
          tier_id: string
          total_clicks: number
          total_earned_cents: number
          total_paid_cents: number
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_object_key?: string | null
          bio?: string | null
          created_at?: string
          display_name: string
          first_published_at?: string | null
          handle: string
          id?: string
          last_click_at?: string | null
          onboarding_step?: Database["public"]["Enums"]["affiliate_onboarding_step"]
          page_submitted_at?: string | null
          payout_configured_at?: string | null
          payout_email?: string | null
          payout_email_kind?: string
          payout_email_saved_at?: string | null
          preferred_locale?: string
          profile_completed_at?: string | null
          signup_ip_masked?: string | null
          social_links?: Json
          status?: Database["public"]["Enums"]["affiliate_status"]
          stripe_connect_account_id?: string | null
          stripe_connect_checked_at?: string | null
          stripe_connect_details_submitted?: boolean
          stripe_connect_livemode?: boolean | null
          stripe_connect_onboarding_complete?: boolean
          stripe_connect_payouts_enabled?: boolean
          suspended_reason?: string | null
          tier_changed_at?: string | null
          tier_id: string
          total_clicks?: number
          total_earned_cents?: number
          total_paid_cents?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_object_key?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string
          first_published_at?: string | null
          handle?: string
          id?: string
          last_click_at?: string | null
          onboarding_step?: Database["public"]["Enums"]["affiliate_onboarding_step"]
          page_submitted_at?: string | null
          payout_configured_at?: string | null
          payout_email?: string | null
          payout_email_kind?: string
          payout_email_saved_at?: string | null
          preferred_locale?: string
          profile_completed_at?: string | null
          signup_ip_masked?: string | null
          social_links?: Json
          status?: Database["public"]["Enums"]["affiliate_status"]
          stripe_connect_account_id?: string | null
          stripe_connect_checked_at?: string | null
          stripe_connect_details_submitted?: boolean
          stripe_connect_livemode?: boolean | null
          stripe_connect_onboarding_complete?: boolean
          stripe_connect_payouts_enabled?: boolean
          suspended_reason?: string | null
          tier_changed_at?: string | null
          tier_id?: string
          total_clicks?: number
          total_earned_cents?: number
          total_paid_cents?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "affiliate_profiles_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "affiliate_tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      affiliate_tiers: {
        Row: {
          badge_color: string
          clearance_hold_days: number
          commission_percentage: number
          cookie_duration_days: number
          created_at: string
          goal: string | null
          goal_translations: Json
          id: string
          is_active: boolean
          is_default_signup_tier: boolean
          is_limited_time_promo: boolean
          max_ambassadors_cap: number | null
          member_count: number
          name: string
          name_translations: Json
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          badge_color?: string
          clearance_hold_days?: number
          commission_percentage: number
          cookie_duration_days?: number
          created_at?: string
          goal?: string | null
          goal_translations?: Json
          id?: string
          is_active?: boolean
          is_default_signup_tier?: boolean
          is_limited_time_promo?: boolean
          max_ambassadors_cap?: number | null
          member_count?: number
          name: string
          name_translations?: Json
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          badge_color?: string
          clearance_hold_days?: number
          commission_percentage?: number
          cookie_duration_days?: number
          created_at?: string
          goal?: string | null
          goal_translations?: Json
          id?: string
          is_active?: boolean
          is_default_signup_tier?: boolean
          is_limited_time_promo?: boolean
          max_ambassadors_cap?: number | null
          member_count?: number
          name?: string
          name_translations?: Json
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
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
          author: {
            avatar_url: string | null
            full_name: string | null
            id: string | null
          } | null
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
            referencedRelation: "profile_cards"
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cortex_ai_db_mutation_audit_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cortex_request_log: {
        Row: {
          created_at: string
          id: string
          route: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          route: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          route?: string
          user_id?: string
        }
        Relationships: []
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
          attempts: number
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          token_hash: string
          user_id: string
        }
        Insert: {
          attempts?: number
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          token_hash: string
          user_id: string
        }
        Update: {
          attempts?: number
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
          affiliate_base_currency: string | null
          affiliate_clearance_hold_days: number | null
          affiliate_commission_rate: number | null
          affiliate_disputed_at: string | null
          affiliate_id: string | null
          affiliate_livemode: boolean | null
          affiliate_refund_total_minor: number | null
          affiliate_refunded_minor: number | null
          affiliate_source: string | null
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
          affiliate_base_currency?: string | null
          affiliate_clearance_hold_days?: number | null
          affiliate_commission_rate?: number | null
          affiliate_disputed_at?: string | null
          affiliate_id?: string | null
          affiliate_livemode?: boolean | null
          affiliate_refund_total_minor?: number | null
          affiliate_refunded_minor?: number | null
          affiliate_source?: string | null
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
          affiliate_base_currency?: string | null
          affiliate_clearance_hold_days?: number | null
          affiliate_commission_rate?: number | null
          affiliate_disputed_at?: string | null
          affiliate_id?: string | null
          affiliate_livemode?: boolean | null
          affiliate_refund_total_minor?: number | null
          affiliate_refunded_minor?: number | null
          affiliate_source?: string | null
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
            foreignKeyName: "orders_affiliate_id_fkey"
            columns: ["affiliate_id"]
            isOneToOne: false
            referencedRelation: "affiliate_profiles"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
          access_token_hash: string | null
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
          access_token_hash?: string | null
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
          access_token_hash?: string | null
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
            referencedRelation: "profile_cards"
            referencedColumns: ["id"]
          },
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
      profile_cards: {
        Row: {
          avatar_url: string | null
          full_name: string | null
          id: string | null
        }
        Insert: {
          avatar_url?: string | null
          full_name?: string | null
          id?: string | null
        }
        Update: {
          avatar_url?: string | null
          full_name?: string | null
          id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      apply_affiliate_refund: {
        Args: {
          p_full: boolean
          p_gateway: Database["public"]["Enums"]["affiliate_gateway"]
          p_order_id: string
          p_order_total_minor: number
          p_refunded_minor: number
        }
        Returns: string
      }
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
      author: {
        Args: { "": Database["public"]["Tables"]["cms_interactions"]["Row"] }
        Returns: {
          avatar_url: string | null
          full_name: string | null
          id: string | null
        }
        SetofOptions: {
          from: "cms_interactions"
          to: "profile_cards"
          isOneToOne: true
          isSetofReturn: true
        }
      }
      bump_email_2fa_attempts: { Args: { p_user_id: string }; Returns: number }
      cancel_manual_affiliate_payout: {
        Args: { p_payout_id: string }
        Returns: Json
      }
      change_affiliate_partner_tier: {
        Args: {
          p_affiliate_id: string
          p_allow_over_cap?: boolean
          p_tier_id: string
        }
        Returns: string
      }
      claim_affiliate_commission_notifications: {
        Args: { p_limit: number }
        Returns: {
          affiliate_id: string
          cleared_at: string | null
          clears_at: string
          commission_amount_cents: number
          commission_rate_snapshot: number
          created_at: string
          currency: string
          disputed_at: string | null
          exchange_rate_snapshot: number
          gateway: Database["public"]["Enums"]["affiliate_gateway"]
          id: string
          livemode: boolean
          net_order_amount_cents: number
          notified_at: string | null
          order_currency: string
          order_id: string | null
          order_net_amount_minor: number
          paid_at: string | null
          payout_id: string | null
          refund_pending_cents: number
          refunded_amount_cents: number
          status: Database["public"]["Enums"]["affiliate_commission_status"]
          stripe_transfer_id: string | null
          updated_at: string
          void_reason: string | null
          void_requested_at: string | null
          voided_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "affiliate_commissions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_affiliate_payout: {
        Args: {
          p_affiliate_id: string
          p_currency: string
          p_gateways?: Database["public"]["Enums"]["affiliate_gateway"][]
          p_min_amount: number
          p_trigger: string
        }
        Returns: {
          affiliate_id: string
          amount_cents: number
          attempt_count: number
          created_at: string
          currency: string
          external_reference: string | null
          failure_reason: string | null
          id: string
          last_attempt_at: string
          livemode: boolean
          manual_channel: string | null
          method: string
          note: string | null
          paid_at: string | null
          paypal_batch_id: string | null
          paypal_checked_at: string | null
          paypal_fee_cents: number | null
          paypal_item_id: string | null
          paypal_item_status: string | null
          paypal_receiver: string | null
          paypal_sender_batch_id: string | null
          paypal_transaction_id: string | null
          recorded_by: string | null
          status: Database["public"]["Enums"]["affiliate_payout_status"]
          stripe_destination_account: string | null
          stripe_transfer_id: string | null
          trigger: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "affiliate_payouts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_affiliate_payout_run: {
        Args: { p_run_date: string; p_trigger: string }
        Returns: boolean
      }
      claim_manual_affiliate_payout: {
        Args: {
          p_affiliate_id: string
          p_currency: string
          p_gateways?: Database["public"]["Enums"]["affiliate_gateway"][]
          p_min_amount?: number
        }
        Returns: Json
      }
      claim_paypal_affiliate_payout: {
        Args: {
          p_affiliate_id: string
          p_currency: string
          p_gateways: Database["public"]["Enums"]["affiliate_gateway"][]
          p_livemode: boolean
          p_min_amount: number
          p_trigger?: string
        }
        Returns: Json
      }
      clear_currency_price_overrides: {
        Args: { target_currency: string }
        Returns: undefined
      }
      complete_affiliate_payout: {
        Args: { p_payout_id: string; p_transfer_id: string }
        Returns: boolean
      }
      complete_paypal_affiliate_payout: {
        Args: {
          p_fee_cents?: number
          p_item_id: string
          p_item_status?: string
          p_payout_id: string
          p_transaction_id: string
        }
        Returns: Json
      }
      create_affiliate_account: {
        Args: {
          p_display_name: string
          p_handle: string
          p_locale: string
          p_meta_description: string
          p_signup_ip_masked: string
          p_starter_doc: Json
          p_title: string
          p_user_id: string
        }
        Returns: {
          affiliate_id: string
          commission_percentage: number
          is_limited_time_promo: boolean
          page_id: string
          spots_remaining: number
          tier_id: string
          tier_name: string
          tier_slug: string
        }[]
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
      fail_affiliate_payout: {
        Args: { p_payout_id: string; p_reason: string }
        Returns: boolean
      }
      fail_paypal_affiliate_payout: {
        Args: { p_item_status?: string; p_payout_id: string; p_reason: string }
        Returns: Json
      }
      finish_affiliate_payout_run: {
        Args: { p_run_date: string; p_summary: Json }
        Returns: undefined
      }
      format_order_invoice_number: {
        Args: { p_value: number }
        Returns: string
      }
      generate_order_invoice_number: { Args: never; Returns: string }
      get_affiliate_referral_window: {
        Args: { p_handle: string }
        Returns: number
      }
      get_affiliate_storefront: {
        Args: { p_handle: string }
        Returns: {
          affiliate_id: string
          handle: string
          published_at: string
          published_content: Json
          published_featured_product_ids: string[]
          published_meta_description: string
          published_profile: Json
          published_title: string
          tier_badge_color: string
          tier_is_limited_time_promo: boolean
          tier_name: string
          tier_name_translations: Json
          updated_at: string
        }[]
      }
      get_current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      get_default_currency_code: { Args: never; Returns: string }
      get_ecommerce_track_quantities: { Args: never; Returns: boolean }
      get_my_claim: { Args: { claim: string }; Returns: Json }
      is_admin: { Args: never; Returns: boolean }
      is_admin_mfa: { Args: never; Returns: boolean }
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
      list_affiliate_storefronts: {
        Args: { p_limit?: number }
        Returns: {
          handle: string
          published_at: string
          updated_at: string
        }[]
      }
      media_storage_keys_in_use: {
        Args: { p_exclude_id?: string; p_keys: string[] }
        Returns: string[]
      }
      normalize_currency_amount_map: { Args: { amounts: Json }; Returns: Json }
      note_paypal_affiliate_payout_item: {
        Args: {
          p_fee_cents?: number
          p_item_id: string
          p_item_status: string
          p_payout_id: string
        }
        Returns: Json
      }
      prepare_affiliate_payout_retry: {
        Args: { p_min_amount?: number; p_payout_id: string }
        Returns: {
          affiliate_id: string
          amount_cents: number
          attempt_count: number
          created_at: string
          currency: string
          external_reference: string | null
          failure_reason: string | null
          id: string
          last_attempt_at: string
          livemode: boolean
          manual_channel: string | null
          method: string
          note: string | null
          paid_at: string | null
          paypal_batch_id: string | null
          paypal_checked_at: string | null
          paypal_fee_cents: number | null
          paypal_item_id: string | null
          paypal_item_status: string | null
          paypal_receiver: string | null
          paypal_sender_batch_id: string | null
          paypal_transaction_id: string | null
          recorded_by: string | null
          status: Database["public"]["Enums"]["affiliate_payout_status"]
          stripe_destination_account: string | null
          stripe_transfer_id: string | null
          trigger: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "affiliate_payouts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      promote_cleared_affiliate_commissions: { Args: never; Returns: number }
      reconcile_affiliate_commissions: {
        Args: { p_limit?: number }
        Returns: Json
      }
      record_affiliate_click: {
        Args: { p_handle: string; p_visitor_hash: string }
        Returns: undefined
      }
      record_manual_affiliate_payout: {
        Args: {
          p_channel: string
          p_note: string
          p_payout_id: string
          p_recorded_by: string
          p_reference: string
        }
        Returns: Json
      }
      record_paypal_affiliate_payout_batch: {
        Args: {
          p_payout_batch_id?: string
          p_payout_ids: string[]
          p_sender_batch_id: string
        }
        Returns: Json
      }
      redeem_coupon_atomically: {
        Args: { p_coupon_id: string }
        Returns: boolean
      }
      release_affiliate_payout: {
        Args: { p_payout_id: string }
        Returns: boolean
      }
      release_paypal_affiliate_payout: {
        Args: { p_payout_id: string }
        Returns: Json
      }
      set_affiliate_commission_dispute: {
        Args: {
          p_gateway: Database["public"]["Enums"]["affiliate_gateway"]
          p_open: boolean
          p_order_id: string
        }
        Returns: string
      }
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
      affiliate_commission_status:
        | "PENDING_CLEARANCE"
        | "CLEARED"
        | "PAID"
        | "VOIDED_REFUND"
      affiliate_gateway: "STRIPE" | "FREEMIUS"
      affiliate_onboarding_step:
        | "SIGNED_UP"
        | "PROFILE_COMPLETED"
        | "PAYOUT_CONFIGURED"
        | "PAGE_SUBMITTED"
        | "ACTIVE_PUBLISHED"
      affiliate_page_status:
        | "DRAFT"
        | "PENDING_REVIEW"
        | "PUBLISHED"
        | "CHANGES_REQUESTED"
      affiliate_payout_status: "PROCESSING" | "COMPLETED" | "FAILED"
      affiliate_status: "ACTIVE" | "SUSPENDED"
      approval_status: "pending" | "approved" | "denied"
      interaction_type: "review" | "comment"
      menu_location: "HEADER" | "FOOTER" | "SIDEBAR"
      page_status: "draft" | "published" | "archived"
      revision_type: "snapshot" | "diff"
      user_role: "ADMIN" | "WRITER" | "USER" | "RTL"
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
      affiliate_commission_status: [
        "PENDING_CLEARANCE",
        "CLEARED",
        "PAID",
        "VOIDED_REFUND",
      ],
      affiliate_gateway: ["STRIPE", "FREEMIUS"],
      affiliate_onboarding_step: [
        "SIGNED_UP",
        "PROFILE_COMPLETED",
        "PAYOUT_CONFIGURED",
        "PAGE_SUBMITTED",
        "ACTIVE_PUBLISHED",
      ],
      affiliate_page_status: [
        "DRAFT",
        "PENDING_REVIEW",
        "PUBLISHED",
        "CHANGES_REQUESTED",
      ],
      affiliate_payout_status: ["PROCESSING", "COMPLETED", "FAILED"],
      affiliate_status: ["ACTIVE", "SUSPENDED"],
      approval_status: ["pending", "approved", "denied"],
      interaction_type: ["review", "comment"],
      menu_location: ["HEADER", "FOOTER", "SIDEBAR"],
      page_status: ["draft", "published", "archived"],
      revision_type: ["snapshot", "diff"],
      user_role: ["ADMIN", "WRITER", "USER", "RTL"],
    },
  },
} as const
