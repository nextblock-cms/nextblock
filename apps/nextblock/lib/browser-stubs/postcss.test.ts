import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sanitizeAuthoredBlockHtml, sanitizeAuthoredSvgMarkup } from '@nextblock-cms/utils/authored-html';

/**
 * Browser bundles resolve `postcss` to ./postcss.cjs, an empty module (next.config.js →
 * turbopack.resolveAlias, `browser` only). That is safe only while sanitize-html, the one client
 * dependency that requires postcss, never calls it on the path sanitizeAuthoredBlockHtml takes
 * (`parseStyleAttributes: false`). These tests load sanitize-html against the stub and check the
 * sanitizer's output does not move; a sanitize-html release that starts using postcss elsewhere
 * fails here instead of in visitors' browsers.
 */

const nodeRequire = createRequire(import.meta.url);
const APP_DIR = resolve(__dirname, '../..');

/** sanitize-html as a browser bundle gets it: a fresh instance whose `require('postcss')` is the stub. */
function sanitizeHtmlAgainstStub(): typeof import('sanitize-html') {
  const sanitizePath = nodeRequire.resolve('sanitize-html');
  // The postcss file sanitize-html itself resolves, wherever npm put it.
  const postcssPath = createRequire(sanitizePath).resolve('postcss');
  const cache = nodeRequire.cache;
  const saved = { sanitize: cache[sanitizePath], postcss: cache[postcssPath] };
  cache[postcssPath] = { id: postcssPath, filename: postcssPath, loaded: true, exports: nodeRequire('./postcss.cjs') } as NodeJS.Module;
  delete cache[sanitizePath];
  try {
    return nodeRequire('sanitize-html');
  } finally {
    for (const [path, entry] of [[sanitizePath, saved.sanitize], [postcssPath, saved.postcss]] as const) {
      if (entry) cache[path] = entry;
      else delete cache[path];
    }
  }
}

/** Editor output, attack input and everything in between, style attributes and elements included. */
const CORPUS = [
  '<h2 id="intro" style="text-align: center !important">Intro</h2><p><span style="color: #ff0000; font-size: 18px">Red</span> <mark data-color="#fde68a" style="background-color: #fde68a; color: inherit">hi</mark></p>',
  '<style type="text/css">.promo{color:#0a7} @media (width < 600px){.promo{color:red}}</style><div data-alert-widget="" data-type="info" class="my-4"></div>',
  '<table style="min-width: 200px"><colgroup><col style="min-width: 100px"></colgroup><tbody><tr><td colspan="2" style="padding:4px"><p>Cell</p></td></tr></tbody></table>',
  '<img src="/a.png" srcset="/a-1x.png 1x, /a-2x.png 2x" alt="" style="width:50%"><a href="javascript:alert(1)" style="color:red">x</a>',
  '<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" style="border:0" allowfullscreen></iframe><iframe src="https://evil.example/"></iframe>',
  '<svg viewBox="0 0 24 24" style="display:block"><style>.a{fill:red}</style><path d="M0 0h24v24H0z" style="fill:url(#g)"/></svg>',
  '<p>hi</p><script>alert(1)</script><img src="x"onerror="alert(1)"><div style="background:url(javascript:alert(1))">z</div>',
  '<svg><p></p><style><a id="</style><img src=1 onerror=alert(1)>"></a></style></svg><p>ok</p><meta http-equiv=refresh content=0;url=https://evil.example/?',
];

describe('the browser stub for postcss', () => {
  afterEach(() => {
    vi.doUnmock('sanitize-html');
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('is what next.config.js gives browser bundles, and only them', () => {
    // Without the toolbar flag, requiring the config writes nothing.
    vi.stubEnv('NEXTBLOCK_VERCEL_TOOLBAR_ENABLED', '');
    const config = nodeRequire('../../next.config.js');
    expect(config.turbopack.resolveAlias.postcss).toEqual({ browser: './lib/browser-stubs/postcss.cjs' });
    expect(existsSync(resolve(APP_DIR, config.turbopack.resolveAlias.postcss.browser))).toBe(true);
  });

  it('is in effect: sanitize-html can no longer parse a style attribute against it', () => {
    const stubbed = sanitizeHtmlAgainstStub();
    const options = { allowedTags: ['p'], allowedAttributes: { p: ['style'] }, parseStyleAttributes: true };
    const real = nodeRequire('sanitize-html') as typeof import('sanitize-html');
    expect(real('<p style="color: red">x</p>', options)).toBe('<p style="color:red">x</p>');
    // postcss is the only thing style parsing needs, and the stub has none of it.
    expect(stubbed('<p style="color: red">x</p>', options)).toBe('<p>x</p>');
  });

  it('leaves the authored-HTML sanitizer output unchanged', async () => {
    const stubbed = sanitizeHtmlAgainstStub();
    let callsAgainstStub = 0;
    vi.resetModules();
    vi.doMock('sanitize-html', () => ({
      default: (...args: Parameters<typeof stubbed>) => {
        callsAgainstStub += 1;
        return stubbed(...args);
      },
    }));
    const againstStub = await import('@nextblock-cms/utils/authored-html');
    for (const html of CORPUS) {
      expect(againstStub.sanitizeAuthoredBlockHtml(html), html).toBe(sanitizeAuthoredBlockHtml(html));
      expect(againstStub.sanitizeAuthoredSvgMarkup(html), `[svg] ${html}`).toBe(sanitizeAuthoredSvgMarkup(html));
    }
    // Every one of those ran through the stubbed instance, not the real one.
    expect(callsAgainstStub).toBe(CORPUS.length * 2);
  });
});
