import 'server-only';

import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { ActivationForm } from './activation-form';
import { PackageCard } from './package-card';

export const dynamic = 'force-dynamic';

export default async function PackagesPage() {
  // Read with the service role, not the signed-in (cookie) client. Migration 02022 gates
  // `package_activations` SELECT behind `public.is_admin_mfa()` (ADMIN *and* an aal2 session
  // whenever an MFA factor is enrolled). An ADMIN who signed in with "remember this device"
  // passes the app's own 2FA gate (evaluateTwoFactor is satisfied by the trusted device) while
  // the Supabase session stays aal1, so a cookie-client read would return nothing and lock the
  // admin out of their own packages screen. This page is ADMIN-only (/cms/settings, enforced by
  // proxy.ts) and sits behind the /cms 2FA gate (app/cms/layout.tsx); the RLS policy is left
  // untouched so direct PostgREST access stays protected. Mirrors verifyPackageOnline.
  type ActivationRow = {
    package_id: string;
    status: string;
    license_key: string | null;
    // jsonb provenance blob read dynamically below
    meta: any;
  };
  let activations: ActivationRow[] = [];

  try {
    const supabase = getServiceRoleSupabaseClient();
    const { data } = await supabase
      .from('package_activations')
      .select('package_id, status, license_key, meta')
      .in('status', ['active', 'expired']);
    activations = (data ?? []) as unknown as ActivationRow[];
  } catch (err) {
    console.error('Packages page activation read failed:', err);
  }

  // One row per package, an active one winning over an expired one.
  const activationMap = new Map<string, ActivationRow>();
  activations.forEach((a) => {
    const current = activationMap.get(a.package_id);
    if (!current || (current.status !== 'active' && a.status === 'active')) {
      activationMap.set(a.package_id, a);
    }
  });

  return (
    <div className="container mx-auto py-10 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My Packages</h1>
        <p className="text-muted-foreground mt-2">
          Start a trial or buy a package right here; it activates on this site automatically after
          checkout. Already have a key? Paste it below.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
        {Object.values(NEXTBLOCK_PACKAGES).map((pkg) => {
            const activation = activationMap.get(pkg.id);
            const meta = activation?.meta;
            const provenance =
                meta && typeof meta === 'object' && !Array.isArray(meta) && meta.nextblock && typeof meta.nextblock === 'object'
                    ? meta.nextblock
                    : null;

            return (
                <PackageCard
                    key={pkg.id}
                    pkg={pkg}
                    isActive={activation?.status === 'active'}
                    isExpired={activation?.status === 'expired'}
                    licenseKey={activation?.license_key ?? undefined}
                    provenance={provenance}
                />
            );
        })}
      </div>

      <ActivationForm />
    </div>
  );
}
