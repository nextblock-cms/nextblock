'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Separator,
  Spinner,
} from '@nextblock-cms/ui';
import type { DeployChannel } from '../../lib/setup/env-status';
import { completeSetup, saveSupabaseConnection } from '../../lib/setup/actions';
import { signInAction } from '../actions';

export type StorageKind = 'minio' | 'supabase' | 'r2';

export interface StoragePrefill {
  kind: StorageKind;
  readOnly: boolean;
  accountId: string;
  bucket: string;
  endpoint: string;
  publicUrl: string;
  baseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SupabaseEnvDetected {
  NEXT_PUBLIC_SUPABASE_URL: boolean;
  SUPABASE_URL: boolean;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: boolean;
  SUPABASE_ANON_KEY: boolean;
  SUPABASE_SERVICE_ROLE_KEY: boolean;
  POSTGRES_URL: boolean;
}

interface Props {
  /** A coding agent installed this site headlessly and is waiting for the first admin + Cortex trial. */
  agentInitiated?: boolean;
  channel: DeployChannel;
  configured: boolean;
  writable: boolean;
  siteUrl: string;
  storagePrefill: StoragePrefill;
  /** Which Supabase env vars the running deployment can actually see (read-only channels). */
  supabaseEnvDetected: SupabaseEnvDetected;
}

// Email (SMTP), bot protection, and sign-up policy are no longer collected here — they
// moved to the CMS (Settings → Configuration) and are nudged from the dashboard onboarding
// checklist. A fresh install only needs the database connection, media storage, and the
// first administrator account.
type StepId = 'connection' | 'storage' | 'admin';

const STEP_TITLES: Record<StepId, string> = {
  connection: 'Database connection',
  storage: 'Media storage',
  admin: 'Administrator account',
};

const CHANNEL_LABEL: Record<DeployChannel, string> = {
  docker: 'Self-hosted Docker',
  vercel: 'Vercel',
  local: 'Local development',
};

type Msg = { ok: string } | { err: string } | null;

export default function SetupWizard({
  agentInitiated = false,
  channel,
  configured,
  writable,
  siteUrl,
  storagePrefill,
  supabaseEnvDetected,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<Msg>(null);
  const [phase, setPhase] = useState<'form' | 'working' | 'done'>('form');

  // Connection (Profile B / local only).
  const [conn, setConn] = useState({
    supabaseUrl: '',
    anonKey: '',
    serviceRoleKey: '',
    postgresUrl: '',
    accessToken: '',
    siteUrl,
  });
  const [connectionDone, setConnectionDone] = useState(configured);
  // "Start from a clean database" — only offered/honored on a local fresh install.
  const [resetFirst, setResetFirst] = useState(true);

  // Storage / admin.
  const [storage, setStorage] = useState(storagePrefill);
  const [admin, setAdmin] = useState({ email: '', password: '', fullName: '' });

  const steps = useMemo<StepId[]>(() => {
    const list: StepId[] = [];
    if (!configured) {
      list.push('connection');
    }
    // Skip the storage step when there's nothing for the user to configure: one-click Vercel
    // deploys use the connected Supabase project with zero keys (native Supabase Storage), and
    // the Docker stack ships MinIO already wired up by docker-setup (a read-only prefill).
    if (channel !== 'vercel' && !storagePrefill.readOnly) {
      list.push('storage');
    }
    list.push('admin');
    return list;
  }, [configured, channel, storagePrefill.readOnly]);

  const [stepIndex, setStepIndex] = useState(0);
  const current = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const setOk = (ok: string) => setMessage({ ok });
  const setErr = (err: string) => setMessage({ err });

  const goNext = () => {
    setMessage(null);
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };
  const goBack = () => {
    setMessage(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  // --- Step actions ------------------------------------------------------------

  const handleSaveConnection = () => {
    setMessage(null);
    if (!conn.accessToken.trim() && !conn.postgresUrl.trim()) {
      setErr(
        'Provide a Supabase access token (recommended) or a Postgres connection string so the schema can be applied.',
      );
      return;
    }
    startTransition(async () => {
      const result = await saveSupabaseConnection({
        supabaseUrl: conn.supabaseUrl,
        anonKey: conn.anonKey,
        serviceRoleKey: conn.serviceRoleKey,
        postgresUrl: conn.postgresUrl,
        accessToken: conn.accessToken,
        siteUrl: conn.siteUrl,
      });
      if (!result.ok) {
        setErr(result.error ?? 'Could not save the connection.');
        return;
      }
      setConnectionDone(true);
      setOk('Connection saved. The database schema is applied automatically when you finish.');
      goNext();
    });
  };

  const handleFinish = () => {
    if (!admin.email || !admin.password) {
      setErr('Enter an administrator email and password.');
      return;
    }
    if (admin.password.length < 8) {
      setErr('Use a password of at least 8 characters.');
      return;
    }

    const envValues: Record<string, string> = {};
    if (writable && channel === 'local') {
      const put = (k: string, v: string) => {
        if (v && v.trim()) envValues[k] = v.trim();
      };
      put('R2_ACCOUNT_ID', storage.accountId);
      put('R2_BUCKET_NAME', storage.bucket);
      put('R2_ACCESS_KEY_ID', storage.accessKeyId);
      put('R2_SECRET_ACCESS_KEY', storage.secretAccessKey);
      // Both must hold the bucket's public read URL: image src is built from
      // NEXT_PUBLIC_R2_BASE_URL, while next.config remotePatterns + CSP read
      // NEXT_PUBLIC_R2_PUBLIC_URL. The wizard collects one URL and writes it to both
      // (baseUrl only differs if a channel prefilled a separate custom domain).
      put('NEXT_PUBLIC_R2_PUBLIC_URL', storage.publicUrl);
      put('NEXT_PUBLIC_R2_BASE_URL', storage.baseUrl || storage.publicUrl);
    }

    setMessage(null);
    setPhase('working');
    startTransition(async () => {
      const result = await completeSetup({
        admin,
        envValues,
        resetFirst: resetFirst && writable,
      });

      if (!result.ok) {
        setErr(result.error ?? 'Setup failed.');
        setPhase('form');
        return;
      }

      // Establish the session via the canonical sign-in path (reliable cookie), which
      // redirects into the CMS. With the runtime public-env injection the client works
      // without a dev-server restart.
      const signInData = new FormData();
      signInData.append('email', admin.email.trim());
      signInData.append('password', admin.password);
      // Continue the stepper on the first signed-in page: /cms/welcome shows the Cortex
      // AI trial offer as a full step (with an equal "Not now"), then the Cortex setup
      // wizard, before the dashboard is ever shown. Package activation needs an admin
      // session, which is why that step cannot live in this pre-session wizard.
      signInData.append('redirect', '/cms/welcome');
      await signInAction(signInData);

      // signInAction redirects on success (and on failure, to /sign-in with a message),
      // so this only runs in the unlikely case it returned without navigating.
      setPhase('done');
    });
  };

  // --- Render ------------------------------------------------------------------

  if (phase === 'working') {
    return (
      <div className="space-y-6">
        <SetupProgress willReset={resetFirst && writable} />
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="space-y-6">
        <SetupDone />
      </div>
    );
  }

  const alert =
    message &&
    ('ok' in message ? (
      <Alert variant="success" className="py-2 px-4">
        <AlertDescription>{message.ok}</AlertDescription>
      </Alert>
    ) : (
      <Alert variant="destructive" className="py-2 px-4">
        <AlertDescription>{message.err}</AlertDescription>
      </Alert>
    ));

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold">Welcome to NextBlock</h1>
        <div className="text-sm text-muted-foreground">
          Let&rsquo;s get your CMS running. Detected environment:{' '}
          <Badge variant="secondary">{CHANNEL_LABEL[channel]}</Badge>
        </div>
      </div>

      <Stepper steps={steps} stepIndex={stepIndex} />

      <Card>
        <CardHeader>
          <CardTitle>{STEP_TITLES[current]}</CardTitle>
          <CardDescription>{stepDescription(current, channel)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {alert}

          {current === 'connection' && (
            <div className="space-y-4">
              <Field label="Supabase URL" htmlFor="supabaseUrl">
                <Input
                  id="supabaseUrl"
                  placeholder="https://YOUR-PROJECT.supabase.co"
                  value={conn.supabaseUrl}
                  onChange={(e) => setConn({ ...conn, supabaseUrl: e.target.value })}
                />
              </Field>
              <Field label="Anon (publishable) key" htmlFor="anonKey">
                <Input
                  id="anonKey"
                  value={conn.anonKey}
                  onChange={(e) => setConn({ ...conn, anonKey: e.target.value })}
                />
              </Field>
              <Field label="Service-role (secret) key" htmlFor="serviceRoleKey">
                <Input
                  id="serviceRoleKey"
                  type="password"
                  value={conn.serviceRoleKey}
                  onChange={(e) => setConn({ ...conn, serviceRoleKey: e.target.value })}
                />
              </Field>
              <Field label="Supabase access token" htmlFor="accessToken">
                <Input
                  id="accessToken"
                  type="password"
                  placeholder="sbp_… (Account → Access Tokens)"
                  value={conn.accessToken}
                  onChange={(e) => setConn({ ...conn, accessToken: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Recommended — lets the wizard apply the database schema over HTTPS (works on any
                  network, no database host to reach).
                </p>
              </Field>
              <Field label="Postgres connection string (optional)" htmlFor="postgresUrl">
                <Input
                  id="postgresUrl"
                  placeholder="postgresql://postgres.<ref>:[password]@aws-0-<region>.pooler.supabase.com:5432/postgres"
                  value={conn.postgresUrl}
                  onChange={(e) => setConn({ ...conn, postgresUrl: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Fallback used only if no access token is given. Use the <strong>Session pooler</strong>{' '}
                  string (Supabase → Connect → Session pooler); the &ldquo;direct&rdquo;{' '}
                  <code>db.&lt;ref&gt;.supabase.co</code> host fails on IPv4-only networks.
                </p>
              </Field>
              <Field label="Public site URL (optional)" htmlFor="siteUrl">
                <Input
                  id="siteUrl"
                  placeholder="http://localhost:4200"
                  value={conn.siteUrl}
                  onChange={(e) => setConn({ ...conn, siteUrl: e.target.value })}
                />
              </Field>
              {!writable && (
                <div className="space-y-3 rounded-md border p-4">
                  <p className="text-sm font-medium">
                    On {CHANNEL_LABEL[channel]} you don&apos;t fill this in — the database is
                    connected through your platform&apos;s environment variables (e.g. Vercel&apos;s
                    Supabase integration).
                  </p>
                  <div className="text-xs">
                    <p className="mb-1 text-muted-foreground">
                      Supabase variables this deployment can currently see:
                    </p>
                    <ul className="space-y-0.5 font-mono">
                      {(
                        [
                          'NEXT_PUBLIC_SUPABASE_URL',
                          'SUPABASE_URL',
                          'NEXT_PUBLIC_SUPABASE_ANON_KEY',
                          'SUPABASE_ANON_KEY',
                          'SUPABASE_SERVICE_ROLE_KEY',
                          'POSTGRES_URL',
                        ] as const
                      ).map((k) => (
                        <li key={k}>
                          {supabaseEnvDetected[k] ? '✅' : '❌'} {k}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Alert className="py-2 px-4">
                    <AlertDescription className="text-xs">
                      {supabaseEnvDetected.NEXT_PUBLIC_SUPABASE_URL ||
                      supabaseEnvDetected.SUPABASE_URL
                        ? 'Keys detected — reload this page and the database step will be skipped.'
                        : 'No Supabase keys are visible to this deployment yet. If you just created the database via the Vercel integration, the keys were added AFTER this build — open Vercel → Deployments → ⋯ → Redeploy once, then reload. Env vars only bind on a new deployment.'}
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
          )}

          {current === 'storage' && (
            <StorageStep storage={storage} setStorage={setStorage} channel={channel} />
          )}

          {current === 'admin' && (
            <div className="space-y-4">
              {agentInitiated && (
                <p className="rounded-md border border-primary/30 bg-primary/[0.04] p-3 text-sm text-muted-foreground">
                  A coding agent set this site up and is waiting for you. Create your administrator
                  account here; the next screen starts your free Cortex AI trial, which unlocks the
                  agent&apos;s access. After that you can return to your terminal.
                </p>
              )}
              <Field label="Full name" htmlFor="adminName">
                <Input
                  id="adminName"
                  value={admin.fullName}
                  onChange={(e) => setAdmin({ ...admin, fullName: e.target.value })}
                />
              </Field>
              <Field label="Email" htmlFor="adminEmail">
                <Input
                  id="adminEmail"
                  type="email"
                  value={admin.email}
                  onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                />
              </Field>
              <Field label="Password" htmlFor="adminPassword">
                <Input
                  id="adminPassword"
                  type="password"
                  value={admin.password}
                  onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                This first account becomes the site administrator, created already-confirmed (no
                verification email needed). Finishing also applies the database schema and saved
                settings, so it can take up to a minute.
              </p>
              <Alert className="py-2 px-4">
                <AlertDescription className="text-xs">
                  Next, your dashboard will guide you through finishing setup — branding, copyright,
                  email (SMTP), payment providers, and bot protection are all configured there, no
                  environment variables required.
                </AlertDescription>
              </Alert>

              {writable && (
                <label className="flex items-start gap-3 rounded-lg border p-3">
                  <Checkbox
                    checked={resetFirst}
                    onCheckedChange={(c) => setResetFirst(c === true)}
                    className="mt-1"
                  />
                  <span className="text-sm">
                    <span className="font-medium">Start from a clean database</span>
                    <span className="block text-xs text-muted-foreground">
                      Recommended for a fresh install. Wipes any existing tables, migration history,
                      and users in this Supabase project before installing. Uncheck if this database
                      already has data you want to keep.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          <Separator />

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={goBack} disabled={isPending || stepIndex === 0}>
              Back
            </Button>

            {current === 'connection' ? (
              <Button onClick={handleSaveConnection} disabled={isPending || !writable}>
                {isPending ? <Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save &amp; verify
              </Button>
            ) : isLast ? (
              <Button onClick={handleFinish} disabled={isPending}>
                {isPending ? <Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
                Finish setup
              </Button>
            ) : (
              <Button onClick={goNext} disabled={!connectionDone && !configured}>
                Next
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function stepDescription(step: StepId, channel: DeployChannel): string {
  switch (step) {
    case 'connection':
      return 'Connect this instance to your Supabase project.';
    case 'storage':
      return channel === 'docker'
        ? 'Your Docker stack uses MinIO for media storage — already wired up.'
        : channel === 'vercel'
          ? 'Using Supabase Storage (S3-compatible) for media.'
          : 'Bring your own Cloudflare R2 bucket for media storage.';
    case 'admin':
      return 'Create the first administrator account — the last step. Then, from your dashboard, let Cortex AI interview you and replace the sample content with your own site; email, payments, and the rest are configured there too.';
    default:
      return '';
  }
}

const PROGRESS_MESSAGES = [
  'Laying the foundation blocks…',
  'Seeding the first blocks…',
  'Stacking a few more blocks…',
  'Teaching the blocks to speak (translations)…',
  'Waiting on some stubborn blocks…',
  'Polishing the blocks until they shine…',
  'Almost there — slotting in the last blocks…',
];

function SetupProgress({ willReset }: { willReset: boolean }) {
  const messages = willReset
    ? ['Wiping the old blocks away…', ...PROGRESS_MESSAGES]
    : PROGRESS_MESSAGES;
  const [pct, setPct] = useState(8);
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    // Indeterminate work (one server action) shown as a friendly creeping bar that eases
    // toward ~92% and a rotating set of block-themed messages.
    const progress = setInterval(() => {
      setPct((value) => (value >= 92 ? 92 : value + Math.max(1, Math.round((96 - value) / 14))));
    }, 700);
    const cycle = setInterval(() => {
      setMsgIndex((index) => (index + 1) % messages.length);
    }, 2200);
    return () => {
      clearInterval(progress);
      clearInterval(cycle);
    };
  }, [messages.length]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Building your NextBlock…</CardTitle>
        <CardDescription>
          {willReset ? 'Resetting the database, then applying' : 'Applying'} the schema, seeding
          content, and creating your account. This can take a minute — hang tight.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground">{messages[msgIndex]}</p>
      </CardContent>
    </Card>
  );
}

function SetupDone() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>🎉 Setup complete!</CardTitle>
        <CardDescription>
          Your administrator account is ready and the database is seeded with sample content.
          Cortex AI can replace that sample content with your own site: it asks a few questions
          about your business, proposes a plan, and builds the pages, menus, and branding for you.
          Cortex AI starts with a free 30-day trial, no credit card required, and costs $250/year
          after that. The CMS itself is free forever.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button onClick={() => (window.location.href = '/cms/welcome')}>
          Continue
        </Button>
        <Button variant="outline" onClick={() => (window.location.href = '/cms/dashboard')}>
          Enter your CMS
        </Button>
      </CardContent>
    </Card>
  );
}

function Stepper({
  steps,
  stepIndex,
}: {
  steps: StepId[];
  stepIndex: number;
}) {
  return (
    <ol className="flex flex-wrap items-center justify-center gap-2 text-xs">
      {steps.map((s, i) => (
        <li
          key={s}
          className={`flex items-center gap-2 rounded-full border px-3 py-1 ${
            i === stepIndex
              ? 'border-primary text-primary'
              : i < stepIndex
                ? 'border-muted text-muted-foreground'
                : 'border-muted text-muted-foreground/60'
          }`}
        >
          <span className="font-medium">{i + 1}</span>
          <span>{STEP_TITLES[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function StorageStep({
  storage,
  setStorage,
  channel,
}: {
  storage: StoragePrefill;
  setStorage: (s: StoragePrefill) => void;
  channel: DeployChannel;
}) {
  if (channel === 'docker') {
    return (
      <div className="space-y-3 text-sm">
        <Alert variant="success" className="py-2 px-4">
          <AlertDescription>
            MinIO is already configured by the Docker setup. Nothing to do here.
          </AlertDescription>
        </Alert>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <dt>Endpoint</dt>
          <dd className="font-mono">{storage.endpoint}</dd>
          <dt>Bucket</dt>
          <dd className="font-mono">{storage.bucket}</dd>
          <dt>Public URL</dt>
          <dd className="font-mono">{storage.publicUrl}</dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {channel === 'vercel' && (
        <p className="text-xs text-muted-foreground">
          Pre-filled for Supabase Storage. Create an S3 access key in your Supabase project
          (Storage → S3 connection) and set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in your Vercel
          environment.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account / provider id" htmlFor="r2Account">
          <Input
            id="r2Account"
            value={storage.accountId}
            onChange={(e) => setStorage({ ...storage, accountId: e.target.value })}
          />
        </Field>
        <Field label="Bucket" htmlFor="r2Bucket">
          <Input
            id="r2Bucket"
            value={storage.bucket}
            onChange={(e) => setStorage({ ...storage, bucket: e.target.value })}
          />
        </Field>
        <Field label="Access key id" htmlFor="r2Access">
          <Input
            id="r2Access"
            value={storage.accessKeyId}
            onChange={(e) => setStorage({ ...storage, accessKeyId: e.target.value })}
          />
        </Field>
        <Field label="Secret access key" htmlFor="r2Secret">
          <Input
            id="r2Secret"
            type="password"
            value={storage.secretAccessKey}
            onChange={(e) => setStorage({ ...storage, secretAccessKey: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Public bucket URL" htmlFor="r2Public">
        <Input
          id="r2Public"
          placeholder="https://pub-xxxx.r2.dev"
          value={storage.publicUrl}
          onChange={(e) => setStorage({ ...storage, publicUrl: e.target.value })}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Your bucket&apos;s public URL (Cloudflare R2 → your bucket → Public Development URL)
          or a custom domain. Used to serve all media on your site.
        </p>
      </Field>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
