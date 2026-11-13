import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tryDecryptWithEnvKey } from '@nextblock-cms/db/secrets';

import {
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_PEXELS_SETTING_KEY,
  CORTEX_AI_UNSPLASH_SETTING_KEY,
  cortexAiSecretSlot,
  decryptStoredCortexAiSecret,
  decryptStoredOpenRouterApiKey,
  encryptStoredCortexAiSecret,
  encryptStoredOpenRouterApiKey,
  resealStoredCortexAiSecrets,
} from './ai-config';
import { resolveCortexAiStockPhotoProviders } from './ai-global-agent-tools';

/**
 * 2026-11-04: stored secret envelopes were not bound to their row, so a session that could write
 * site_settings could move one key's envelope into another row, where a different consumer would
 * decrypt it (and the SMTP resolver would send it to a host of the writer's choosing). Each Cortex
 * AI key is now sealed for its own row and opens nowhere else; saves re-seal the keys stored
 * before 0.23.1, which still read.
 */

const TEST_KEY = 'cortex-secret-slot-test-key';
const OPENROUTER_KEY = 'sk-or-v1-operator-secret-0001';

/** An envelope exactly as 0.23.0 and earlier wrote it: version 1, no associated data. */
function legacyEnvelope(value: string, encryptionSecret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(encryptionSecret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    last4: value.slice(-4),
    updatedAt: '2026-01-02T03:04:05.000Z',
    version: 1,
  };
}

type Row = { key: string; value: unknown };

/** A site_settings client: `select … in` lists the rows; `update … eq … eq` is recorded. */
function settingsClient(rows: Row[], updateError: { message: string } | null = null) {
  const updates: Array<{ value: unknown; filters: Array<[string, unknown]> }> = [];
  return {
    updates,
    client: {
      from: (table: string) => {
        expect(table).toBe('site_settings');
        return {
          select: () => ({
            in: async (_column: string, keys: string[]) => ({
              data: rows.filter((row) => keys.includes(row.key)),
              error: null,
            }),
          }),
          update: (patch: { value: unknown }) => {
            const entry = { value: patch.value, filters: [] as Array<[string, unknown]> };
            updates.push(entry);
            const chain = {
              eq: (column: string, value: unknown) => {
                entry.filters.push([column, value]);
                return entry.filters.length === 2 ? Promise.resolve({ error: updateError }) : chain;
              },
            };
            return chain;
          },
        };
      },
    },
  };
}

beforeEach(() => {
  vi.stubEnv('NEXTBLOCK_ENCRYPTION_KEY', TEST_KEY);
  vi.stubEnv('PEXELS_API_KEY', '');
  vi.stubEnv('UNSPLASH_ACCESS_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Cortex AI keys are bound to their rows', () => {
  it('opens a key only from the row it was sealed for', () => {
    const pexels = encryptStoredCortexAiSecret(CORTEX_AI_PEXELS_SETTING_KEY, 'px-operator');

    expect(decryptStoredCortexAiSecret(CORTEX_AI_PEXELS_SETTING_KEY, pexels)).toBe('px-operator');
    expect(() => decryptStoredCortexAiSecret(CORTEX_AI_UNSPLASH_SETTING_KEY, pexels)).toThrow(
      'Failed to decrypt stored Unsplash access key.'
    );
    expect(() => decryptStoredOpenRouterApiKey(pexels)).toThrow('Failed to decrypt stored OpenRouter key.');
    expect(tryDecryptWithEnvKey(pexels, cortexAiSecretSlot(CORTEX_AI_OPENROUTER_SETTING_KEY))).toBeNull();
  });

  it('seals the OpenRouter key for its row', () => {
    const envelope = encryptStoredOpenRouterApiKey(OPENROUTER_KEY);

    expect(decryptStoredOpenRouterApiKey(envelope)).toBe(OPENROUTER_KEY);
    expect(tryDecryptWithEnvKey(envelope, cortexAiSecretSlot(CORTEX_AI_PEXELS_SETTING_KEY))).toBeNull();
    expect(cortexAiSecretSlot(CORTEX_AI_OPENROUTER_SETTING_KEY)).toBe('site_settings:cortex_ai_openrouter_api_key');
  });

  it('still opens a key stored before 0.23.1', () => {
    expect(decryptStoredOpenRouterApiKey(legacyEnvelope(OPENROUTER_KEY, TEST_KEY))).toBe(OPENROUTER_KEY);
  });

  it('has a slot only for the three key rows', () => {
    expect(() => cortexAiSecretSlot('cortex_ai_agent_settings' as never)).toThrow('not a Cortex AI key row');
  });

  it('never hands the OpenRouter key, copied into a stock-photo row, to that provider', async () => {
    const { client } = settingsClient([
      { key: CORTEX_AI_PEXELS_SETTING_KEY, value: encryptStoredOpenRouterApiKey(OPENROUTER_KEY) },
      { key: CORTEX_AI_UNSPLASH_SETTING_KEY, value: encryptStoredCortexAiSecret(CORTEX_AI_UNSPLASH_SETTING_KEY, 'us-operator') },
    ]);

    const providers = await resolveCortexAiStockPhotoProviders(client);

    expect(providers).toEqual([{ apiKey: 'us-operator', provider: 'unsplash' }]);
  });
});

describe('resealStoredCortexAiSecrets', () => {
  it('re-seals a key from before 0.23.1 for its row, only while the row still holds it', async () => {
    const legacy = legacyEnvelope(OPENROUTER_KEY, TEST_KEY);
    const bound = encryptStoredCortexAiSecret(CORTEX_AI_PEXELS_SETTING_KEY, 'px-operator');
    const { client, updates } = settingsClient([
      { key: CORTEX_AI_OPENROUTER_SETTING_KEY, value: legacy },
      { key: CORTEX_AI_PEXELS_SETTING_KEY, value: bound },
      { key: CORTEX_AI_UNSPLASH_SETTING_KEY, value: 'not an envelope' },
    ]);

    await expect(resealStoredCortexAiSecrets(client)).resolves.toBe(1);

    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update.filters).toEqual([
      ['key', CORTEX_AI_OPENROUTER_SETTING_KEY],
      ['value->>ciphertext', legacy.ciphertext],
    ]);
    expect((update.value as { version: number }).version).toBe(2);
    expect(decryptStoredOpenRouterApiKey(update.value)).toBe(OPENROUTER_KEY);
    expect(tryDecryptWithEnvKey(update.value, cortexAiSecretSlot(CORTEX_AI_PEXELS_SETTING_KEY))).toBeNull();
  });

  it('never fails the save it runs in: an error is logged without any key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = settingsClient(
      [{ key: CORTEX_AI_OPENROUTER_SETTING_KEY, value: legacyEnvelope(OPENROUTER_KEY, TEST_KEY) }],
      { message: 'permission denied' }
    );

    await expect(resealStoredCortexAiSecrets(client)).resolves.toBe(0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(OPENROUTER_KEY);
  });
});
