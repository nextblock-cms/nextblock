# Security Policy

NextBlock is a CMS that runs against live Supabase databases and handles
authentication, file uploads, and payments. We take security reports seriously
and appreciate the time researchers spend on them.

## Supported versions

NextBlock ships as a rolling release from `master`. Security fixes land on the
latest published version only — there are no long-term support branches.

| Version | Supported |
| :------ | :-------- |
| Latest published `0.x` release | ✅ |
| Any earlier `0.x` release | ❌ — update first (`npm run update`) |

If you are running an older install, `npm run update` brings code, dependencies,
and database schema forward together. See
[docs/13-STAYING-UP-TO-DATE.md](./docs/13-STAYING-UP-TO-DATE.md).

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report privately through either channel:

1. **GitHub Private Vulnerability Reporting** (preferred) — go to the
   [Security tab](https://github.com/nextblock-cms/nextblock/security) of this
   repository and choose **Report a vulnerability**. This keeps the report,
   the discussion, and the eventual advisory in one place.
2. **Email** — <security@nextblock.dev>. Encrypt if you prefer; say so and we
   will arrange a key.

Whichever you use, please include:

- The affected component (app route, library, migration, or CLI) and version
- A description of the vulnerability and its impact
- Steps to reproduce, ideally against a disposable local or sandbox instance
- Any proof-of-concept code, logs, or screenshots
- Whether you intend to disclose publicly, and on what timeline

## What to expect

| Stage | Target |
| :---- | :----- |
| Acknowledgement of your report | within 3 business days |
| Initial assessment and severity triage | within 7 business days |
| Fix or documented mitigation for high/critical issues | within 30 days |
| Public advisory | after a fix ships, coordinated with you |

We will keep you updated as triage progresses, credit you in the advisory unless
you ask us not to, and let you know if we assess an issue as out of scope.

## Scope

**In scope** — the code in this repository:

- The Next.js application (`apps/nextblock`), including CMS routes, API routes,
  cron endpoints, checkout, and the `/setup` wizard
- The published libraries (`@nextblock-cms/*`) and the `create-nextblock` CLI
- Database migrations, Row Level Security policies, and grants under
  `libs/db/src/supabase/migrations`
- Authentication and session handling, media upload paths, and secret derivation

Issues we are particularly interested in: RLS bypass or cross-tenant data
access, privilege escalation to `ADMIN`/`WRITER`, authentication bypass, SSRF or
injection in server actions and API routes, unauthenticated access to cron or
revalidation endpoints, and secrets leaking into client bundles.

**Out of scope:**

- The public sandbox at `cms.nextblock.dev`, which is deliberately open with
  published demo credentials and resets every 15 minutes. Findings there are only
  interesting if they also apply to a normal install.
- Vulnerabilities in Supabase, Vercel, Stripe, Freemius, or other third-party
  services — report those to the vendor directly.
- Missing hardening headers or rate limits with no demonstrated impact,
  automated scanner output without a working proof of concept, and social
  engineering or physical attacks.
- Anything requiring an already-compromised administrator account.

## Safe harbour

We will not pursue or support legal action against researchers who act in good
faith: test only against instances you own or the sandbox, avoid privacy
violations and service degradation, do not exfiltrate or retain data beyond what
is needed to prove the issue, and give us reasonable time to remediate before
disclosing.

## A note on self-hosted installs

NextBlock is self-hosted software. Some hardening is the operator's
responsibility — keeping `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY`
server-side, setting `CRON_SECRET` to lock down cron endpoints, and applying
updates promptly. See [docs/12-VERCEL-DEPLOYMENT.md](./docs/12-VERCEL-DEPLOYMENT.md)
and [docs/04-DATABASE-AND-AUTH.md](./docs/04-DATABASE-AND-AUTH.md). Reports that
amount to "the operator misconfigured their instance" are documentation issues,
and we do want to hear about those — just as normal issues.
