'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  Label,
  SearchableSelect,
} from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import {
  isCortexSiteBriefComplete,
  type CortexAiCompatibleOpenRouterModel,
  type CortexAiStoredModelSelection,
  type CortexSiteBrief,
} from '@nextblock-cms/cortex';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Brain,
  Check,
  CheckCircle2,
  ClipboardList,
  Cpu,
  ExternalLink,
  ImageIcon,
  KeyRound,
  Loader2,
  MessageSquareText,
  Pencil,
  Plug,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  briefToSiteBriefFormValues,
  type SiteBriefFormValues,
} from '../../../../../lib/cortex-ai/site-brief-form';
import {
  SITE_BUILDER_KICKOFF_PROMPT,
  SITE_BUILDER_KICKOFF_PROMPT_WITH_BRIEF,
} from '../../../../../lib/cortex-ai/site-builder-prompt';
import type { CortexSetupPath } from '../../../../../lib/cortex-ai/setup-state';
import { SetupStepIndicator } from '../../../components/SetupStepIndicator';
import { CopyButton, Snippet } from '../CopySnippet';
import { MCP_CLIENTS, buildMcpClientSnippets, type McpClientId } from '../mcp-client-snippets';
import {
  completeCortexSetupAction,
  connectOpenRouterKeyAction,
  enableMcpForSetupAction,
  saveStockPhotoKeysForSetupAction,
  selectModelForSetupAction,
  type StockProviderId,
} from './actions';
import { SiteBriefForm } from './SiteBriefForm';

/**
 * The Cortex AI first-run wizard.
 *
 * Design rules, in order of priority:
 *   1. One decision per screen, and every screen can be skipped. Nothing here is
 *      irreversible; the full settings page is one click away at all times.
 *   2. Verify before storing. A key is checked against its provider the moment the
 *      operator submits it, so a typo is caught here, not in the chat an hour later.
 *   3. End on the action, not on a summary. The last screen IS the "Start building"
 *      button (chat path) or the exact prompt to paste (MCP path).
 *   4. Ask once, in writing. The brief step is the interview Cortex used to run in
 *      chat, as one form; a saved brief lets the build start at the plan.
 */

type Step = 1 | 2 | 3 | 4;
type Path = 'chat' | 'mcp' | null;

type KeyState =
  | { status: 'idle' }
  | { status: 'checking' }
  | {
      status: 'connected';
      maskedKey: string | null;
      detail: string | null;
      /** Null when unknown (env key, or stored unverified). */
      isFreeTier: boolean | null;
      source: 'stored' | 'env';
    }
  | { status: 'error'; message: string; reason: 'invalid' | 'unreachable' | 'error' };

type ModelState = { status: 'idle' } | { status: 'saving' } | { status: 'error'; message: string };

/** The "no selection" option: Cortex rotates through OpenRouter's free models. */
const FREE_MODELS_OPTION_VALUE = '';

type McpState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'enabled'; token: string | null; tokenPrefix: string | null }
  | { status: 'error'; message: string };

type StockState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; providers: StockProviderId[] }
  | {
      status: 'error';
      message?: string;
      errors: Partial<Record<StockProviderId, { message: string; reason: 'invalid' | 'unreachable' | 'error' }>>;
    };

type BriefState = { status: 'idle' } | { status: 'saved'; brief: CortexSiteBrief };

type CortexSetupWizardProps = {
  /** The public site's active languages; the brief form offers exactly these. */
  activeLanguages: Array<{ code: string; name: string; isDefault: boolean }>;
  allowLocalhostWithoutToken: boolean;
  /** OpenRouter models that support tools + structured output (empty when the catalog failed). */
  compatibleModels: CortexAiCompatibleOpenRouterModel[];
  /** A brief saved earlier (an interrupted run, or one Cortex wrote in chat); prefills the brief step. */
  existingBrief: CortexSiteBrief | null;
  hasEncryptionKey: boolean;
  hasEnvOpenRouterKey: boolean;
  hasPexelsKey: boolean;
  hasStoredOpenRouterKey: boolean;
  hasUnsplashKey: boolean;
  intent: 'site-builder' | null;
  localMcpUrl: string;
  maskedStoredOpenRouterKey: string | null;
  mcpEnabled: boolean;
  mcpUrl: string;
  modelCatalogUnavailable: boolean;
  selectedModel: CortexAiStoredModelSelection | null;
  /** Title and intro above the step chips; the standalone route uses the defaults. */
  heading?: { title: string; description: string };
  /**
   * Steps that came before this wizard in a longer flow (the welcome flow's trial
   * offer), rendered as completed chips so the sequence reads as one.
   */
  precedingSteps?: ReadonlyArray<string>;
  /** Where the footer's skip link goes; the settings page by default. */
  skipHref?: string;
  skipLabel?: string;
};

function formatTokenPrice(value: string | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount === 0) return '$0';
  const perMillion = amount * 1_000_000;
  return `$${perMillion < 0.01 ? perMillion.toFixed(4) : perMillion.toFixed(2)}`;
}

function formatModelPricing(pricing: Record<string, string>) {
  const promptPrice = formatTokenPrice(pricing['prompt']);
  const completionPrice = formatTokenPrice(pricing['completion']);
  if (promptPrice === '$0' && completionPrice === '$0') return 'Free';
  if (promptPrice && completionPrice) return `${promptPrice} in / ${completionPrice} out per 1M tokens`;
  return 'Pricing varies';
}

/** The wizard's step chips; a flow that precedes the wizard prepends its own steps. */
export const CORTEX_SETUP_STEP_LABELS: ReadonlyArray<string> = ['Connect', 'Photos', 'Brief', 'Build'];
const STEP_LABELS = CORTEX_SETUP_STEP_LABELS;

const SETTINGS_HREF = '/cms/settings/cortex-ai';
const DASHBOARD_HREF = '/cms/dashboard';
const SITE_BUILDER_HREF = '/cms/dashboard?cortex=site-builder';

const DEFAULT_HEADING = {
  description:
    'Four quick steps and Cortex can build your site. Everything here can be changed later in settings.',
  title: 'Set up Cortex AI',
};

const SITE_TYPE_LABELS: Record<CortexSiteBrief['site_type'], string> = {
  blog: 'blog',
  'landing-page': 'one landing page',
  'multi-page': 'several pages',
  other: 'custom',
  portfolio: 'portfolio',
  store: 'online store',
};

/** One line that says what was saved, so the operator can tell it is the right brief. */
function summariseBrief(brief: CortexSiteBrief) {
  const pageCount = Math.max(brief.pages.length, 1);
  return [
    SITE_TYPE_LABELS[brief.site_type],
    `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`,
    brief.languages.map((code) => code.toUpperCase()).join(', '),
  ].join(' · ');
}

function ExternalHint({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** A selectable option card: the header is the radio, the body appears when selected. */
function OptionCard({
  badge,
  children,
  description,
  icon: Icon,
  onSelect,
  selected,
  title,
}: {
  badge?: string;
  children?: React.ReactNode;
  description: string;
  icon: React.ElementType;
  onSelect: () => void;
  selected: boolean;
  title: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card transition-colors',
        selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/50'
      )}
    >
      <button
        aria-checked={selected}
        className="flex w-full items-start gap-3 p-4 text-left"
        onClick={onSelect}
        role="radio"
        type="button"
      >
        <span
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
            selected ? 'border-primary' : 'border-muted-foreground/50'
          )}
          aria-hidden
        >
          {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 text-primary" aria-hidden />
            <span className="text-sm font-semibold">{title}</span>
            {badge && (
              <Badge variant="secondary" className="font-normal">
                {badge}
              </Badge>
            )}
          </span>
          <span className="text-sm text-muted-foreground">{description}</span>
        </span>
      </button>
      {selected && children && <div className="border-t px-4 pb-4 pt-3">{children}</div>}
    </div>
  );
}

export function CortexSetupWizard({
  activeLanguages,
  allowLocalhostWithoutToken,
  compatibleModels,
  existingBrief,
  hasEncryptionKey,
  hasEnvOpenRouterKey,
  hasPexelsKey,
  hasStoredOpenRouterKey,
  hasUnsplashKey,
  intent,
  localMcpUrl,
  maskedStoredOpenRouterKey,
  mcpEnabled,
  mcpUrl,
  modelCatalogUnavailable,
  selectedModel,
  heading = DEFAULT_HEADING,
  precedingSteps = [],
  skipHref = SETTINGS_HREF,
  skipLabel = 'Skip setup and open all settings',
}: CortexSetupWizardProps) {
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>(1);
  const [path, setPath] = useState<Path>(
    hasStoredOpenRouterKey || hasEnvOpenRouterKey ? 'chat' : mcpEnabled ? 'mcp' : null
  );

  // Step 1 — OpenRouter
  const [apiKey, setApiKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(false);
  const [keyState, setKeyState] = useState<KeyState>(
    hasStoredOpenRouterKey
      ? { detail: null, isFreeTier: null, maskedKey: maskedStoredOpenRouterKey, source: 'stored', status: 'connected' }
      : hasEnvOpenRouterKey
        ? { detail: null, isFreeTier: null, maskedKey: null, source: 'env', status: 'connected' }
        : { status: 'idle' }
  );

  // Step 1 — model. `savedModel` is what the database holds; `modelId` is the picker.
  const [savedModel, setSavedModel] = useState<CortexAiStoredModelSelection | null>(selectedModel);
  const [modelId, setModelId] = useState<string>(selectedModel?.modelId ?? FREE_MODELS_OPTION_VALUE);
  const [modelState, setModelState] = useState<ModelState>({ status: 'idle' });

  // Step 1 — MCP
  const [tokenName, setTokenName] = useState('My computer');
  const [mcpState, setMcpState] = useState<McpState>({ status: 'idle' });
  const [activeClient, setActiveClient] = useState<McpClientId>('claude-code');
  const [useLocalUrl, setUseLocalUrl] = useState(false);

  // Step 2 — stock photos
  const [pexelsKey, setPexelsKey] = useState('');
  const [unsplashKey, setUnsplashKey] = useState('');
  const [stockState, setStockState] = useState<StockState>(
    hasPexelsKey || hasUnsplashKey
      ? {
          providers: [
            ...(hasPexelsKey ? (['pexels'] as const) : []),
            ...(hasUnsplashKey ? (['unsplash'] as const) : []),
          ],
          status: 'saved',
        }
      : { status: 'idle' }
  );

  // Step 3 — the site brief. A COMPLETE brief (name + description, the same test the
  // chat route applies before skipping the interview) that Cortex or an earlier run
  // already saved counts as done; "Edit brief" reopens the form prefilled from it. A
  // name-only brief from an interrupted chat interview prefills the form instead, so
  // the wizard never promises "no questionnaire" for a brief the route will still
  // interview about.
  const [briefState, setBriefState] = useState<BriefState>(
    isCortexSiteBriefComplete(existingBrief) ? { brief: existingBrief, status: 'saved' } : { status: 'idle' }
  );
  const [editingBrief, setEditingBrief] = useState(false);
  // The form's unsaved answers, held here because step 3 unmounts on Back: without
  // this, going back to add a photo key wiped a half-filled questionnaire.
  const [briefDraft, setBriefDraft] = useState<SiteBriefFormValues | null>(null);

  // Step 4
  const [finishing, setFinishing] = useState<string | null>(null);

  const keyConnected = keyState.status === 'connected';
  const mcpReady = mcpState.status === 'enabled';
  const briefSaved = briefState.status === 'saved';
  const savedBrief = briefState.status === 'saved' ? briefState.brief : null;
  const kickoffPrompt = briefSaved ? SITE_BUILDER_KICKOFF_PROMPT_WITH_BRIEF : SITE_BUILDER_KICKOFF_PROMPT;

  function connectKey(allowUnverified = false) {
    const candidate = apiKey.trim();

    if (!candidate) {
      return;
    }

    setKeyState({ status: 'checking' });
    startTransition(async () => {
      const result = await connectOpenRouterKeyAction({ allowUnverified, apiKey: candidate });

      if (!result.success) {
        setKeyState({ message: result.message, reason: result.reason, status: 'error' });
        return;
      }

      setApiKey('');
      setReplacingKey(false);
      setKeyState({
        detail: result.detail,
        isFreeTier: result.isFreeTier,
        maskedKey: result.maskedKey,
        source: 'stored',
        status: 'connected',
      });
      // Stay on this step: the model picker appears under the connected key. A key
      // with credit that silently ran on the free rotation would waste the credit and
      // give a poor site build, so the choice is made here, not discovered later.
      toast.success(result.verified ? 'OpenRouter connected. Now pick a model.' : 'OpenRouter key saved (not verified).');
    });
  }

  /** Persist the model choice (when it changed) and move to step 2. */
  function continueFromKey() {
    const currentSaved = savedModel?.modelId ?? FREE_MODELS_OPTION_VALUE;

    if (keyState.status !== 'connected' || keyState.source === 'env' || modelId === currentSaved) {
      setStep(2);
      return;
    }

    setModelState({ status: 'saving' });
    startTransition(async () => {
      const result = await selectModelForSetupAction({ modelId: modelId || null });

      if (!result.success) {
        setModelState({ message: result.message, status: 'error' });
        return;
      }

      setSavedModel(result.model);
      setModelState({ status: 'idle' });
      setStep(2);
    });
  }

  function enableMcp() {
    setMcpState({ status: 'working' });
    startTransition(async () => {
      const result = await enableMcpForSetupAction({ allowLocalhostWithoutToken, tokenName });

      if (!result.success) {
        setMcpState({ message: result.message, status: 'error' });
        return;
      }

      setMcpState({ status: 'enabled', token: result.token, tokenPrefix: result.tokenPrefix });
      toast.success('MCP server enabled. Your token is waiting on the last step.');
      setStep(2);
    });
  }

  function saveStockKeys(allowUnverified = false) {
    setStockState({ status: 'saving' });
    startTransition(async () => {
      const result = await saveStockPhotoKeysForSetupAction({ allowUnverified, pexelsKey, unsplashKey });

      if (!result.success) {
        setStockState({ errors: result.errors, message: result.message, status: 'error' });

        // A provider that did save should not be asked for again.
        if (result.saved.includes('pexels')) setPexelsKey('');
        if (result.saved.includes('unsplash')) setUnsplashKey('');
        return;
      }

      setPexelsKey('');
      setUnsplashKey('');
      setStockState({ providers: result.saved, status: 'saved' });
      toast.success('Stock photos connected.');
      setStep(3);
    });
  }

  function finish(finalPath: CortexSetupPath, href: string) {
    setFinishing(href);
    startTransition(async () => {
      const result = await completeCortexSetupAction({ path: finalPath });

      if (!result.success) {
        setFinishing(null);
        toast.error(result.message ?? 'Could not record the setup state.');
        return;
      }

      // Full navigation on purpose: the CMS layout decides whether the chat drawer
      // has a model key, and a layout does not re-render on a client-side push.
      window.location.assign(href);
    });
  }

  const mcpSnippetUrl = useLocalUrl ? localMcpUrl : mcpUrl;
  const mcpToken = mcpState.status === 'enabled' ? mcpState.token : null;
  const usesLocalhostTrust = useLocalUrl && allowLocalhostWithoutToken && !mcpToken;
  const snippets = buildMcpClientSnippets({ token: mcpToken, url: mcpSnippetUrl, usesLocalhostTrust });

  const stockSummary =
    stockState.status === 'saved' && stockState.providers.length > 0
      ? stockState.providers.map((p) => (p === 'pexels' ? 'Pexels' : 'Unsplash')).join(' + ')
      : null;

  // A saved model that has since left the catalog still has to be selectable, or the
  // picker would silently show "free models" for a site that is not using them.
  const modelOptions = [
    {
      description: "Rotates through OpenRouter's free models. Fine to try; slower and less reliable for a full site build.",
      label: 'Free models (automatic)',
      value: FREE_MODELS_OPTION_VALUE,
    },
    ...(savedModel && !compatibleModels.some((model) => model.id === savedModel.modelId)
      ? [
          {
            description: `${savedModel.modelId} · saved earlier`,
            label: savedModel.name,
            value: savedModel.modelId,
          },
        ]
      : []),
    ...compatibleModels.map((model) => ({
      description: `${model.id} · ${formatModelPricing(model.pricing)}`,
      label: model.name,
      value: model.id,
    })),
  ];
  const modelSummary =
    keyState.status === 'connected' && keyState.source === 'env'
      ? 'Free models (environment key)'
      : savedModel
        ? savedModel.name
        : 'Free models (automatic)';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5">
            <Brain className="h-6 w-6 text-primary" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold leading-tight">{heading.title}</h1>
            <p className="text-sm text-muted-foreground">{heading.description}</p>
          </div>
        </div>
        <SetupStepIndicator
          current={precedingSteps.length + step - 1}
          steps={[...precedingSteps, ...STEP_LABELS]}
        />
      </header>

      {!hasEncryptionKey && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Keys cannot be stored yet</AlertTitle>
          <AlertDescription>
            Set <span className="font-mono">CORTEX_AI_ENCRYPTION_KEY</span> (or a Supabase service-role
            key) in the environment first. Until then, only the MCP path works.
          </AlertDescription>
        </Alert>
      )}

      {/* ───────────── Step 1: how to talk to Cortex ───────────── */}
      {step === 1 && (
        <section className="space-y-4" aria-labelledby="setup-step-1">
          <div className="space-y-1">
            <h2 id="setup-step-1" className="text-lg font-semibold">
              How do you want to talk to Cortex?
            </h2>
            <p className="text-sm text-muted-foreground">
              Pick one to start with. You can add the other any time.
            </p>
          </div>

          <div className="space-y-3" role="radiogroup" aria-labelledby="setup-step-1">
            <OptionCard
              badge="Recommended"
              description="Cortex runs right here in your dashboard. It needs an OpenRouter API key: one key that unlocks hundreds of models, free ones included."
              icon={MessageSquareText}
              onSelect={() => setPath('chat')}
              selected={path === 'chat'}
              title="Chat here in NextBlock"
            >
              {keyConnected && !replacingKey ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <div>
                      <p className="font-medium">
                        {keyState.source === 'env'
                          ? 'A key is already set in the OPENROUTER_API_KEY environment variable.'
                          : `OpenRouter is connected${keyState.maskedKey ? ` (key ${keyState.maskedKey})` : ''}.`}
                      </p>
                      {keyState.detail && (
                        <p className="text-xs text-muted-foreground">{keyState.detail}</p>
                      )}
                    </div>
                  </div>

                  {keyState.source === 'env' ? (
                    <p className="text-xs text-muted-foreground">
                      An environment key always runs on the free model rotation. To pick a paid model,
                      store a key here instead.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      <Label htmlFor="setup_model" className="flex items-center gap-1.5 text-xs">
                        <Cpu className="h-3.5 w-3.5" />
                        Model
                      </Label>
                      <SearchableSelect
                        disabled={modelState.status === 'saving'}
                        onChange={(value) => {
                          setModelId(value);
                          setModelState({ status: 'idle' });
                        }}
                        options={modelOptions}
                        placeholder="Choose a model…"
                        value={modelId}
                      />
                      <p className="text-xs text-muted-foreground">
                        {keyState.isFreeTier === true
                          ? 'This key has no credit yet, so only free models will answer. Add credit on OpenRouter to unlock paid models.'
                          : keyState.isFreeTier === false
                            ? 'This key has credit. A paid model with tool support gives a much better site build than the free rotation.'
                            : 'Free models are fine to try. For a full site build, a paid model with tool support is far more reliable.'}
                        {modelCatalogUnavailable
                          ? ' The OpenRouter catalog could not be loaded right now; you can pick a model later in settings.'
                          : ''}
                      </p>
                      {modelState.status === 'error' && (
                        <p className="text-xs text-destructive">{modelState.message}</p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button disabled={modelState.status === 'saving'} onClick={continueFromKey} type="button">
                      {modelState.status === 'saving' ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : null}
                      Continue
                      {modelState.status !== 'saving' && <ArrowRight className="ml-1.5 h-4 w-4" />}
                    </Button>
                    <Button
                      disabled={modelState.status === 'saving'}
                      onClick={() => setReplacingKey(true)}
                      type="button"
                      variant="ghost"
                    >
                      Use a different key
                    </Button>
                  </div>
                </div>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    connectKey();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="setup_openrouter_key" className="text-xs">
                      OpenRouter API key
                    </Label>
                    <Input
                      autoComplete="off"
                      autoFocus
                      disabled={!hasEncryptionKey || keyState.status === 'checking'}
                      id="setup_openrouter_key"
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="sk-or-v1-…"
                      type="password"
                      value={apiKey}
                    />
                    <p className="text-xs text-muted-foreground">
                      <ExternalHint href="https://openrouter.ai/keys">Create a key at openrouter.ai/keys</ExternalHint>
                      {' '}(free account). Free models work with no credit; adding a few dollars unlocks
                      the strongest models. Stored encrypted, shown masked after saving.
                    </p>
                  </div>

                  {keyState.status === 'error' && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>
                        {keyState.reason === 'unreachable' ? 'Could not verify the key' : 'Key not accepted'}
                      </AlertTitle>
                      <AlertDescription className="space-y-2">
                        <p>{keyState.message}</p>
                        {keyState.reason === 'unreachable' && (
                          <Button onClick={() => connectKey(true)} size="sm" type="button" variant="outline">
                            Save it anyway
                          </Button>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={!hasEncryptionKey || !apiKey.trim() || keyState.status === 'checking'} type="submit">
                      {keyState.status === 'checking' ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="mr-1.5 h-4 w-4" />
                      )}
                      {keyState.status === 'checking' ? 'Checking with OpenRouter…' : 'Connect key'}
                    </Button>
                    {replacingKey && (
                      <Button onClick={() => setReplacingKey(false)} type="button" variant="ghost">
                        Keep the current key
                      </Button>
                    )}
                  </div>
                </form>
              )}
            </OptionCard>

            <OptionCard
              description="Work from Claude Code, Claude Desktop, Cursor or VS Code with the AI subscription you already have. NextBlock exposes its tools over MCP; no OpenRouter key needed."
              icon={Plug}
              onSelect={() => setPath('mcp')}
              selected={path === 'mcp'}
              title="Use my own AI app (MCP)"
            >
              {mcpReady ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <p className="font-medium">
                      MCP server enabled. Your access token and the client config are on the last step.
                    </p>
                  </div>
                  <Button onClick={() => setStep(2)} type="button">
                    Continue
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    enableMcp();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="setup_mcp_token_name" className="text-xs">
                      Name this connection
                    </Label>
                    <Input
                      autoFocus
                      disabled={mcpState.status === 'working'}
                      id="setup_mcp_token_name"
                      maxLength={80}
                      onChange={(event) => setTokenName(event.target.value)}
                      placeholder="My computer"
                      value={tokenName}
                    />
                    <p className="text-xs text-muted-foreground">
                      This switches the MCP server on and creates one access token for your machine.
                      {mcpEnabled ? ' The server is already on; only the token is new.' : ''} You can
                      add or revoke tokens later in settings.
                    </p>
                  </div>

                  {mcpState.status === 'error' && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Could not enable MCP</AlertTitle>
                      <AlertDescription>{mcpState.message}</AlertDescription>
                    </Alert>
                  )}

                  <Button disabled={mcpState.status === 'working'} type="submit">
                    {mcpState.status === 'working' ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Plug className="mr-1.5 h-4 w-4" />
                    )}
                    {mcpState.status === 'working' ? 'Enabling…' : 'Enable MCP & continue'}
                  </Button>
                </form>
              )}
            </OptionCard>
          </div>

          <div className="flex justify-end">
            <Button
              className="text-muted-foreground"
              onClick={() => {
                setPath(null);
                setStep(2);
              }}
              type="button"
              variant="ghost"
            >
              I&rsquo;ll decide later
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {/* ───────────── Step 2: stock photos ───────────── */}
      {step === 2 && (
        <section className="space-y-4" aria-labelledby="setup-step-2">
          <div className="space-y-1">
            <h2 id="setup-step-2" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              <ImageIcon className="h-5 w-5 text-primary" />
              Free photos for your pages
              <Badge variant="outline" className="font-normal">
                Optional
              </Badge>
            </h2>
            <p className="text-sm text-muted-foreground">
              When Cortex builds a page it fills the image slots with free stock photos. Add one key and it
              can search for them itself; skip this and it leaves the image slots for you to fill.
            </p>
          </div>

          {stockState.status === 'saved' ? (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <p className="font-medium">
                  Stock photos are on{stockSummary ? ` (${stockSummary})` : ''}.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setStep(3)} type="button">
                  Continue
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
                <Button onClick={() => setStockState({ status: 'idle' })} type="button" variant="ghost">
                  Add another provider
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4 rounded-xl border bg-card p-4"
              onSubmit={(event) => {
                event.preventDefault();
                saveStockKeys();
              }}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="setup_pexels_key" className="flex items-center gap-2 text-xs">
                    Pexels API key
                    <Badge variant="secondary" className="font-normal">
                      Fastest
                    </Badge>
                  </Label>
                  <Input
                    autoComplete="off"
                    disabled={!hasEncryptionKey || stockState.status === 'saving'}
                    id="setup_pexels_key"
                    onChange={(event) => setPexelsKey(event.target.value)}
                    placeholder="Paste your Pexels key"
                    type="password"
                    value={pexelsKey}
                  />
                  <p className="text-xs text-muted-foreground">
                    <ExternalHint href="https://www.pexels.com/api/new/">Get a key at pexels.com/api</ExternalHint>
                    {' '}— instant approval, 200 searches an hour.
                  </p>
                  {stockState.status === 'error' && stockState.errors.pexels && (
                    <p className="text-xs text-destructive">{stockState.errors.pexels.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="setup_unsplash_key" className="text-xs">
                    Unsplash access key
                  </Label>
                  <Input
                    autoComplete="off"
                    disabled={!hasEncryptionKey || stockState.status === 'saving'}
                    id="setup_unsplash_key"
                    onChange={(event) => setUnsplashKey(event.target.value)}
                    placeholder="Paste your Unsplash Access Key"
                    type="password"
                    value={unsplashKey}
                  />
                  <p className="text-xs text-muted-foreground">
                    <ExternalHint href="https://unsplash.com/developers">Create an app at unsplash.com/developers</ExternalHint>
                    {' '}and copy its Access Key (not the Secret Key).
                  </p>
                  {stockState.status === 'error' && stockState.errors.unsplash && (
                    <p className="text-xs text-destructive">{stockState.errors.unsplash.message}</p>
                  )}
                </div>
              </div>

              {stockState.status === 'error' && stockState.message && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Could not save</AlertTitle>
                  <AlertDescription>{stockState.message}</AlertDescription>
                </Alert>
              )}

              {stockState.status === 'error' &&
                Object.values(stockState.errors).some((entry) => entry?.reason === 'unreachable') && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Could not verify the key</AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>The provider did not answer. You can store the key unverified and test it later.</p>
                      <Button onClick={() => saveStockKeys(true)} size="sm" type="button" variant="outline">
                        Save anyway
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button onClick={() => setStep(1)} type="button" variant="ghost">
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setStep(3)} type="button" variant="ghost">
                    Skip for now
                  </Button>
                  <Button
                    disabled={
                      !hasEncryptionKey ||
                      stockState.status === 'saving' ||
                      (!pexelsKey.trim() && !unsplashKey.trim())
                    }
                    type="submit"
                  >
                    {stockState.status === 'saving' ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <ImageIcon className="mr-1.5 h-4 w-4" />
                    )}
                    {stockState.status === 'saving' ? 'Checking…' : 'Save & continue'}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </section>
      )}

      {/* ───────────── Step 3: site brief ───────────── */}
      {step === 3 && (
        <section className="space-y-4" aria-labelledby="setup-step-3">
          <div className="space-y-1">
            <h2 id="setup-step-3" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              <ClipboardList className="h-5 w-5 text-primary" />
              Tell Cortex about your business
              <Badge variant="outline" className="font-normal">
                Skippable
              </Badge>
            </h2>
            <p className="text-sm text-muted-foreground">
              This is the interview Cortex would otherwise run in chat, written down so you can answer in
              two minutes and in any order. Only the name and description are required; skip it and
              Cortex asks the same questions one at a time.
            </p>
          </div>

          {savedBrief && !editingBrief ? (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <div className="min-w-0">
                  <p className="font-medium">Brief saved: {savedBrief.business_name}</p>
                  <p className="text-xs text-muted-foreground">{summariseBrief(savedBrief)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setStep(4)} type="button">
                  Continue
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
                <Button onClick={() => setEditingBrief(true)} type="button" variant="ghost">
                  <Pencil className="mr-1.5 h-4 w-4" />
                  Edit brief
                </Button>
              </div>
            </div>
          ) : (
            <SiteBriefForm
              activeLanguages={activeLanguages}
              initialValues={briefDraft ?? briefToSiteBriefFormValues(savedBrief ?? existingBrief, activeLanguages)}
              isEditing={savedBrief !== null}
              onChange={setBriefDraft}
              onSaved={(brief) => {
                setBriefState({ brief, status: 'saved' });
                setBriefDraft(null);
                setEditingBrief(false);
                setStep(4);
              }}
              onSkip={() => {
                setBriefDraft(null);
                setEditingBrief(false);
                // Editing a saved brief: "Cancel" returns to the saved card and the
                // brief stands. No brief yet: skip the form, Cortex interviews in chat.
                if (!savedBrief) setStep(4);
              }}
            />
          )}

          <div>
            <Button
              onClick={() => {
                setEditingBrief(false);
                setStep(2);
              }}
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Back
            </Button>
          </div>
        </section>
      )}

      {/* ───────────── Step 4: build ───────────── */}
      {step === 4 && (
        <section className="space-y-4" aria-labelledby="setup-step-4">
          {path === 'chat' && keyConnected && (
            <div className="space-y-5 rounded-xl border border-primary/30 bg-primary/[0.04] p-6">
              <div className="space-y-1">
                <h2 id="setup-step-4" className="flex items-center gap-2 text-lg font-semibold">
                  <Sparkles className="h-5 w-5 text-primary" />
                  You&rsquo;re ready to build
                </h2>
                <p className="text-sm text-muted-foreground">
                  {briefSaved
                    ? 'Cortex has your brief. It will look at what the site has now, propose a plan, and build it after you approve — no questionnaire.'
                    : 'Cortex will look at what your site has now, ask you a few questions about your business, then propose a plan. You approve it once and it builds the pages, menus and branding.'}
                </p>
              </div>

              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  OpenRouter connected
                  {keyState.maskedKey ? <span className="font-mono text-xs text-muted-foreground">{keyState.maskedKey}</span> : null}
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  Model: {modelSummary}
                </li>
                <li className="flex items-center gap-2">
                  {stockSummary ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border border-muted-foreground/40" aria-hidden />
                  )}
                  {stockSummary ? `Stock photos: ${stockSummary}` : 'Stock photos: skipped'}
                </li>
                <li className="flex items-center gap-2">
                  {briefSaved ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border border-muted-foreground/40" aria-hidden />
                  )}
                  {briefSaved ? 'Brief: saved' : 'Brief: Cortex will ask in chat'}
                </li>
              </ul>

              <div className="flex flex-wrap gap-2">
                <Button
                  className="w-full sm:w-auto"
                  disabled={finishing !== null}
                  onClick={() => finish('chat', SITE_BUILDER_HREF)}
                  size="lg"
                  type="button"
                >
                  {finishing === SITE_BUILDER_HREF ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-4 w-4" />
                  )}
                  Start building my site
                </Button>
                <Button
                  disabled={finishing !== null}
                  onClick={() => finish('chat', DASHBOARD_HREF)}
                  size="lg"
                  type="button"
                  variant="ghost"
                >
                  Not now, go to the dashboard
                </Button>
              </div>
            </div>
          )}

          {path === 'mcp' && (
            <div className="space-y-5">
              <div className="space-y-1">
                <h2 id="setup-step-4" className="flex items-center gap-2 text-lg font-semibold">
                  <Plug className="h-5 w-5 text-primary" />
                  Connect your AI app
                </h2>
                <p className="text-sm text-muted-foreground">
                  {briefSaved
                    ? 'Add NextBlock to your client with the config below, then paste the prompt. Your brief is saved, so it goes straight to the plan.'
                    : 'Add NextBlock to your client with the config below, then paste the prompt to start the interview.'}
                </p>
              </div>

              {mcpToken ? (
                <Alert>
                  <KeyRound className="h-4 w-4" />
                  <AlertTitle>Copy this token now</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p className="text-xs">
                      It is shown only this once; only its hash is stored. The snippets below already include it.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input readOnly value={mcpToken} className="font-mono text-xs" />
                      <CopyButton value={mcpToken} />
                    </div>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>No new token in this session</AlertTitle>
                  <AlertDescription className="text-xs">
                    Create one under <Link className="underline" href={SETTINGS_HREF}>Cortex AI settings</Link> and
                    replace YOUR_TOKEN in the snippets below.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-3 rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {MCP_CLIENTS.map(([key, label]) => (
                      <Button
                        key={key}
                        className="h-7 text-xs"
                        onClick={() => setActiveClient(key)}
                        size="sm"
                        type="button"
                        variant={activeClient === key ? 'secondary' : 'ghost'}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      className="h-6 text-[11px]"
                      onClick={() => setUseLocalUrl(false)}
                      size="sm"
                      type="button"
                      variant={useLocalUrl ? 'ghost' : 'secondary'}
                    >
                      Live site
                    </Button>
                    <Button
                      className="h-6 text-[11px]"
                      onClick={() => setUseLocalUrl(true)}
                      size="sm"
                      type="button"
                      variant={useLocalUrl ? 'secondary' : 'ghost'}
                    >
                      Localhost
                    </Button>
                  </div>
                </div>

                {activeClient === 'claude-code' && (
                  <div className="space-y-3">
                    <Snippet code={snippets.claudeCodeCli} title="One-line CLI setup" />
                    <Snippet code={snippets.claudeCode} title="…or add to .mcp.json in your project root" />
                  </div>
                )}
                {activeClient === 'claude-desktop' && (
                  <Snippet code={snippets.claudeDesktop} title="claude_desktop_config.json" />
                )}
                {activeClient === 'cursor' && <Snippet code={snippets.cursor} title=".cursor/mcp.json" />}
                {activeClient === 'vscode' && <Snippet code={snippets.vscode} title=".vscode/mcp.json" />}
              </div>

              <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="h-4 w-4 text-primary" />
                    Then paste this to start
                  </p>
                  <CopyButton label="Copy prompt" value={kickoffPrompt} />
                </div>
                <blockquote className="rounded-md border bg-background px-3 py-2 text-sm leading-relaxed">
                  {kickoffPrompt}
                </blockquote>
                <p className="text-xs text-muted-foreground">
                  Your client will ask you to approve each change. Clients that support MCP prompts also
                  list this flow as <span className="font-mono">build-site</span>.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button disabled={finishing !== null} onClick={() => finish('mcp', DASHBOARD_HREF)} type="button">
                  {finishing === DASHBOARD_HREF ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                  Done, go to the dashboard
                </Button>
                <Button disabled={finishing !== null} onClick={() => finish('mcp', SETTINGS_HREF)} type="button" variant="ghost">
                  Open all Cortex settings
                </Button>
              </div>
            </div>
          )}

          {(path === null || (path === 'chat' && !keyConnected)) && (
            <div className="space-y-5">
              <div className="space-y-1">
                <h2 id="setup-step-4" className="text-lg font-semibold">
                  Cortex is installed, not connected yet
                </h2>
                <p className="text-sm text-muted-foreground">
                  Come back to either option whenever you are ready; the site builder will bring you here.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50"
                  onClick={() => {
                    setPath('chat');
                    setStep(1);
                  }}
                  type="button"
                >
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <MessageSquareText className="h-4 w-4 text-primary" />
                    Add an OpenRouter key
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Chat with Cortex in the dashboard.</p>
                </button>
                <button
                  className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50"
                  onClick={() => {
                    setPath('mcp');
                    setStep(1);
                  }}
                  type="button"
                >
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Plug className="h-4 w-4 text-primary" />
                    Connect an AI app
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Use Claude Code, Cursor or VS Code over MCP.</p>
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button disabled={finishing !== null} onClick={() => finish('later', DASHBOARD_HREF)} type="button">
                  {finishing === DASHBOARD_HREF ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Finish, go to the dashboard
                </Button>
              </div>
            </div>
          )}

          <div>
            <Button disabled={finishing !== null} onClick={() => setStep(3)} type="button" variant="ghost">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Back
            </Button>
          </div>
        </section>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
        <span>
          {intent === 'site-builder'
            ? 'The site builder is waiting: it opens as soon as Cortex can reach a model.'
            : 'Nothing here is final. Every setting lives on the Cortex AI page.'}
        </span>
        <button
          className="underline-offset-2 hover:underline disabled:opacity-50"
          disabled={isPending}
          onClick={() => finish('later', skipHref)}
          type="button"
        >
          {skipLabel}
        </button>
      </footer>
    </div>
  );
}
