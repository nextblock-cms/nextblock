import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { escapeStyleElementText } from './style-element-text';

// 2026-10-21: app/layout.tsx injected site_settings.global_css raw into <style>, so a
// stylesheet containing `</style>` broke out into HTML on every page, /cms included.
describe('escapeStyleElementText', () => {
  it('neutralises every letter case of the closing style tag', () => {
    for (const payload of [
      '</style><script>alert(1)</script>',
      '</STYLE><img src=x onerror=alert(1)>',
      '</StYlE\n><svg onload=alert(1)>',
      'a{}</style/><script>x()</script>',
    ]) {
      const escaped = escapeStyleElementText(payload);

      expect(escaped).not.toMatch(/<\/style/i);
      expect(escaped).toMatch(/<\\\/style/i);
    }
  });

  it('leaves ordinary CSS untouched, range media queries included', () => {
    const css = '.a > .b { color: red; }\n@media (width < 600px) { .c { content: "<"; } }';

    expect(escapeStyleElementText(css)).toBe(css);
  });

  it('is what the root layout renders global_css through', () => {
    const layout = readFileSync(resolve(__dirname, '../../app/layout.tsx'), 'utf8');

    expect(layout).toContain('__html: escapeStyleElementText(globalCss)');
    expect(layout).not.toMatch(/__html:\s*globalCss\b/);
  });
});
