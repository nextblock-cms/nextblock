# NextBlock CMS Documentation

This folder is the source-of-truth reference set for the NextBlock monorepo.
The numbered files are written from live code, routes, migrations, and shipped
library surfaces rather than historical planning notes.

## Start Here

- Product and architecture overview: [01-PROJECT-OVERVIEW.md](./01-PROJECT-OVERVIEW.md)
- Commerce capabilities: [02-ECOMMERCE-CAPABILITIES.md](./02-ECOMMERCE-CAPABILITIES.md)
- CMS editor and block system: [03-CMS-AND-EDITOR.md](./03-CMS-AND-EDITOR.md)
- Database, auth, and migrations: [04-DATABASE-AND-AUTH.md](./04-DATABASE-AND-AUTH.md)
- Contributor workflow and local operations: [05-DEVELOPER-GUIDE.md](./05-DEVELOPER-GUIDE.md)
- CLI and scaffolded project flow: [06-CLI-AND-SCAFFOLDING.md](./06-CLI-AND-SCAFFOLDING.md)
- Block SDK and extensibility surface: [07-BLOCK-SDK-AND-EXTENSIBILITY.md](./07-BLOCK-SDK-AND-EXTENSIBILITY.md)
- Cortex AI architecture: [08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md](./08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md)
- Live draft (visual editing) mode: [09-LIVE-DRAFT-MODE.md](./09-LIVE-DRAFT-MODE.md)
- Custom blocks (data-driven CRUD): [10-CUSTOM-BLOCKS.md](./10-CUSTOM-BLOCKS.md)
- Self-hosted local Docker stack: [11-SELF-HOSTED-DOCKER.md](./11-SELF-HOSTED-DOCKER.md)
- One-click cloud deploy (Deploy to Vercel): [12-VERCEL-DEPLOYMENT.md](./12-VERCEL-DEPLOYMENT.md)
- Updating an install (`npm run update`, upstream sync): [13-STAYING-UP-TO-DATE.md](./13-STAYING-UP-TO-DATE.md)
- Messages inbox (enquiries, contact forms, reviews, comments): [14-MESSAGES-INBOX.md](./14-MESSAGES-INBOX.md)
- Affiliates & creator storefronts (partners, commissions, Stripe Connect payouts): [15-AFFILIATES-AND-STOREFRONTS.md](./15-AFFILIATES-AND-STOREFRONTS.md)

## Audience Guide

- New contributors: read `01`, then `04`, then `05`.
- Commerce work: read `02`, then `04`.
- Affiliate program, partner portal or payout work: read `15`, then `02` and `04`.
- Editor or page-builder work: read `03`, then `07`.
- Custom block work: read `03`, then `10`.
- AI / Cortex work: read `08`.
- CLI or template work: read `06`.
- Publishing the libraries / scaffold CLI: read `06`.
- Running everything locally without cloud accounts: read `11`.
- One-click cloud deploy and the browser setup wizard: read `12`.
- Updating an existing install, whichever way it was created: read `13`.
- AI agents: start with this index, then move directly to the subsystem file that
  matches the task. Treat `apps/nextblock`, `libs/*`, and
  `libs/db/src/supabase/migrations` as the final authority if a doc and code ever
  disagree.
- AI agents touching migrations must also read the root `AGENTS.md` note:
  production/shared database changes are append-only and non-destructive by
  default.
