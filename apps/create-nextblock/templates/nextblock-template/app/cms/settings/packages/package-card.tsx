'use client';

import { describePackageOffer, getPackageById, hasPackageCheckout, type PackageDef } from '@nextblock-cms/utils';
import { Button } from '@nextblock-cms/ui';
import { deactivatePackage, type PackageActivationProvenance } from '../../../actions/package-actions';
import { toast } from 'sonner';
import { useState } from 'react';
import { Loader2, CheckCircle, ExternalLink, FlaskConical, KeyRound, Sparkles } from 'lucide-react';

import { PackageCheckoutDialog } from './PackageCheckoutDialog';

const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

/** How to switch on a package the dashboard cannot sell yet (no Freemius product). */
const ACTIVATION_GUIDE_URLS: Readonly<Record<string, string>> = {
    affiliates: 'https://github.com/nextblock-cms/nextblock/blob/master/docs/15-AFFILIATES-AND-STOREFRONTS.md',
};

interface PackageCardProps {
    pkg: PackageDef;
    isActive: boolean;
    /** The last license for this package was expired or cancelled at Freemius. */
    isExpired?: boolean;
    licenseKey?: string;
    /** `meta.nextblock` of the activation row, when the key came through the dashboard checkout. */
    provenance?: PackageActivationProvenance | null;
    /**
     * Required packages (`pkg.requires`) that are not active. An add-on offers no trial or checkout
     * until they are, and an active one is paused: the app treats it as inactive meanwhile.
     */
    missingRequirements?: ReadonlyArray<{ id: string; name: string }>;
}

/** "NextBlock™ Commerce Pro" reads as "Commerce Pro" inside a sentence. */
function shortPackageName(name: string): string {
    return name.replace(/^NextBlock(?:™)?\s+/, '');
}

function formatDate(value: string) {
    const parsed = Date.parse(value.includes('T') || /z$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);

    if (!Number.isFinite(parsed)) {
        return value;
    }

    return new Date(parsed).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function PackageCard({ pkg, isActive, isExpired = false, licenseKey, provenance, missingRequirements = [] }: PackageCardProps) {
    const [loading, setLoading] = useState(false);
    const [checkoutOpen, setCheckoutOpen] = useState(false);
    const offer = describePackageOffer(pkg);
    // No Freemius product yet: no trial, no checkout, and no license key can activate it either
    // (activateLicenseKeyWithFreemius skips a package without one). Only the sandbox key or a
    // development activation row switch it on (docs/15 -> "Activating it").
    const canCheckout = hasPackageCheckout(pkg);
    const activationGuideUrl = ACTIVATION_GUIDE_URLS[pkg.id] ?? pkg.purchase_url;

    const handleDeactivate = async () => {
        if (!confirm('Are you sure you want to deactivate this package? functionality will be locked instantly.')) return;
        setLoading(true);
        try {
            const res = await deactivatePackage(pkg.id);
            if (res && 'error' in res) {
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
    // An add-on (Affiliates needs Commerce Pro) is sold and runs only on top of its base packages.
    const baseNames = pkg.requires.map((packageId) => shortPackageName(getPackageById(packageId)?.name ?? packageId)).join(' and ');
    const missingNames = missingRequirements.map((required) => shortPackageName(required.name)).join(' and ');
    const blocked = missingNames !== '';

    return (
        <>
            {canCheckout && !blocked ? <PackageCheckoutDialog onOpenChange={setCheckoutOpen} open={checkoutOpen} pkg={pkg} /> : null}

            <div className="border rounded-lg p-6 flex flex-col justify-between h-full bg-card shadow-sm">
                <div>
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <h3 className="text-xl font-semibold">{pkg.name}</h3>
                            {isActive && blocked ? (
                                <span className="inline-flex items-center text-xs font-medium px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 mt-1">
                                    Paused
                                </span>
                            ) : isActive ? (
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
                    {baseNames ? (
                        <p className="mb-3 text-sm font-medium text-foreground">Add-on for {baseNames}.</p>
                    ) : null}
                    {blocked ? (
                        <p className="mb-3 text-sm text-amber-800 dark:text-amber-300" role="note">
                            {isActive
                                ? `Paused until ${missingNames} is active: nothing runs, and its data is kept.`
                                : `Requires ${missingNames}. Activate ${missingNames} first.`}
                        </p>
                    ) : null}
                    {!isActive && !canCheckout && (
                        <p className="mb-6 text-sm text-muted-foreground">
                            Not sold in the dashboard yet.
                        </p>
                    )}
                    {!isActive && canCheckout && (
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
                    ) : !canCheckout ? (
                        <div className="flex flex-col gap-2">
                            <p className="flex items-start gap-2 text-xs text-muted-foreground">
                                <KeyRound aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                {isSandbox
                                    ? 'The sandbox switches this package on with its sandbox key.'
                                    : 'A license key cannot activate it until it goes on sale. The activation guide covers development databases.'}
                            </p>
                            <a
                                className="inline-flex items-center justify-center text-xs text-muted-foreground hover:underline"
                                href={activationGuideUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                            >
                                Activation guide
                                <ExternalLink aria-hidden="true" className="ml-1 w-3 h-3" />
                            </a>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <Button className="w-full" disabled={blocked} onClick={() => setCheckoutOpen(true)}>
                                {isSandbox ? (
                                    <FlaskConical className="mr-2 w-4 h-4" />
                                ) : (
                                    <Sparkles className="mr-2 w-4 h-4" />
                                )}
                                {blocked
                                    ? `Requires ${missingNames}`
                                    : isSandbox
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
