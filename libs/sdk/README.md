# @nextblock-cms/sdk

The typed block-authoring contract of [NextBlock](https://github.com/nextblock-cms/nextblock), the
open-core CMS for Next.js and Supabase. Use it to type a block's content schema, its renderer and
its CMS editor.

The package is types only: its JavaScript entry is empty, so it adds nothing to a bundle.
Projects created with `npm create nextblock@latest` already depend on it.

```bash
npm install @nextblock-cms/sdk
```

## Public surface

- `BlockContentSchema`
- `BlockData<TSchema>`
- `BlockProps<TSchema>`
- `BlockEditorProps<TSchema>`
- `BlockConfig<TSchema>`

```ts
import type { BlockConfig } from '@nextblock-cms/sdk';
```

## Documentation

- [Block SDK and extensibility](https://github.com/nextblock-cms/nextblock/blob/master/docs/07-BLOCK-SDK-AND-EXTENSIBILITY.md)
- [Custom blocks](https://github.com/nextblock-cms/nextblock/blob/master/docs/10-CUSTOM-BLOCKS.md)
- [CMS and editor](https://github.com/nextblock-cms/nextblock/blob/master/docs/03-CMS-AND-EDITOR.md)

The docs describe the current contract and how it relates to the block registry in the app.

## License

AGPL-3.0-or-later.
