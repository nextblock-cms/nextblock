'use client';

import { describePackageOffer, type PackageDef } from '@nextblock-cms/utils';
import { Button } from '@nextblock-cms/ui/button';
import { deactivatePackage, type PackageActivationProvenance } from '../../../actions/package-actions';
import { toast } from 'sonner';
import { useState } from 'react';
import { Loader2, CheckCircle, ExternalLink, FlaskConical, Sparkles } from 'lucide-react';

import { PackageCheckoutDialog } from './PackageCheckoutDialog';

const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

interface PackageCardProps {
    pkg: PackageDef;
    isActive: boolean;
    /** The last license for this package was expired or cancelled at Freemius. */
    isExpired?: boolean;
    licenseKey?: string;
    /** `meta.nextblock` of the activation row, when the key came through the dashboard checkout. */
    provenance?: PackageActivationProvenance | null;
}

function formatDate(value: string) {
    const parsed = Date.parse(value.includes('T') || /z$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);

    if (!Number.isFinite(parsed)) {
        return value;
    }

    return new Date(parsed).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function PackageCard({ pkg, isActive, isExpired = false, licenseKey, provenance }: PackageCardProps) {
    const [loading, setLoading] = useState(false);
    const [checkoutOpen, setCheckoutOpen] = useState(false);
    const offer = describePackageOffer(pkg);

    const handleDeactivate = async () => {
        if (!confirm('Are you sure you want to deactivate this package? functionality will be locked instantly.')) return;
        setLoading(true);
        try {
            const res = await deactivatePackage(pkg.id);
            if (res?.error) {
                toast.error(res.error);
            } else {
                toast.success('Package deactivated.');
            }
        } catch {
            toast.error('Deactivation failed');
        } finally {
            setLoading(false);
        }
    };

    const trialEndsAt = provenance?.is_trial ? provenance.trial_ends_at ?? provenance.expiration ?? null : null;

    return (
        <>
            <PackageCheckoutDialog onOpenChange={setCheckoutOpen} open={checkoutOpen} pkg={pkg} />

            <div className="border rounded-lg p-6 flex flex-col justify-between h-full bg-card shadow-sm">
                <div>
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <h3 className="text-xl font-semibold">{pkg.name}</h3>
                            {isActive ? (
                                <span className="inline-flex items-center text-xs font-medium px-2.5 py-0.5 rounded-full bg-green-100 text-green-800 mt-1">
                                    <CheckCircle className="w-3 h-3 mr-1" />
                                    {provenance?.is_trial ? 'Trial active' : 'Active'}
                                </span>
                            ) : isExpired ? (
                                <span className="inline-flex items-center text-xs font-medium px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 mt-1">
                                    {provenance?.is_trial ? 'Trial ended' : 'License expired'}
                                </span>
                            ) : (
                                <span className="inline-flex items-center text-xs font-medium px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-800 mt-1">
                                    Inactive
                                </span>
                            )}
                        </div>
                    </div>
                    <p className="text-muted-foreground mb-3">{pkg.tagline}</p>
                    {!isActive && (
                        <p className="mb-6 text-sm">
                            {pkg.trial ? (
                                <>
                                    <span className="font-semibold text-foreground">
                                        Free {pkg.trial.days}-day trial
                                        {pkg.trial.requiresPaymentMethod ? '' : ', no credit card required'}
                                    </span>
                                    <span className="text-muted-foreground"> · then {offer.priceLine}</span>
                                </>
                            ) : (
                                <span className="font-semibold text-foreground">{offer.priceLine}</span>
                            )}
                        </p>
                    )}
                </div>

                <div className="pt-4 border-t">
                    {isActive ? (
                        <div className="flex flex-col gap-3">
                            <div className="text-xs text-muted-foreground">
                                License: <span className="font-mono bg-muted px-1 rounded">{licenseKey ? `•••• ${licenseKey.slice(-4)}` : '••••'}</span>
                                {trialEndsAt ? <span className="block mt-1">Trial ends {formatDate(trialEndsAt)} · then {offer.priceLine}</span> : null}
                            </div>
                            <Button variant="outline" size="sm" onClick={handleDeactivate} disabled={loading || isSandbox} className="w-full text-destructive hover:text-destructive">
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Deactivate License'}
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <Button className="w-full" onClick={() => setCheckoutOpen(true)}>
                                {isSandbox ? (
                                    <FlaskConical className="mr-2 w-4 h-4" />
                                ) : (
                                    <Sparkles className="mr-2 w-4 h-4" />
                                )}
                                {isSandbox
                                    ? 'Buy License (Sandbox Demo)'
                                    : pkg.trial && !isExpired
                                        ? `Start free ${pkg.trial.days}-day trial`
                                        : 'Buy license'}
                            </Button>
                            <a
                                className="inline-flex items-center justify-center text-xs text-muted-foreground hover:underline"
                                href={pkg.purchase_url}
                                rel="noopener noreferrer"
                                target="_blank"
                            >
                                Or purchase on nextblock.dev
                                <ExternalLink className="ml-1 w-3 h-3" />
                            </a>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
