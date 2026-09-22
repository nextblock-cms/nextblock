# apps/nextblock

`apps/nextblock` is the canonical NextBlock™ application. It contains:

- the public site
- the authenticated CMS
- checkout and webhook routes
- cron routes
- the route tree used as the source for the scaffold template

If you are trying to understand current runtime behavior, start here before you
look at generated template output.

## Related Docs

- [Project Overview](../../docs/01-PROJECT-OVERVIEW.md)
- [Ecommerce Capabilities](../../docs/02-ECOMMERCE-CAPABILITIES.md)
- [CMS and Editor](../../docs/03-CMS-AND-EDITOR.md)
- [Database and Auth](../../docs/04-DATABASE-AND-AUTH.md)
- [Developer Guide](../../docs/05-DEVELOPER-GUIDE.md)
- [CLI and Scaffolding](../../docs/06-CLI-AND-SCAFFOLDING.md)

## Common Workflows

From the repo root:

```bash
npm run dev          # = npx nx serve nextblock, http://localhost:4200
npx nx build nextblock
npx nx lint nextblock --skip-nx-cache
```

Use the root docs for architecture and workflow details instead of maintaining a
second app-specific guide here.
