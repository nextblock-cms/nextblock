import type postgres from 'postgres';

/** Use the reset's SQL connection; PostgREST can be unavailable during schema rebuilds. */
export async function activateSandboxPackage(
  db: postgres.Sql<Record<string, unknown>>,
  packageId: string,
  licenseKey: string,
  siteUrl: string,
): Promise<void> {
  await db`
    INSERT INTO public.package_activations
      (package_id, license_key, status, instance_name, last_validated_at)
    VALUES (${packageId}, ${licenseKey}, 'active', ${siteUrl}, now())
    ON CONFLICT (license_key, package_id) DO UPDATE
    SET status = EXCLUDED.status,
        instance_name = EXCLUDED.instance_name,
        last_validated_at = EXCLUDED.last_validated_at
  `;
}
