'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SearchableSelect,
} from '@nextblock-cms/ui';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  ImageIcon,
  Info,
  KeyRound,
  Lock,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';

import {
  createCortexAiStoredModelSelection,
  type CortexAiStoredModelSelection,
} from '@nextblock-cms/cortex/client';
import type {
  CortexAiAgentSettings,
  CortexAiCompatibleOpenRouterModel,
} from '@nextblock-cms/cortex';
import {
  clearCortexAiModelSelectionAction,
  clearOpenRouterApiKeyAction,
  clearStockPhotoKeysAction,
  resetCortexAiAgentSettingsAction,
  saveCortexAiAgentSettingsAction,
  saveCortexAiModelSelectionAction,
  saveOpenRouterApiKeyAction,
  saveStockPhotoKeysAction,
} from './actions';

/**
 * The one Cortex AI settings UI — production and sandbox render the same tree.
 *
 * This page used to be two forked components (`StoredCortexAiSettingsClient` and
 * `SandboxCortexAiSettingsClient`) that shared a layout by copy-paste. Every design
 * change had to be made twice, and twice it wasn't: the sandbox drifted behind and
 * never gained the MCP card at all. So there is exactly one component now, and
 * `isSandbox` is a prop rather than a second file.
 *
 * The rule for anything the sandbox cannot do: **disable it, never hide it.** A
 * visitor evaluating NextBlock should be able to see that stock-photo keys, agent
 * tuning, and MCP access exist and what they look like — a hidden control teaches
 * them the feature doesn't exist. Only the two settings that have a per-visitor
 * channel (the OpenRouter key and model, which live in this browser's localStorage
 * and travel as `x-sandbox-openrouter-*` headers) stay writable in the sandbox.
 */

const CORTEX_AI_SANDBOX_KEY_LOCAL_STORAGE = 'cortex_ai_sandbox_openrouter_api_key';
const CORTEX_AI_SANDBOX_MODEL_LOCAL_STORAGE = 'cortex_ai_sandbox_openrouter_model_selection';
const CORTEX_AI_SETTINGS_CHANGED_EVENT = 'nextblock:cortex-ai-settings-changed';

type CortexAiSettingsClientProps = {
  /**
   * Shared-sandbox mode. Server-backed settings become read-only because the
   * settings actions refuse to write to the shared sandbox DB anyway; showing an
   * editable control that always errors is worse than showing a locked one.
   */
  isSandbox: boolean;
  compatibleModels: CortexAiCompatibleOpenRouterModel[];
  isPackageActive: boolean;
  hasEnvOpenRouterKey: boolean;
  maskedEnvOpenRouterKey: string | null;
  hasStoredOpenRouterKey: boolean;
  maskedStoredOpenRouterKey: string | null;
  selectedModel: CortexAiStoredModelSelection | null;
  hasEncryptionKey: boolean;
  modelCatalogError: string | null;
  activeStockProvider: 'pexels' | 'unsplash' | null;
  hasStoredPexelsKey: boolean;
  maskedStoredPexelsKey: string | null;
  hasStoredUnsplashKey: boolean;
  maskedStoredUnsplashKey: string | null;
  hasEnvPexelsKey: boolean;
  hasEnvUnsplashKey: boolean;
  unsplashAppName: string | null;
  agentSettings: CortexAiAgentSettings;
  /** Slot for server-rendered cards (currently the MCP server access card). */
  children?: React.ReactNode;
  /** Link to the first-run wizard; null where it is not offered (the sandbox). */
  setupGuideHref?: string | null;
  successMessage?: string;
  errorMessage?: string;
};

function formatTokenPrice(value: string | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount === 0) return '$0';
  const perMillion = amount * 1_000_000;
  return `$${perMillion < 0.01 ? perMillion.toFixed(4) : perMillion.toFixed(2)}`;
}

function formatModelPricing(pricing: Record<string, string>) {
  const promptPrice = formatTokenPrice(pricing.prompt);
  const completionPrice = formatTokenPrice(pricing.completion);
  if (promptPrice === '$0' && completionPrice === '$0') return 'Free';
  if (promptPrice && completionPrice) return `${promptPrice}/1M input - ${completionPrice}/1M output`;
  return 'Pricing varies';
}

function getMaskedKey(key: string) {
  if (key.length <= 8) return '****';
  return `**** ${key.slice(-4)}`;
}

function notifyCortexAiSettingsChanged() {
  window.dispatchEvent(new Event(CORTEX_AI_SETTINGS_CHANGED_EVENT));
}

function StatusPill({
  label,
  value,
  active,
  detail,
}: {
  label: string;
  value: string;
  active: boolean;
  detail?: string | null;
}) {
  return (
    <div className="flex min-w-[8rem] flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${active ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
        <span className="text-sm font-medium">{value}</span>
      </div>
      {detail && <span className="truncate font-mono text-[11px] text-muted-foreground">{detail}</span>}
    </div>
  );
}

/** The marker every locked-in-sandbox card carries, so "disabled" never reads as "broken". */
function ReadOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={`gap-1 font-normal ${className || ''}`}>
      <Lock className="h-3 w-3" />
      Read-only
    </Badge>
  );
}

/**
 * "Clear" affordance for the key / model cards.
 *
 * Production posts to a server action so the row is deleted from `site_settings`;
 * the sandbox drops the value from localStorage. Same button either way.
 */
function ClearButton({
  isSandbox,
  onSandboxClear,
  serverAction,
}: {
  isSandbox: boolean;
  onSandboxClear: () => void;
  serverAction: () => void | Promise<void>;
}) {
  const className = 'h-7 text-destructive hover:text-destructive';

  if (isSandbox) {
    return (
      <Button type="button" onClick={onSandboxClear} variant="ghost" size="sm" className={className}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        Clear
      </Button>
    );
  }

  return (
    <form action={serverAction} onSubmit={notifyCortexAiSettingsChanged}>
      <Button type="submit" variant="ghost" size="sm" className={className}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        Clear
      </Button>
    </form>
  );
}

export function CortexAiSettingsClient({
  isSandbox,
  compatibleModels,
  isPackageActive,
  hasEnvOpenRouterKey,
  maskedEnvOpenRouterKey,
  hasStoredOpenRouterKey,
  maskedStoredOpenRouterKey,
  selectedModel,
  hasEncryptionKey,
  modelCatalogError,
  activeStockProvider,
  hasStoredPexelsKey,
  maskedStoredPexelsKey,
  hasStoredUnsplashKey,
  maskedStoredUnsplashKey,
  hasEnvPexelsKey,
  hasEnvUnsplashKey,
  unsplashAppName,
  agentSettings,
  children,
  setupGuideHref = null,
  successMessage,
  errorMessage,
}: CortexAiSettingsClientProps) {
  const [apiKeyInput, setApiKeyInput] = useState('');
  // In the sandbox the stored selection belongs to the shared DB, not to this
  // visitor — the effect below fills the field in from localStorage instead.
  const [modelInput, setModelInput] = useState<string>(isSandbox ? '' : selectedModel?.modelId || '');
  const [pexelsInput, setPexelsInput] = useState('');
  const [unsplashInput, setUnsplashInput] = useState('');
  const [appNameInput, setAppNameInput] = useState(unsplashAppName || '');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [unlimitedTokens, setUnlimitedTokens] = useState(agentSettings.maxOutputTokens === null);
  const [maxTokensInput, setMaxTokensInput] = useState(String(agentSettings.maxOutputTokens ?? 16000));
  const [maxStepsInput, setMaxStepsInput] = useState(String(agentSettings.maxSteps));
  const [temperatureInput, setTemperatureInput] = useState(String(agentSettings.temperature));
  const [timeoutInput, setTimeoutInput] = useState(String(Math.round(agentSettings.responseTimeoutMs / 1000)));

  // Sandbox-only, per-browser credentials. Read after mount so the first client
  // render still matches the server HTML.
  const [sandboxKey, setSandboxKey] = useState<string | null>(null);
  const [sandboxModel, setSandboxModel] = useState<CortexAiStoredModelSelection | null>(null);
  const [sandboxMessage, setSandboxMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isSandbox) return;

    try {
      const storedKey = window.localStorage.getItem(CORTEX_AI_SANDBOX_KEY_LOCAL_STORAGE);
      if (storedKey) {
        setSandboxKey(storedKey);
      }

      const storedModel = window.localStorage.getItem(CORTEX_AI_SANDBOX_MODEL_LOCAL_STORAGE);
      if (storedModel) {
        const parsed = JSON.parse(storedModel) as CortexAiStoredModelSelection;
        setSandboxModel(parsed);
        setModelInput(parsed.modelId);
      }
    } catch (error) {
      console.error('Failed to read Cortex AI sandbox settings from localStorage', error);
    }
  }, [isSandbox]);

  function flashSandboxMessage(message: string) {
    setSandboxMessage(message);
    setTimeout(() => setSandboxMessage(null), 3000);
  }

  function handleSandboxSaveKey(event: React.FormEvent) {
    event.preventDefault();
    const key = apiKeyInput.trim();
    if (!key) return;

    try {
      window.localStorage.setItem(CORTEX_AI_SANDBOX_KEY_LOCAL_STORAGE, key);
      setSandboxKey(key);
      setApiKeyInput('');
      notifyCortexAiSettingsChanged();
      flashSandboxMessage('Sandbox OpenRouter key saved to your browser.');
    } catch (error) {
      console.error('Failed to save sandbox key', error);
    }
  }

  function handleSandboxClearKey() {
    try {
      window.localStorage.removeItem(CORTEX_AI_SANDBOX_KEY_LOCAL_STORAGE);
      window.localStorage.removeItem(CORTEX_AI_SANDBOX_MODEL_LOCAL_STORAGE);
      setSandboxKey(null);
      setSandboxModel(null);
      setModelInput('');
      notifyCortexAiSettingsChanged();
      flashSandboxMessage('Sandbox OpenRouter key cleared from your browser.');
    } catch (error) {
      console.error('Failed to clear sandbox key', error);
    }
  }

  function handleSandboxSaveModel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const modelId = String(formData.get('openrouter_model_id') || '').trim();
    if (!modelId) return;

    const model = compatibleModels.find((candidate) => candidate.id === modelId);
    if (!model) return;

    try {
      const storedSelection = createCortexAiStoredModelSelection(model);
      window.localStorage.setItem(
        CORTEX_AI_SANDBOX_MODEL_LOCAL_STORAGE,
        JSON.stringify(storedSelection)
      );
      setSandboxModel(storedSelection);
      notifyCortexAiSettingsChanged();
      flashSandboxMessage('Sandbox Cortex AI model selection saved to your browser.');
    } catch (error) {
      console.error('Failed to save sandbox model', error);
    }
  }

  function handleSandboxClearModel() {
    try {
      window.localStorage.removeItem(CORTEX_AI_SANDBOX_MODEL_LOCAL_STORAGE);
      setSandboxModel(null);
      setModelInput('');
      notifyCortexAiSettingsChanged();
      flashSandboxMessage('Sandbox Cortex AI model selection cleared.');
    } catch (error) {
      console.error('Failed to clear sandbox model', error);
    }
  }

  // One set of derived values, sourced from localStorage in the sandbox and from
  // the database everywhere else. Everything below renders off these, so the two
  // environments cannot drift apart visually.
  const hasKey = isSandbox ? Boolean(sandboxKey) : hasStoredOpenRouterKey;
  const maskedKey = isSandbox
    ? sandboxKey
      ? getMaskedKey(sandboxKey)
      : null
    : maskedStoredOpenRouterKey;
  const activeModel = isSandbox ? sandboxModel : selectedModel;

  const selectedModelIsInCatalog = compatibleModels.some((model) => model.id === activeModel?.modelId);
  const modelOptions: CortexAiCompatibleOpenRouterModel[] =
    activeModel && !selectedModelIsInCatalog
      ? [
          {
            contextLength: activeModel.contextLength,
            created: null,
            expirationDate: null,
            id: activeModel.modelId,
            name: `${activeModel.name} (saved)`,
            pricing: activeModel.pricing,
            supportedParameters: activeModel.supportedParameters,
          },
          ...compatibleModels,
        ]
      : compatibleModels;

  const canSelectModel = hasKey && compatibleModels.length > 0;

  const searchableOptions = modelOptions.map((model) => ({
    value: model.id,
    label: model.name,
    description: `${model.id} - ${formatModelPricing(model.pricing)}`,
  }));

  const isKeyDirty = apiKeyInput.trim().length > 0;
  const isModelDirty = modelInput !== (activeModel?.modelId || '');
  const isStockDirty =
    pexelsInput.trim().length > 0 ||
    unsplashInput.trim().length > 0 ||
    appNameInput.trim() !== (unsplashAppName || '');

  const keySourceValue = hasKey
    ? isSandbox
      ? 'Sandbox BYOK'
      : 'Stored BYOK'
    : hasEnvOpenRouterKey
      ? 'Environment'
      : 'None';

  // Ordered by preference (Pexels primary, Unsplash fallback). Configured = a
  // stored DB key OR an env var for that provider.
  const configuredStockProviders = [
    hasStoredPexelsKey || hasEnvPexelsKey ? { name: 'Pexels', stored: hasStoredPexelsKey } : null,
    hasStoredUnsplashKey || hasEnvUnsplashKey ? { name: 'Unsplash', stored: hasStoredUnsplashKey } : null,
  ].filter(Boolean) as Array<{ name: string; stored: boolean }>;
  const stockValue =
    configuredStockProviders.length > 0
      ? configuredStockProviders.map((provider) => provider.name).join(' + ')
      : 'Off';

  function stockKeyPlaceholder(hasStored: boolean, hasEnv: boolean, fallback: string) {
    if (!isSandbox) {
      return hasStored ? 'Enter new key to overwrite...' : fallback;
    }
    // Disabled password inputs render empty, so the placeholder has to carry the state.
    return hasStored ? 'Configured (stored)' : hasEnv ? 'Configured (env)' : 'Not set';
  }

  // Server actions in the sandbox would be rejected by the guards in `actions.ts`,
  // so sandbox forms are wired to local handlers (key/model) or neutered (the rest).
  const keyFormProps = isSandbox
    ? { onSubmit: handleSandboxSaveKey }
    : { action: saveOpenRouterApiKeyAction, onSubmit: notifyCortexAiSettingsChanged };
  const modelFormProps = isSandbox
    ? { onSubmit: handleSandboxSaveModel }
    : { action: saveCortexAiModelSelectionAction, onSubmit: notifyCortexAiSettingsChanged };
  const stockFormProps = isSandbox
    ? { onSubmit: (event: React.FormEvent) => event.preventDefault() }
    : { action: saveStockPhotoKeysAction, onSubmit: notifyCortexAiSettingsChanged };
  const agentFormProps = isSandbox
    ? { onSubmit: (event: React.FormEvent) => event.preventDefault() }
    : { action: saveCortexAiAgentSettingsAction, onSubmit: notifyCortexAiSettingsChanged };

  const banner = sandboxMessage
    ? { message: sandboxMessage, variant: 'success' as const }
    : successMessage
      ? { message: successMessage, variant: 'success' as const }
      : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Brain className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold leading-tight">
              NextBlock Cortex AI
              {isSandbox && (
                <Badge variant="secondary" className="ml-2 align-middle font-normal">
                  Sandbox
                </Badge>
              )}
            </h1>
            <p className="text-xs text-muted-foreground">
              {isSandbox
                ? 'Set the OpenRouter key and model for your own browser session. Everything else is shown as configured by the sandbox host.'
                : 'Manage activation, the OpenRouter model key, stock-photo providers, and MCP access.'}
            </p>
          </div>
        </div>
        {setupGuideHref && (
          <Button asChild variant="outline" size="sm">
            <Link href={setupGuideHref}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Setup guide
            </Link>
          </Button>
        )}
      </div>

      {banner && (
        <Alert variant={banner.variant}>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to save</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Compact status strip */}
      <div className="flex flex-wrap gap-2">
        <StatusPill label="Package" value={isPackageActive ? 'Active' : 'Inactive'} active={isPackageActive} />
        <StatusPill
          label="Model key"
          value={keySourceValue}
          active={hasKey || hasEnvOpenRouterKey}
          detail={maskedKey || maskedEnvOpenRouterKey}
        />
        <StatusPill
          label="Model"
          value={activeModel ? activeModel.name : 'Free registry'}
          active={Boolean(activeModel)}
        />
        <StatusPill label="Stock photos" value={stockValue} active={Boolean(activeStockProvider)} />
      </div>

      {isSandbox && (
        <Alert
          variant="warning"
          className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <Info className="h-4 w-4" />
          <AlertTitle>Sandbox environment active</AlertTitle>
          <AlertDescription>
            The key and model you set here are stored{' '}
            <strong>only in your own browser (localStorage)</strong> and are never written to the
            shared sandbox database. Everything else on this page is shown exactly as it appears on a
            real install, but locked — the sandbox is shared by every visitor.
          </AlertDescription>
        </Alert>
      )}

      {isSandbox && hasEnvOpenRouterKey && !hasKey && (
        <Alert>
          <KeyRound className="h-4 w-4" />
          <AlertTitle>Free-model lock active</AlertTitle>
          <AlertDescription>
            Cortex AI will only use the configured free OpenRouter models until you save a sandbox key
            to your browser.
          </AlertDescription>
        </Alert>
      )}

      {!isSandbox && !hasEncryptionKey && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Encryption key missing</AlertTitle>
          <AlertDescription>
            Set CORTEX_AI_ENCRYPTION_KEY (or rely on the Supabase service-role fallback) before saving keys here.
          </AlertDescription>
        </Alert>
      )}

      {/* OpenRouter BYOK + Model side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">OpenRouter key</CardTitle>
              <CardDescription className="text-xs">
                {isSandbox ? 'Saved to your browser only, never uploaded.' : 'Encrypted, masked after saving.'}
              </CardDescription>
            </div>
            {hasKey && (
              <ClearButton
                isSandbox={isSandbox}
                onSandboxClear={handleSandboxClearKey}
                serverAction={clearOpenRouterApiKeyAction}
              />
            )}
          </CardHeader>
          <CardContent className="pt-0">
            <form {...keyFormProps} className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="openrouter_api_key" className="text-xs">
                  API key
                </Label>
                <Input
                  id="openrouter_api_key"
                  name="openrouter_api_key"
                  type="password"
                  autoComplete="off"
                  minLength={12}
                  placeholder={hasKey ? 'Enter new key to overwrite...' : 'sk-or-v1-...'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={!isKeyDirty} size="sm">
                <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                Save
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">OpenRouter model</CardTitle>
              <CardDescription className="text-xs">
                Needs {isSandbox ? 'a sandbox key' : 'a stored key'}; supports tools + structured output.
              </CardDescription>
            </div>
            {activeModel && (
              <ClearButton
                isSandbox={isSandbox}
                onSandboxClear={handleSandboxClearModel}
                serverAction={clearCortexAiModelSelectionAction}
              />
            )}
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {modelCatalogError && (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Model catalog unavailable</AlertTitle>
                <AlertDescription>{modelCatalogError}</AlertDescription>
              </Alert>
            )}
            <form {...modelFormProps} className="flex items-end gap-2">
              <input type="hidden" name="openrouter_model_id" value={modelInput} />
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="openrouter_model_id_select" className="text-xs">
                  Model
                </Label>
                <SearchableSelect
                  options={searchableOptions}
                  value={modelInput}
                  onChange={(val) => setModelInput(val)}
                  disabled={!canSelectModel}
                  placeholder="Select a compatible model..."
                />
              </div>
              <Button type="submit" disabled={!canSelectModel || !isModelDirty} size="sm">
                <Cpu className="mr-1.5 h-3.5 w-3.5" />
                Save
              </Button>
            </form>
            <p className="text-[11px] text-muted-foreground">
              {canSelectModel
                ? `${compatibleModels.length} compatible models available.`
                : `Cortex AI uses the free registry until a ${isSandbox ? 'sandbox' : 'stored'} key + model are set.`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Stock photos */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <ImageIcon className="h-4 w-4" />
              Stock photos
              {configuredStockProviders.length > 0 ? (
                configuredStockProviders.map((provider, index) => (
                  <Badge
                    key={provider.name}
                    variant={index === 0 ? 'default' : 'secondary'}
                    className="ml-0.5 font-normal"
                  >
                    {provider.name} · {index === 0 ? 'primary' : 'fallback'}
                    {!provider.stored && ' (env)'}
                  </Badge>
                ))
              ) : (
                <Badge variant="outline" className="ml-0.5">
                  Not configured
                </Badge>
              )}
              {isSandbox && <ReadOnlyBadge />}
            </CardTitle>
            <CardDescription className="text-xs">
              Free Pexels/Unsplash key so Cortex inserts real photos into pages. Pexels is used first; Cortex
              automatically falls back to Unsplash if Pexels is rate-limited. Optional but recommended.
            </CardDescription>
          </div>
          {(hasStoredPexelsKey || hasStoredUnsplashKey) &&
            (isSandbox ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-destructive hover:text-destructive"
                disabled
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Clear
              </Button>
            ) : (
              <form action={clearStockPhotoKeysAction} onSubmit={notifyCortexAiSettingsChanged}>
                <Button type="submit" variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive">
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Clear
                </Button>
              </form>
            ))}
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Why + how */}
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <p className="font-medium">Why add a key?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                When you ask Cortex to build or revamp a page, a stock key lets it fetch relevant, high-quality
                photos for the hero and sections automatically — instant, zero image-generation cost, and you can
                save any photo into your media library with one click. Without a key Cortex still builds pages, but
                uses gradient/theme backgrounds instead of photos, and it will not call the photo tool at all.
              </p>
              <p className="mt-3 font-medium">Get a free key (pick one):</p>
              <ol className="mt-1 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Pexels</span> — open{' '}
                  <span className="font-mono">pexels.com/api</span>, sign in, click “Get Started / Your API Key”,
                  copy the key.
                </li>
                <li>
                  <span className="font-medium text-foreground">or Unsplash</span> — open{' '}
                  <span className="font-mono">unsplash.com/developers</span>, create a New Application, copy its
                  “Access Key”.
                </li>
                <li>Paste it on the right and Save. You only need one provider.</li>
              </ol>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {isSandbox
                  ? 'On your own NextBlock install you paste the key here and it is encrypted into your database. In this shared sandbox the keys come from the host environment and cannot be changed.'
                  : 'Keys are encrypted and stored in your database, readable only by admins. Pexels is used first when both are set.'}
              </p>
            </div>

            {/* Key form */}
            <form {...stockFormProps} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pexels_api_key" className="text-xs">
                  Pexels API key{' '}
                  {hasStoredPexelsKey && maskedStoredPexelsKey && (
                    <span className="font-mono text-[11px] text-muted-foreground">({maskedStoredPexelsKey})</span>
                  )}
                  {!hasStoredPexelsKey && hasEnvPexelsKey && (
                    <span className="text-[11px] text-muted-foreground">(set via env)</span>
                  )}
                </Label>
                <Input
                  id="pexels_api_key"
                  name="pexels_api_key"
                  type="password"
                  autoComplete="off"
                  disabled={isSandbox}
                  placeholder={stockKeyPlaceholder(hasStoredPexelsKey, hasEnvPexelsKey, 'Paste Pexels API key')}
                  value={pexelsInput}
                  onChange={(e) => setPexelsInput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="unsplash_access_key" className="text-xs">
                  Unsplash Access key{' '}
                  {hasStoredUnsplashKey && maskedStoredUnsplashKey && (
                    <span className="font-mono text-[11px] text-muted-foreground">({maskedStoredUnsplashKey})</span>
                  )}
                  {!hasStoredUnsplashKey && hasEnvUnsplashKey && (
                    <span className="text-[11px] text-muted-foreground">(set via env)</span>
                  )}
                </Label>
                <Input
                  id="unsplash_access_key"
                  name="unsplash_access_key"
                  type="password"
                  autoComplete="off"
                  disabled={isSandbox}
                  placeholder={stockKeyPlaceholder(
                    hasStoredUnsplashKey,
                    hasEnvUnsplashKey,
                    'Paste Unsplash Access key'
                  )}
                  value={unsplashInput}
                  onChange={(e) => setUnsplashInput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="unsplash_app_name" className="text-xs">
                  Unsplash app name{' '}
                  <span className="text-[11px] text-muted-foreground">
                    (for attribution links — must match your registered Unsplash app)
                  </span>
                </Label>
                <Input
                  id="unsplash_app_name"
                  name="unsplash_app_name"
                  type="text"
                  autoComplete="off"
                  disabled={isSandbox}
                  placeholder={isSandbox ? 'Not set' : 'e.g. My Site Name'}
                  value={appNameInput}
                  onChange={(e) => setAppNameInput(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {configuredStockProviders.length > 0
                    ? `Using ${configuredStockProviders.map((provider) => provider.name).join(', ')}.`
                    : isSandbox
                      ? 'No provider configured in this sandbox.'
                      : 'No provider configured yet.'}
                </span>
                <Button type="submit" disabled={isSandbox || !isStockDirty} size="sm">
                  <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
                  Save
                </Button>
              </div>
            </form>
          </div>
        </CardContent>
      </Card>

      {/* MCP server access — rendered by the server page so it can read token state. */}
      {children}

      {/* Advanced settings (collapsed by default) */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          className="flex w-full items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-left text-sm font-medium hover:bg-muted/40"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Advanced settings
          <span className="ml-auto text-xs text-muted-foreground">
            {agentSettings.maxOutputTokens === null ? 'Unlimited output' : `${agentSettings.maxOutputTokens} tokens`} · {agentSettings.maxSteps} steps
          </span>
          {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {showAdvanced && (
          <Card className="mt-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                Agent tuning
                {isSandbox && <ReadOnlyBadge />}
              </CardTitle>
              <CardDescription className="text-xs">
                {isSandbox
                  ? 'Controls how much room the page-building agent has. These are set by the sandbox host and shared by every visitor, so they cannot be edited here — on your own install they are editable.'
                  : 'Controls how much room the page-building agent has. Leave the defaults unless a big build gets cut off — then raise the output tokens (or set Unlimited) and steps.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              <form {...agentFormProps} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="max_output_tokens"
                      className="text-xs"
                      title="Range 256–200,000 tokens, or Unlimited. The per-step output budget; also counts a tool call's JSON, so raise it (or use Unlimited) if a big page rewrite gets cut off. Default 16,000."
                    >
                      Max output tokens per step
                    </Label>
                    <Input
                      id="max_output_tokens"
                      name="max_output_tokens"
                      type="number"
                      min={256}
                      max={200000}
                      step={256}
                      value={maxTokensInput}
                      onChange={(e) => setMaxTokensInput(e.target.value)}
                      disabled={unlimitedTokens || isSandbox}
                    />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        name="max_output_unlimited"
                        checked={unlimitedTokens}
                        onChange={(e) => setUnlimitedTokens(e.target.checked)}
                        disabled={isSandbox}
                        className="h-3.5 w-3.5"
                      />
                      Unlimited (use the model&apos;s full output budget)
                    </label>
                    <p className="text-[11px] text-muted-foreground">Range 256–200,000, or Unlimited. Default 16,000.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="max_steps"
                      className="text-xs"
                      title="Range 2–100. Each step is one full model call (a page rewrite is ~3–4). This is also the runaway-loop backstop, so a high value can cost more. Default 8."
                    >
                      Max tool steps
                    </Label>
                    <Input
                      id="max_steps"
                      name="max_steps"
                      type="number"
                      min={2}
                      max={100}
                      step={1}
                      value={maxStepsInput}
                      onChange={(e) => setMaxStepsInput(e.target.value)}
                      disabled={isSandbox}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Range 2–100 tool-call rounds. Default 8; each step is one model call.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="temperature"
                      className="text-xs"
                      title="Range 0–2. This is Cortex's default (0.1), not the model's universal default (usually ~0.7–1.0). Low keeps structured tool-calls reliable; raise for more variety in copy."
                    >
                      Temperature
                    </Label>
                    <Input
                      id="temperature"
                      name="temperature"
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={temperatureInput}
                      onChange={(e) => setTemperatureInput(e.target.value)}
                      disabled={isSandbox}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Range 0–2. Cortex default 0.1 (low = reliable; most models default higher).
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="response_timeout_seconds"
                      className="text-xs"
                      title="Range 15–600 seconds. Aborts an attempt only after this long with NO stream activity — not a hard cap on total time. Default 120."
                    >
                      Response timeout (seconds)
                    </Label>
                    <Input
                      id="response_timeout_seconds"
                      name="response_timeout_seconds"
                      type="number"
                      min={15}
                      max={600}
                      step={5}
                      value={timeoutInput}
                      onChange={(e) => setTimeoutInput(e.target.value)}
                      disabled={isSandbox}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Range 15–600s. Default 120; aborts only after this long with no activity.
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    {isSandbox
                      ? 'Applies to the global page-building agent. Editable on a self-hosted install.'
                      : 'Values are clamped to safe ranges. Applies to the global page-building agent.'}
                  </span>
                  <Button type="submit" size="sm" disabled={isSandbox}>
                    <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
                    Save
                  </Button>
                </div>
              </form>
              {isSandbox ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reset to defaults
                </Button>
              ) : (
                <form action={resetCortexAiAgentSettingsAction} onSubmit={notifyCortexAiSettingsChanged}>
                  <Button type="submit" variant="ghost" size="sm" className="h-7 text-muted-foreground">
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Reset to defaults
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
