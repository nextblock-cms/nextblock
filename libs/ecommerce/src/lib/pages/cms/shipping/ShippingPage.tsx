import 'server-only';

import React from 'react';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { 
    Card, CardContent, CardDescription, CardHeader, CardTitle,
    Button, Badge, TooltipProvider, Tooltip, TooltipTrigger, TooltipContent
} from '@nextblock-cms/ui';
import { Trash2, Globe, Truck, Info, Boxes } from 'lucide-react';
import { ZoneForm } from './components/ZoneForm';
import { RateForm } from './components/RateForm';
import { deleteShippingZone, deleteShippingRate, updateInventoryTrackingAction } from './server-actions';
import { normalizeCurrencyRecord } from '../../../currency';
import { getEcommerceInventorySettings } from '../../../inventory-settings';
import { resolveSubdivisionName } from '../../../states';
import { formatPrice } from '@nextblock-cms/utils';

export async function ShippingPage({
    searchParams,
}: {
    searchParams?: { success?: string };
}) {
    // Using service role for admin view to ensure all zones are visible and manageable
    const supabase = getServiceRoleSupabaseClient();
    
    const [{ data: zones }, settings, { data: languages }, { data: currencies }] = await Promise.all([
        supabase
            .from('shipping_zones')
            .select(`
                *,
                shipping_zone_locations (*),
                shipping_zone_methods (*)
            `)
            .order('priority_order', { ascending: true }),
        getEcommerceInventorySettings(supabase as any),
        supabase
            .from('languages')
            .select('code, name, is_default')
            .eq('is_active', true)
            .order('name', { ascending: true }),
        supabase
            .from('currencies')
            .select(
                'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
            )
            .eq('is_active', true)
            .order('is_default', { ascending: false })
            .order('code', { ascending: true }),
    ]);
    const defaultCurrencyCode =
        currencies?.find((currency) => currency.is_default)?.code || currencies?.[0]?.code || 'USD';
    const shippingCurrencies = (currencies || []).map((currency) =>
        normalizeCurrencyRecord(currency)
    );

    return (
        <TooltipProvider>
            <div className="space-y-6">
                {searchParams?.success ? (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                        {searchParams.success}
                    </div>
                ) : null}

                <Card className="overflow-hidden border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardContent className="p-4 sm:p-5">
                        <form action={updateInventoryTrackingAction} className="space-y-3">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                <div className="flex items-start gap-3 min-w-0">
                                    <div className="p-2 bg-primary/10 rounded-lg text-primary shadow-inner shrink-0">
                                        <Boxes className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <CardTitle className="text-base font-semibold leading-none">
                                            Inventory Tracking
                                        </CardTitle>
                                        <CardDescription className="mt-1 text-sm">
                                            Control whether checkout enforces stock counts and paid orders deduct inventory.
                                        </CardDescription>
                                    </div>
                                </div>
                                <div className="flex justify-end lg:justify-start shrink-0">
                                    <Button type="submit" size="sm" className="w-full sm:w-auto">
                                        Save Inventory Settings
                                    </Button>
                                </div>
                            </div>

                            <div className="rounded-lg border bg-muted/20 px-4 py-3">
                                <input type="hidden" name="trackQuantities" value="false" />
                                <label htmlFor="track-quantities" className="flex cursor-pointer items-start gap-3">
                                    <input
                                        id="track-quantities"
                                        name="trackQuantities"
                                        type="checkbox"
                                        value="true"
                                        defaultChecked={settings.trackQuantities}
                                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                                    />
                                    <span className="space-y-0.5">
                                        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                                            Track product quantities
                                        </span>
                                        <span className="block text-sm text-muted-foreground">
                                            Prevent overselling by checking stock during checkout and decrementing quantities after payment is confirmed.
                                        </span>
                                    </span>
                                </label>
                            </div>
                        </form>
                    </CardContent>
                </Card>

                <div className="flex justify-between items-center">
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Shipping Zones</h2>
                        <p className="text-slate-500 dark:text-slate-400 text-sm">Manage geographical delivery areas and their associated shipping rates.</p>
                    </div>
                    <ZoneForm />
                </div>

                <div className="grid gap-6">
                    {!zones || zones.length === 0 ? (
                        <Card className="bg-slate-50/50 dark:bg-slate-900/10 border-dashed">
                            <CardContent className="flex flex-col items-center justify-center py-12">
                                <Truck className="h-12 w-12 text-slate-300 dark:text-slate-700 mb-4" />
                                <p className="text-slate-600 dark:text-slate-400 font-medium">No shipping zones defined yet.</p>
                                <p className="text-xs text-slate-500 mb-6 text-center max-w-xs">Create a zone to start defining shipping rates for specific regions (e.g., North America, Europe).</p>
                            </CardContent>
                        </Card>
                    ) : (
                        zones.map((zone) => (
                            <Card key={zone.id} className="overflow-hidden border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md transition-shadow">
                                <CardHeader className="bg-slate-50/50 dark:bg-slate-900/50 border-b dark:border-slate-800 py-4">
                                    <div className="flex justify-between items-start md:items-center">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-primary/10 rounded-lg text-primary shadow-inner">
                                                <Globe className="h-5 w-5" />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <CardTitle className="text-lg font-bold">{zone.name}</CardTitle>
                                                    <Badge variant="outline" className="text-[10px] uppercase font-bold py-0 h-4 border-slate-200 bg-white/50 dark:bg-black/20">
                                                        Prio: {zone.priority_order}
                                                    </Badge>
                                                </div>
                                                <CardDescription className="text-xs">
                                                    {zone.shipping_zone_locations?.length || 0} regions covered
                                                </CardDescription>
                                            </div>
                                        </div>
                                        <div className="flex gap-1">
                                            <ZoneForm 
                                                mode="edit" 
                                                initialData={{
                                                    id: zone.id,
                                                    name: zone.name,
                                                    priority_order: zone.priority_order,
                                                    locations:
                                                      zone.shipping_zone_locations?.map((location: any) => ({
                                                        country_code: location.country_code,
                                                        state_code: location.state_code,
                                                      })) || []
                                                }} 
                                            />
                                            <form action={async () => {
                                                "use server";
                                                await deleteShippingZone(zone.id);
                                            }}>
                                                <Button type="submit" variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </form>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="p-0">
                                    <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100 dark:divide-slate-800">
                                        {/* Locations Column */}
                                        <div className="p-6">
                                            <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-4 flex items-center gap-1.5">
                                                <Globe className="h-3 w-3" /> Target Regions
                                            </h4>
                                            <div className="flex flex-wrap gap-1.5">
                                                {zone.shipping_zone_locations?.length > 0 ? (
                                                    zone.shipping_zone_locations.map((loc: any) => (
                                                        <Badge key={loc.id} variant="secondary" className="bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200 border-none px-2 py-0.5 text-[11px] font-medium">
                                                            {loc.country_code}
                                                            {loc.state_code ? (
                                                              <span className="text-slate-400 ml-1">
                                                                ({resolveSubdivisionName(loc.country_code, loc.state_code)})
                                                              </span>
                                                            ) : ''}
                                                        </Badge>
                                                    ))
                                                ) : (
                                                    <p className="text-sm text-slate-400 italic">No specific locations assigned.</p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Methods Column */}
                                        <div className="p-6">
                                            <div className="flex justify-between items-center mb-4">
                                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
                                                    <Truck className="h-3 w-3" /> Shipping Methods
                                                </h4>
                                                <RateForm
                                                  zoneId={zone.id}
                                                  zoneName={zone.name}
                                                  languages={languages || []}
                                                  currencies={shippingCurrencies}
                                                  defaultCurrencyCode={defaultCurrencyCode}
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                {zone.shipping_zone_methods?.length > 0 ? (
                                                    zone.shipping_zone_methods.map((method: any) => (
                                                        <div key={method.id} className="flex justify-between items-center group p-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/30 rounded-lg transition-all border border-transparent hover:border-slate-100 dark:hover:border-slate-800">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{method.name}</p>
                                                                    <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                                                        {method.currency_pricing_mode === 'manual' ? 'Manual FX' : 'Auto FX'}
                                                                    </Badge>
                                                                    {(method.min_order_amount || 0) > 0 && (
                                                                        <Tooltip>
                                                                            <TooltipTrigger asChild>
                                                                                <Badge variant="outline" className="h-4 px-1 text-[9px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-100 dark:border-emerald-900/50">
                                                                                    <Info className="h-2 w-2 mr-0.5" />
                                                                                    {formatPrice(
                                                                                        method.min_order_amount,
                                                                                        method.cost_currency?.toUpperCase() || defaultCurrencyCode
                                                                                    )}
                                                                                </Badge>
                                                                            </TooltipTrigger>
                                                                            <TooltipContent>
                                                                                Available for orders over {formatPrice(
                                                                                    method.min_order_amount,
                                                                                    method.cost_currency?.toUpperCase() || defaultCurrencyCode
                                                                                )}
                                                                            </TooltipContent>
                                                                        </Tooltip>
                                                                    )}
                                                                </div>
                                                                <p className="text-[10px] text-slate-500 uppercase tracking-tighter mix-blend-multiply dark:mix-blend-normal">
                                                                    {method.method_type.replace('_', ' ')}
                                                                </p>
                                                            </div>
                                                            <div className="flex items-center gap-1">
                                                                <p className="text-sm font-black text-primary px-2">
                                                                    {method.method_type === 'free_shipping'
                                                                        ? 'FREE'
                                                                        : formatPrice(
                                                                              method.cost_amount,
                                                                              method.cost_currency?.toUpperCase() || defaultCurrencyCode
                                                                          )}
                                                                </p>
                                                                <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
                                                                    <RateForm 
                                                                        zoneId={zone.id} 
                                                                        zoneName={zone.name} 
                                                                        languages={languages || []}
                                                                        currencies={shippingCurrencies}
                                                                        defaultCurrencyCode={defaultCurrencyCode}
                                                                        mode="edit" 
                                                                        initialData={method} 
                                                                    />
                                                                    <form action={async () => {
                                                                        "use server";
                                                                        await deleteShippingRate(method.id);
                                                                    }}>
                                                                        <Button 
                                                                            type="submit" 
                                                                            variant="ghost" 
                                                                            size="icon" 
                                                                            className="h-7 w-7 text-slate-400 hover:text-red-500"
                                                                        >
                                                                            <Trash2 className="h-3 w-3" />
                                                                        </Button>
                                                                    </form>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <p className="text-xs text-slate-400 italic">No methods defined for this zone.</p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    )}
                </div>
            </div>
        </TooltipProvider>
    );
}
