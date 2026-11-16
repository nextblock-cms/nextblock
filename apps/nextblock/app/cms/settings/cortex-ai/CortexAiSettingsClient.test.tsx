// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The server's own bounds and defaults: what saveCortexAiAgentSettingsAction clamps every value to.
import {
  CORTEX_AI_AGENT_SETTINGS_BOUNDS,
  CORTEX_AI_AGENT_SETTINGS_DEFAULTS,
  type CortexAiAgentSettings,
} from '@nextblock-cms/cortex';

/**
 * CMS → Cortex AI → Advanced → Agent tuning. A browser refuses to submit a number input whose
 * value is off its step (min + n × step). "Max output tokens per step" had min 256 and step 256, so
 * its default of 16,000 (and any saved value off that grid) blocked every Save of the form until
 * the field was changed (2026-11-13 production review). The inputs now mirror what the server
 * accepts: these tests pin them to the server's bounds and defaults.
 */

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// Server actions: the client only hands them to <form action>.
vi.mock('./actions', () => ({
  clearCortexAiModelSelectionAction: vi.fn(),
  clearOpenRouterApiKeyAction: vi.fn(),
  clearStockPhotoKeysAction: vi.fn(),
  resetCortexAiAgentSettingsAction: vi.fn(),
  saveCortexAiAgentSettingsAction: vi.fn(),
  saveCortexAiModelSelectionAction: vi.fn(),
  saveOpenRouterApiKeyAction: vi.fn(),
  saveStockPhotoKeysAction: vi.fn(),
}));

import { CortexAiSettingsClient } from './CortexAiSettingsClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

/** The settings page with the Advanced section opened, as an admin sees it before touching anything. */
function renderAgentTuning(agentSettings: CortexAiAgentSettings) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  act(() => {
    root.render(
      <CortexAiSettingsClient
        isSandbox={false}
        compatibleModels={[]}
        isPackageActive
        hasEnvOpenRouterKey={false}
        maskedEnvOpenRouterKey={null}
        hasStoredOpenRouterKey={false}
        maskedStoredOpenRouterKey={null}
        selectedModel={null}
        hasEncryptionKey
        modelCatalogError={null}
        activeStockProvider={null}
        hasStoredPexelsKey={false}
        maskedStoredPexelsKey={null}
        hasStoredUnsplashKey={false}
        maskedStoredUnsplashKey={null}
        hasEnvPexelsKey={false}
        hasEnvUnsplashKey={false}
        unsplashAppName={null}
        agentSettings={agentSettings}
      />
    );
  });

  const toggle = required(
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Advanced settings')),
    'the Advanced settings toggle'
  );
  act(() => toggle.click());

  const input = (name: string) => required(container.querySelector<HTMLInputElement>(`input[name="${name}"]`), name);
  const maxOutputTokens = input('max_output_tokens');

  return {
    form: required(maxOutputTokens.form, 'the Agent tuning form'),
    maxOutputTokens,
    unlimited: input('max_output_unlimited'),
    maxSteps: input('max_steps'),
    temperature: input('temperature'),
    timeoutSeconds: input('response_timeout_seconds'),
  };
}

/** Why the browser would refuse to submit this input, or null when it would submit. */
function refusal(input: HTMLInputElement): string | null {
  const { validity } = input;
  if (validity.valid) return null;
  return Object.entries({
    stepMismatch: validity.stepMismatch,
    rangeUnderflow: validity.rangeUnderflow,
    rangeOverflow: validity.rangeOverflow,
    badInput: validity.badInput,
    valueMissing: validity.valueMissing,
  })
    .filter(([, failed]) => failed)
    .map(([reason]) => `${input.name}: ${reason} (value ${input.value}, min ${input.min}, step ${input.step})`)
    .join('; ');
}

describe('Agent tuning inputs', () => {
  it('accept exactly the range the save action clamps to', () => {
    const fields = renderAgentTuning({ ...CORTEX_AI_AGENT_SETTINGS_DEFAULTS });
    const bounds = CORTEX_AI_AGENT_SETTINGS_BOUNDS;

    expect([fields.maxOutputTokens.min, fields.maxOutputTokens.max]).toEqual([
      String(bounds.maxOutputTokens.min),
      String(bounds.maxOutputTokens.max),
    ]);
    expect([fields.maxSteps.min, fields.maxSteps.max]).toEqual([String(bounds.maxSteps.min), String(bounds.maxSteps.max)]);
    expect([fields.temperature.min, fields.temperature.max]).toEqual([
      String(bounds.temperature.min),
      String(bounds.temperature.max),
    ]);
    // The form asks for seconds; the server stores milliseconds.
    expect([fields.timeoutSeconds.min, fields.timeoutSeconds.max]).toEqual([
      String(bounds.responseTimeoutMs.min / 1000),
      String(bounds.responseTimeoutMs.max / 1000),
    ]);
    // Every whole number of tokens the server stores is a valid value, not only multiples of 256.
    expect(fields.maxOutputTokens.step).toBe('1');
  });

  it('show the server defaults and save them untouched', () => {
    const fields = renderAgentTuning({ ...CORTEX_AI_AGENT_SETTINGS_DEFAULTS });
    const defaults = CORTEX_AI_AGENT_SETTINGS_DEFAULTS;

    expect(fields.maxOutputTokens.value).toBe(String(defaults.maxOutputTokens));
    expect(fields.unlimited.checked).toBe(false);
    expect(fields.maxSteps.value).toBe(String(defaults.maxSteps));
    expect(fields.temperature.value).toBe(String(defaults.temperature));
    expect(fields.timeoutSeconds.value).toBe(String(defaults.responseTimeoutMs / 1000));

    for (const field of [fields.maxOutputTokens, fields.maxSteps, fields.temperature, fields.timeoutSeconds]) {
      expect(refusal(field)).toBeNull();
    }
    expect(fields.form.checkValidity()).toBe(true);
  });

  it('offers the server default, valid, when Unlimited is switched off', () => {
    const fields = renderAgentTuning({ ...CORTEX_AI_AGENT_SETTINGS_DEFAULTS, maxOutputTokens: null });

    expect(fields.unlimited.checked).toBe(true);
    expect(fields.maxOutputTokens.disabled).toBe(true);
    act(() => fields.unlimited.click());

    expect(fields.unlimited.checked).toBe(false);
    expect(fields.maxOutputTokens.disabled).toBe(false);
    expect(fields.maxOutputTokens.value).toBe(String(CORTEX_AI_AGENT_SETTINGS_DEFAULTS.maxOutputTokens));
    expect(refusal(fields.maxOutputTokens)).toBeNull();
    expect(fields.form.checkValidity()).toBe(true);
  });

  it.each([256, 257, 1000, 15999, 16000, 16001, 123457, 199999, 200000])(
    'keep a saved cap of %d tokens submittable',
    (maxOutputTokens) => {
      const fields = renderAgentTuning({ ...CORTEX_AI_AGENT_SETTINGS_DEFAULTS, maxOutputTokens });

      expect(fields.maxOutputTokens.value).toBe(String(maxOutputTokens));
      expect(refusal(fields.maxOutputTokens)).toBeNull();
      expect(fields.form.checkValidity()).toBe(true);
    }
  );

  it('show a fractional cap written outside this form as the whole number the save action stores', () => {
    const fields = renderAgentTuning({ ...CORTEX_AI_AGENT_SETTINGS_DEFAULTS, maxOutputTokens: 16000.6 });

    expect(fields.maxOutputTokens.value).toBe('16001');
    expect(refusal(fields.maxOutputTokens)).toBeNull();
  });
});
