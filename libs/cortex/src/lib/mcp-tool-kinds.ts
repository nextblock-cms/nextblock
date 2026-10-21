import type { CortexAiMcpScope } from './mcp-tokens';

/**
 * Read/write classification for every tool in the registry.
 *
 * Lives in its own module so the tool factory (ai-global-agent-tools.ts) can read it
 * without importing the MCP registry, which imports the factory.
 *
 * Exhaustive by construction: `assertCortexMcpToolCoverage` (and a unit test) compares
 * these keys against the live factory output, so adding a tool to the agent without
 * classifying it here is a loud failure rather than a silent security hole. New tools
 * are NOT defaulted to 'read' — an unclassified mutating tool handed to a read-only
 * token is exactly the bug this table exists to prevent.
 */
export const CORTEX_MCP_TOOL_KINDS = {
  create_cms_page: 'write',
  create_cms_post: 'write',
  create_cms_product: 'write',
  create_custom_block: 'write',
  delete_cms_item: 'write',
  delete_custom_block: 'write',
  describe_database_schema: 'read',
  execute_cms_action_plan: 'write',
  execute_database_action_plan: 'write',
  execute_database_mutation: 'write',
  fetch_ecommerce_stats: 'read',
  fetch_url_content: 'read',
  finish_site_build: 'write',
  get_site_overview: 'read',
  insert_content_block: 'write',
  list_custom_blocks: 'read',
  list_media: 'read',
  list_product_categories: 'read',
  list_site_script_revisions: 'read',
  list_site_scripts: 'read',
  list_site_themes: 'read',
  manage_language: 'write',
  manage_product_category: 'write',
  manage_product_variants: 'write',
  manage_site_script: 'write',
  manage_site_theme: 'write',
  prepare_delete_cms_item: 'read',
  publish_content_draft: 'write',
  read_current_cms_item: 'read',
  read_database_records: 'read',
  reset_site_content: 'write',
  revert_site_script: 'write',
  rewrite_page_draft: 'write',
  save_site_brief: 'write',
  search_documentation: 'read',
  search_stock_photos: 'read',
  set_content_images: 'write',
  start_site_build: 'write',
  translate_content_bulk: 'write',
  translate_page: 'write',
  update_cms_item_field: 'write',
  upload_media: 'write',
  update_content_block: 'write',
  update_current_cms_fields: 'write',
  update_custom_block: 'write',
  update_footer: 'write',
  update_global_css: 'write',
  update_navigation_bar: 'write',
  update_section_column_block: 'write',
  update_site_identity: 'write',
} as const satisfies Record<string, CortexAiMcpScope>;
