import { redirect } from 'next/navigation';
import { readCortexAiMcpEnvToken } from '@nextblock-cms/cortex';
import { createClient } from '@nextblock-cms/db/server';
import {
  detectChannel,
  isLocalWritableEnv,
  isSupabaseConfigured,
  type DeployChannel,
} from '../../lib/setup/env-status';
import { getProvisioningStatus } from '../../lib/setup/provisioning';
import SetupWizard, { type StoragePrefill } from './SetupWizard';

// Always evaluate live: the wizard's whole job is to react to the current env state.
export const dynamic = 'force-dynamic';

function buildStoragePrefill(channel: DeployChannel, supabaseUrl: string): StoragePrefill {
  if (channel === 'docker') {
    // The Docker stack ships MinIO as the S3 backend; docker-setup wrote these already.
    return {
      kind: 'minio',
      readOnly: true,
      accountId: process.env.R2_ACCOUNT_ID ?? 'minio',
      bucket: process.env.STORAGE_BUCKET ?? process.env.R2_BUCKET_NAME ?? 'media',
      endpoint: process.env.R2_S3_ENDPOINT ?? 'http://minio:9000',
      publicUrl: process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? 'http://localhost:9000',
      baseUrl: process.env.NEXT_PUBLIC_R2_BASE_URL ?? '',
      accessKeyId: '',
      secretAccessKey: '',
    };
  }

  if (channel === 'vercel') {
    // One-click Vercel deploys connect to Supabase Storage's S3-compatible endpoint.
    const base = supabaseUrl.replace(/\/$/, '');
    return {
      kind: 'supabase',
      readOnly: false,
      accountId: 'supabase',
      bucket: 'media',
      endpoint: base ? `${base}/storage/v1/s3` : '',
      publicUrl: base ? `${base}/storage/v1/object/public` : '',
      baseUrl: '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: '',
    };
  }

  // Local: the user brings their own Cloudflare R2 (higher free-tier storage).
  return {
    kind: 'r2',
    readOnly: false,
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    bucket: process.env.R2_BUCKET_NAME ?? '',
    endpoint: '',
    publicUrl: process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? '',
    baseUrl: process.env.NEXT_PUBLIC_R2_BASE_URL ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: '',
  };
}

export default async function SetupPage() {
  const status = await getProvisioningStatus();

  // Already finished — there's a first admin. Get out of the wizard.
  if (status.hasAdmin) {
    redirect('/cms/dashboard');
  }

  // A signed-in user never needs the wizard. This also closes the brief window right
  // after completion where is_admin_created may still be read-stale: the just-created
  // admin has a session, so send them straight to the CMS. (Only checked when
  // configured — an unconfigured instance has no real auth.)
  if (status.configured) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      redirect('/cms/dashboard');
    }
  }

  const channel = detectChannel();
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';

  return (
    <SetupWizard
      // An MCP_BEARER_TOKEN means `create-nextblock --non-interactive` made this install
      // for a coding agent that is now polling /api/setup/status; the wizard says so.
      agentInitiated={readCortexAiMcpEnvToken() !== null}
      channel={channel}
      configured={isSupabaseConfigured()}
      writable={isLocalWritableEnv()}
      siteUrl={process.env.NEXT_PUBLIC_URL ?? ''}
      storagePrefill={buildStoragePrefill(channel, supabaseUrl)}
      supabaseEnvDetected={{
        NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
        SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
        NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        ),
        SUPABASE_ANON_KEY: Boolean(
          process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY,
        ),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(
          process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
        ),
        POSTGRES_URL: Boolean(process.env.POSTGRES_URL),
      }}
    />
  );
}
