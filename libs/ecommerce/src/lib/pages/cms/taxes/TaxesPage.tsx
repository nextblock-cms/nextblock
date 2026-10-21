import 'server-only';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nextblock-cms/ui';
import { ArrowLeft, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { getEcommerceInventorySettings } from '../../../inventory-settings';
import { resolveSubdivisionName } from '../../../states';
import type { TaxRate } from '../../../types';
import { getEnabledPaymentProviders } from '../payments/queries';
import { deleteTaxRateAction, updateTaxSettingsAction } from './actions';
import { TaxRateForm } from './components/TaxRateForm';

function formatRatePercent(value: number) {
  return `${value.toFixed(4).replace(/\.?0+$/, '')}%`;
}

function formatJurisdiction(rate: TaxRate) {
  if (!rate.state_code) {
    return `${rate.country_code} - Country-wide`;
  }

  return `${rate.country_code} - ${resolveSubdivisionName(rate.country_code, rate.state_code)}`;
}

export async function TaxesPage({
  searchParams,
}: {
  searchParams?: { success?: string };
}) {
  const supabase = createClient();
  const adminSupabase = getServiceRoleSupabaseClient();
  const [settings, enabledProviders, taxRatesResponse] = await Promise.all([
    getEcommerceInventorySettings(supabase),
    getEnabledPaymentProviders(),
    adminSupabase
      .from('tax_rates')
      .select('id, country_code, state_code, tax_name, tax_rate, created_at, updated_at')
      .order('country_code')
      .order('state_code')
      .order('tax_name'),
  ]);

  const taxRates = (taxRatesResponse.data || []) as TaxRate[];
  const taxRatesError = taxRatesResponse.error;
  const isStripeEnabled = enabledProviders.stripe;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
      {searchParams?.success ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {searchParams.success}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" aria-label="Back to shipping">
            <Link href="/cms/shipping">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Tax Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure Stripe tax behavior globally and maintain manual country or
              state/province tax rates for physical goods.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={isStripeEnabled ? 'default' : 'outline'} className="uppercase">
            Stripe {isStripeEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <div className="rounded-full border bg-muted/30 p-3 text-muted-foreground">
            <Settings2 className="h-5 w-5" />
          </div>
        </div>
      </div>

      {!isStripeEnabled ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle>Enable Stripe to configure physical-product taxes</CardTitle>
            <CardDescription>
              Stripe tax settings apply whenever Stripe is enabled for physical products. Freemius
              still handles taxes on its own digital checkout flow.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/cms/payments">Open Payment Settings</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Global Tax Controls</CardTitle>
              <CardDescription>
                Manual mode uses the tax rates below. Automatic mode uses Stripe Tax during Stripe
                Checkout instead of a free third-party tax API.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={updateTaxSettingsAction} className="space-y-6">
                <div className="rounded-lg border bg-muted/20 p-4">
                  <input type="hidden" name="enableTaxes" value="false" />
                  <label htmlFor="enable-taxes" className="flex cursor-pointer items-start gap-3">
                    <input
                      id="enable-taxes"
                      name="enableTaxes"
                      type="checkbox"
                      value="true"
                      defaultChecked={settings.enableTaxes}
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                    />
                    <span className="space-y-1">
                      <span className="block font-medium">Enable taxes</span>
                      <span className="block text-sm text-muted-foreground">
                        When disabled, tax totals resolve to zero even if product or jurisdiction
                        records exist.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-2">
                    <label
                      htmlFor="tax-calculation-mode"
                      className="text-sm font-medium text-foreground"
                    >
                      Tax calculation mode
                    </label>
                    <select
                      id="tax-calculation-mode"
                      name="taxCalculationMode"
                      defaultValue={settings.taxCalculationMode}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="manual">Manual tax rates</option>
                      <option value="automatic">Automatic via Stripe Tax</option>
                    </select>
                    <p className="text-sm text-muted-foreground">
                      Automatic mode depends on your Stripe Tax setup. Manual rates stay saved and
                      can be used again if you switch back later.
                    </p>
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit">Save Tax Settings</Button>
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Manual Tax Rates</CardTitle>
                  <CardDescription>
                    Add combined taxes as separate rows. For example, create both GST and PST for
                    the same province if they should stack.
                  </CardDescription>
                </div>
                <Badge variant={settings.taxCalculationMode === 'manual' ? 'default' : 'outline'}>
                  {settings.taxCalculationMode === 'manual' ? 'Active Mode' : 'Stored for Manual Mode'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {taxRatesError ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  Tax rates couldn&apos;t be loaded yet. This usually means the new tax migration
                  hasn&apos;t been applied to the current database.
                </div>
              ) : null}

              {!taxRatesError ? (
                <>
                  <div className="rounded-xl border bg-card p-4">
                    <div className="mb-4 flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-primary" />
                      <h2 className="font-semibold">Create a Tax Rate</h2>
                    </div>
                    <TaxRateForm />
                  </div>

                  <div className="space-y-4">
                    {taxRates.length === 0 ? (
                      <div className="rounded-xl border border-dashed bg-muted/10 px-4 py-8 text-center">
                        <p className="font-medium">No manual tax rates yet</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Add country-wide or state/province-specific rows to start calculating
                          manual taxes.
                        </p>
                      </div>
                    ) : (
                      taxRates.map((rate) => (
                        <Card key={rate.id} className="border-muted">
                          <CardHeader className="pb-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <CardTitle className="text-base">{rate.tax_name}</CardTitle>
                                <CardDescription>{formatJurisdiction(rate)}</CardDescription>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">
                                  {formatRatePercent(Number(rate.tax_rate))}
                                </Badge>
                                <form
                                  action={async () => {
                                    'use server';
                                    await deleteTaxRateAction(rate.id);
                                  }}
                                >
                                  <Button
                                    type="submit"
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Delete tax rate"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </form>
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent>
                            <TaxRateForm
                              initialData={rate}
                              submitLabel="Update tax rate"
                              compact
                            />
                          </CardContent>
                        </Card>
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
