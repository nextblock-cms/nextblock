/**
 * Sandbox credential passthrough for browser-initiated Cortex AI requests.
 *
 * On the hosted sandbox there is no server-side OpenRouter key, because every visitor
 * shares one deployment and we will not spend the project's credits on strangers.
 * Instead each visitor pastes their own key into the Cortex AI settings screen, which
 * stores it in `localStorage`, and every AI call made from the browser forwards it on
 * the request as a header. The route only reads those headers when
 * `NEXT_PUBLIC_IS_SANDBOX === 'true'`, so on a real install the headers are ignored
 * even if something were to send them.
 *
 * This lived inline in `NotionEditor.handleAiGenerate` and was about to be copied into
 * three more call sites (image alt text, media alt text, page/post metadata). Copies
 * drift: the day a storage key or header name changes, the forgotten copy silently
 * stops authenticating and the sandbox user sees "no credentials" from one button and
 * not another. One exported builder keeps that impossible.
 */

/** localStorage key holding the visitor's own OpenRouter API key on the sandbox. */
export const CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY = 'cortex_ai_sandbox_openrouter_api_key';

/** localStorage key holding the visitor's serialized model selection on the sandbox. */
export const CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY = 'cortex_ai_sandbox_openrouter_model_selection';

/** localStorage key of the Cortex agent's chat threads (CortexGlobalAgentChat). */
export const CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY = 'nextblock-cortex-global-agent-chat-threads';

/** sessionStorage key of the single-thread chat CortexGlobalAgentChat migrates from. */
export const CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY = 'nextblock-cortex-global-agent-chat';

/**
 * Window event clearSandboxCortexKey() dispatches on the sandbox before it removes anything. An
 * open CortexGlobalAgentChat aborts its request and saves nothing from then on, so a reply still
 * streaming cannot write the chat history back after sign-out removed it.
 */
export const CORTEX_SANDBOX_SIGN_OUT_EVENT = 'nextblock:cortex-sandbox-sign-out';

/**
 * Builds the headers for a JSON POST to a Cortex AI route, adding the sandbox
 * credential headers when — and only when — this build is the sandbox and the visitor
 * has actually stored a key.
 *
 * `localStorage` access is wrapped in try/catch on purpose: a browser configured to
 * block site data throws on the *accessor itself*, not just on read, and an AI button
 * that explodes before it can send a request is a far worse failure than one that sends
 * an unauthenticated request and gets a clean 403 back.
 */
export function buildCortexAiRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true' || typeof window === 'undefined') {
    return headers;
  }

  try {
    const sandboxKey = window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY);
    const sandboxModel = window.localStorage.getItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY);

    if (sandboxKey) {
      headers['x-sandbox-openrouter-key'] = sandboxKey;
    }
    if (sandboxModel) {
      headers['x-sandbox-openrouter-model'] = sandboxModel;
    }
  } catch {
    // Storage is unavailable (private window, blocked site data). Fall through with the
    // plain content-type header; the route will answer 403 and the caller will toast it.
  }

  return headers;
}

/**
 * Forgets the visitor's own OpenRouter key, model selection and Cortex chat history on the
 * sandbox. Every visitor signs in to the same demo accounts, so a key left in this browser after
 * sign-out would be spent by the next person on a shared machine, who would also read the chat
 * (2026-11-03). Every client-side sign-out handler calls this before `signOutAction()`. That
 * action's redirect is a soft navigation, landing only after the server round trip, and the page
 * keeps running until then: an open chat is told to stop first (CORTEX_SANDBOX_SIGN_OUT_EVENT),
 * or a reply still streaming would save every thread again. Off the sandbox it touches nothing
 * and dispatches nothing: a real install keeps no key in the browser, and its chat history
 * belongs to the browser's own admin.
 */
export function clearSandboxCortexKey(): void {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    return;
  }

  try {
    window.dispatchEvent(new Event(CORTEX_SANDBOX_SIGN_OUT_EVENT));
  } catch {
    // No window events here: nothing can be listening either. The storage below still goes.
  }

  try {
    window.localStorage.removeItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY);
    window.localStorage.removeItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY);
    window.localStorage.removeItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY);
    window.sessionStorage.removeItem(CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY);
  } catch {
    // Storage is blocked (private window, blocked site data): no page here can read a key from it
    // either. Sign-out goes ahead.
  }
}
