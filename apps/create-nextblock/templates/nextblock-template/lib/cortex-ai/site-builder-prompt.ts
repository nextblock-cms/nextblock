/**
 * The message that starts the guided site build.
 *
 * The dashboard chat sends it automatically when the site builder opens; the setup
 * wizard shows it to operators on the MCP path so they can paste the exact same
 * kickoff into Claude Code, Claude Desktop, Cursor or VS Code. One constant, so the
 * two entry points never diverge.
 */
export const SITE_BUILDER_KICKOFF_PROMPT =
  'I want to set up my website with you. Look at what the site has now, then interview me about my business so you can plan and build it.';

/**
 * The kickoff once the operator filled in the site-brief form: the interview has
 * already happened, so the first reply should be the plan.
 */
export const SITE_BUILDER_KICKOFF_PROMPT_WITH_BRIEF =
  "I've filled in my site brief. Look at what the site has now, then propose the plan to build it. Only ask me about anything that's genuinely missing.";

/** Where every key-less path into the site builder lands. */
export const CORTEX_SETUP_PATH = '/cms/settings/cortex-ai/setup';

/** The wizard hands off straight into the chat when it finishes with this intent. */
export const CORTEX_SETUP_SITE_BUILDER_HREF = `${CORTEX_SETUP_PATH}?intent=site-builder`;

/**
 * Where a brand-new administrator lands after /setup: the Cortex AI trial offer as a
 * full page, followed by the setup wizard, before the dashboard is ever shown.
 */
export const CMS_WELCOME_PATH = '/cms/welcome';
