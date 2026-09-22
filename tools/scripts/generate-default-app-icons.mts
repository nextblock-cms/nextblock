/**
 * Regenerates the static default app icons in apps/nextblock/public/favicon/ from the
 * NextBlock art, with the same renderer the app icon route uses for a custom logo
 * (apps/nextblock/lib/branding/render-app-icon.ts), so the defaults and a rendered logo
 * get identical margins and safe zone:
 *
 *   - maskable-512x512.png  the NB art inside the maskable safe circle, on white
 *   - apple-touch-icon.png  180x180 on white (iOS paints a transparent icon on black)
 *
 * The source is android-chrome-512x512.png, which is never rewritten (external files
 * hot-link the 192 and 512), so the script is safe to re-run and its output is stable.
 * These files are what every site without a custom logo installs with.
 *
 *   npx tsx --tsconfig=tsconfig.base.json --conditions=react-server tools/scripts/generate-default-app-icons.mts
 *
 * `--conditions=react-server` resolves the renderer's `server-only` import to its empty
 * build, as the verify:cortex-ai-* scripts do.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import {
  APP_ICON_VARIANTS,
  STATIC_APP_ICONS,
  type AppIconVariant,
} from '../../apps/nextblock/lib/branding/app-icon';
import { renderAppIcon } from '../../apps/nextblock/lib/branding/render-app-icon';

const PUBLIC_DIR = fileURLToPath(new URL('../../apps/nextblock/public/', import.meta.url));
const SOURCE = path.join(PUBLIC_DIR, 'favicon', 'android-chrome-512x512.png');
// The fallback theme colour (lib/themes/buildThemeCss.ts FALLBACK_THEME_COLOR): the page
// background of the palette every fresh install ships with.
const BACKGROUND = '#ffffff';
const GENERATED: AppIconVariant[] = ['maskable-512', 'apple-180'];

const source = await readFile(SOURCE);

for (const variant of GENERATED) {
  const png = await renderAppIcon(source, APP_ICON_VARIANTS[variant], BACKGROUND);
  const target = path.join(PUBLIC_DIR, STATIC_APP_ICONS[variant].replace(/^\//, ''));
  await writeFile(target, png);

  const meta = await sharp(png).metadata();
  const stats = await sharp(png).stats();
  console.log(
    `${path.relative(process.cwd(), target)}: ${meta.width}x${meta.height}, ` +
      `${meta.channels} channels, opaque ${stats.isOpaque}, ${png.byteLength} bytes`
  );
}
