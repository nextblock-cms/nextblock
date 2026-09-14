import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';
import { createClient } from '@nextblock-cms/db/server';
import { ActivationForm } from './activation-form';
import { PackageCard } from './package-card';

export const dynamic = 'force-dynamic';

export default async function PackagesPage() {
  const supabase = await createClient();

  // Fetch all activations for this instance
  const { data: activations } = await supabase
    .from('package_activations')
    .select('package_id, status, license_key, meta')
    .in('status', ['active', 'expired']);

  // One row per package, an active one winning over an expired one.
  const activationMap = new Map();
  if (activations) {
      activations.forEach((a: any) => {
          const current = activationMap.get(a.package_id);
          if (!current || (current.status !== 'active' && a.status === 'active')) {
              activationMap.set(a.package_id, a);
          }
      });
  }

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
                    licenseKey={activation?.license_key}
                    provenance={provenance}
                />
            );
        })}
      </div>

      <ActivationForm />
    </div>
  );
}
