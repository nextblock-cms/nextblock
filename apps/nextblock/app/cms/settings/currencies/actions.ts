'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  clearAutoSyncedCurrencyPriceOverrides,
  normalizeCurrencyRoundingMode,
  rebaseStoreCurrencyExchangeRates,
  syncStoreCurrencyRates,
} from '@nextblock-cms/ecommerce/server';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import { majorUnitAmountToMinor } from '@nextblock-cms/utils';

const CURRENCY_SETTINGS_PATH = '/cms/settings/currencies';

type ExistingCurrency = {
  id: string;
  code: string;
  exchange_rate: number;
  exchange_rate_source: string | null;
  exchange_rate_updated_at: string | null;
  auto_sync_product_prices: boolean | null;
  is_default: boolean;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBoolean(value: FormDataEntryValue | null) {
  return value === 'on' || value === 'true';
}

function parseCurrencyId(value: FormDataEntryValue | null) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();
  return UUID_PATTERN.test(normalizedValue) ? normalizedValue : null;
}

function parseExchangeRate(value: FormDataEntryValue | null) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Exchange rate must be a positive number.');
  }

  return parsed;
}

function parseMinorUnitAmount(params: {
  allowNull?: boolean;
  allowZero?: boolean;
  currencyCode: string;
  label: string;
  value: FormDataEntryValue | null;
}) {
  const {
    allowNull = false,
    allowZero = false,
    currencyCode,
    label,
    value,
  } = params;
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    if (allowNull) {
      return null;
    }

    throw new Error(`${label} is required.`);
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number.`);
  }

  const minorUnitAmount = majorUnitAmountToMinor(parsed, currencyCode);

  if (allowZero ? minorUnitAmount < 0 : minorUnitAmount <= 0) {
    throw new Error(
      `${label} must be ${allowZero ? 'zero or greater' : 'greater than zero'}.`
    );
  }

  return minorUnitAmount;
}

function redirectWithStatus(status: 'success' | 'error', message: string): never {
  redirect(`${CURRENCY_SETTINGS_PATH}?${status}=${encodeURIComponent(message)}`);
}

function revalidateCurrencySurfaces() {
  revalidatePath(CURRENCY_SETTINGS_PATH);
  revalidatePath('/cms/products');
  revalidatePath('/cms/products/new');
  revalidatePath('/', 'layout');
}

export async function upsertCurrencyAction(formData: FormData) {
  let successMessage = 'Currency saved.';

  try {
    // Server actions are public POST endpoints: authorize before the service-role client.
    const { supabase } = await requireCmsAdmin();
    const id = parseCurrencyId(formData.get('id'));
    const code = String(formData.get('code') || '').trim().toUpperCase();
    const symbol = String(formData.get('symbol') || '').trim();
    const requestedExchangeRate = parseExchangeRate(formData.get('exchange_rate'));
    const isDefault = parseBoolean(formData.get('is_default'));
    const isActive = parseBoolean(formData.get('is_active'));
    const autoUpdateExchangeRate = parseBoolean(
      formData.get('auto_update_exchange_rate')
    );
    const autoSyncProductPrices = parseBoolean(
      formData.get('auto_sync_product_prices')
    );

    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error('Currency code must be a 3-letter ISO 4217 value.');
    }

    if (!symbol) {
      throw new Error('Currency symbol is required.');
    }

    const roundingMode = normalizeCurrencyRoundingMode(formData.get('rounding_mode'));
    const parsedRoundingIncrement = parseMinorUnitAmount({
      currencyCode: code,
      label: 'Rounding increment',
      value: formData.get('rounding_increment'),
    });
    if (parsedRoundingIncrement === null) {
      throw new Error('Rounding increment is required.');
    }

    const roundingIncrement = parsedRoundingIncrement;
    const roundingCharmAmount = parseMinorUnitAmount({
      allowNull: true,
      allowZero: true,
      currencyCode: code,
      label: 'Charm ending',
      value: formData.get('rounding_charm_amount'),
    });

    if (roundingMode === 'charm' && roundingCharmAmount === null) {
      throw new Error('Charm ending is required when charm rounding is selected.');
    }

    const { data: existingCurrencies, error: existingCurrenciesError } = await supabase
      .from('currencies')
      .select(
        'id, code, exchange_rate, exchange_rate_source, exchange_rate_updated_at, auto_sync_product_prices, is_default'
      )
      .order('code', { ascending: true });

    if (existingCurrenciesError) {
      throw new Error(existingCurrenciesError.message);
    }

    const currencies = (existingCurrencies || []) as ExistingCurrency[];
    const previousDefaultCurrency =
      currencies.find((currency) => currency.is_default) || null;
    const existingTargetCurrency =
      (id ? currencies.find((currency) => currency.id === id) : null) ||
      currencies.find((currency) => currency.code === code) ||
      null;
    const targetCurrencyId = id || existingTargetCurrency?.id || null;

    if (id && !existingTargetCurrency) {
      throw new Error('The selected currency could not be found. Please refresh and try again.');
    }

    if (existingTargetCurrency?.is_default && !isDefault) {
      throw new Error('Choose another default currency before unsetting the current one.');
    }

    const hasManualRateChange =
      !existingTargetCurrency ||
      Math.abs(existingTargetCurrency.exchange_rate - requestedExchangeRate) > 0.0000000001;
    const shouldAutoSyncProductPrices = isDefault ? false : autoSyncProductPrices;
    const nowIso = new Date().toISOString();

    const payload = {
      auto_update_exchange_rate: isDefault ? false : autoUpdateExchangeRate,
      auto_sync_product_prices: shouldAutoSyncProductPrices,
      code,
      exchange_rate: isDefault ? 1 : requestedExchangeRate,
      exchange_rate_source: isDefault
        ? 'store-default'
        : hasManualRateChange
          ? 'manual'
          : existingTargetCurrency?.exchange_rate_source || 'manual',
      exchange_rate_updated_at: isDefault
        ? nowIso
        : hasManualRateChange
          ? nowIso
          : existingTargetCurrency?.exchange_rate_updated_at || nowIso,
      is_active: isDefault ? true : isActive,
      is_default: isDefault,
      rounding_charm_amount:
        roundingMode === 'charm' ? roundingCharmAmount : null,
      rounding_increment: roundingIncrement,
      rounding_mode: roundingMode,
      symbol,
      updated_at: nowIso,
    };

    if (targetCurrencyId) {
      const { error } = await supabase
        .from('currencies')
        .upsert(
          {
            id: targetCurrencyId,
            ...payload,
          },
          {
            onConflict: 'id',
          }
        );

      if (error) {
        throw new Error(error.message);
      }
    } else {
      const { error } = await supabase.from('currencies').insert(payload);

      if (error) {
        throw new Error(error.message);
      }
    }

    if (shouldAutoSyncProductPrices) {
      await clearAutoSyncedCurrencyPriceOverrides(code);
    }

    if (
      isDefault &&
      previousDefaultCurrency &&
      previousDefaultCurrency.code !== code
    ) {
      await rebaseStoreCurrencyExchangeRates({
        newDefaultCurrencyCode: code,
        previousBaseRate:
          existingTargetCurrency?.exchange_rate || requestedExchangeRate,
      });

      successMessage = `${code} is now the default currency, and all exchange rates were rebased.`;
    } else {
      successMessage = `${code} saved successfully.`;
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to save currency settings.'
    );
  }

  revalidateCurrencySurfaces();
  redirectWithStatus('success', successMessage);
}

export async function syncCurrencyRatesAction() {
  let successMessage = 'Currency rates synced successfully.';

  try {
    await requireCmsAdmin();
    const result = await syncStoreCurrencyRates();

    successMessage =
      result.updatedCurrencies.length > 0
        ? `Synced ${result.updatedCurrencies.length} currency rate${
            result.updatedCurrencies.length === 1 ? '' : 's'
          } from ${result.provider}.`
        : 'No auto-updating currencies were enabled, so no exchange rates changed.';
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to sync live currency rates.'
    );
  }

  revalidateCurrencySurfaces();
  redirectWithStatus('success', successMessage);
}

export async function deleteCurrencyAction(formData: FormData) {
  let successMessage = 'Currency deleted.';

  try {
    // Server actions are public POST endpoints: authorize before the service-role client.
    const { supabase } = await requireCmsAdmin();
    const id = String(formData.get('id') || '').trim();

    if (!id) {
      throw new Error('Currency ID is required.');
    }

    const { data: currency, error: fetchError } = await supabase
      .from('currencies')
      .select('id, code, is_default')
      .eq('id', id)
      .single();

    if (fetchError || !currency) {
      throw new Error(fetchError?.message || 'Currency not found.');
    }

    if (currency.is_default) {
      throw new Error('Set another currency as default before deleting this one.');
    }

    const { error } = await supabase.from('currencies').delete().eq('id', id);

    if (error) {
      throw new Error(error.message);
    }

    successMessage = `${currency.code} deleted successfully.`;
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to delete currency.'
    );
  }

  revalidateCurrencySurfaces();
  redirectWithStatus('success', successMessage);
}
