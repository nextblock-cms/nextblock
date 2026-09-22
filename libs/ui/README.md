# @nextblock-cms/ui

The UI primitives and global styles of [NextBlock](https://github.com/nextblock-cms/nextblock),
the open-core CMS for Next.js and Supabase. The components are Radix-based and styled with
Tailwind CSS; the CMS, the public site and the other NextBlock packages all build on them.

Projects created with `npm create nextblock@latest` already depend on it. It is built for
NextBlock projects (Next.js 16, React 19, Tailwind CSS 4) rather than as a general-purpose
component library.

```bash
npm install @nextblock-cms/ui
```

## Entry points

| Import | What it holds |
| :-- | :-- |
| `@nextblock-cms/ui` | Every component: `Alert`, `Avatar`, `Badge`, `Button`, `Card`, `Checkbox`, `ColorField`, `ColorPicker`, `ConfirmationDialog`, `Dialog`, `DropdownMenu`, `Input`, `Label`, `Popover`, `Progress`, `RadioGroup`, `SearchableSelect`, `Select`, `Separator`, `Sheet`, `Skeleton`, `Spinner`, `Table`, `Textarea`, `Tooltip` and the NextBlock-specific `SeoScoreBadge` and `ViewLiveButton` |
| `@nextblock-cms/ui/<component>` | The same barrel under a component's name, for example `@nextblock-cms/ui/button` |
| `@nextblock-cms/ui/styles/*.css` | The global styles: `globals.css` (import it once, in the root layout) and the `theme`, `base`, `components`, `typography` and `animations` layers it pulls in |

Every component is a Client Component: the entry files start with `'use client'` in both the
ESM and the CommonJS build.

```tsx
import '@nextblock-cms/ui/styles/globals.css';
import { Button } from '@nextblock-cms/ui';
```

`ColorPicker` loads `react-color` lazily, the first time a picker opens.

## Documentation

- [CMS and editor](https://github.com/nextblock-cms/nextblock/blob/master/docs/03-CMS-AND-EDITOR.md)
- [Developer guide](https://github.com/nextblock-cms/nextblock/blob/master/docs/05-DEVELOPER-GUIDE.md)

## License

AGPL-3.0-or-later.
