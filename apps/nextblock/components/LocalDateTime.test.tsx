// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LocalDateTime, formatUtcDate, formatUtcDateTime } from './LocalDateTime';

/**
 * LocalDateTime prints UTC text on the server and while hydrating, then the viewer's own. The two
 * machines are simulated by what toLocaleString() answers during each render.
 */

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

async function serverThenBrowser(element: React.ReactElement) {
  const toLocaleString = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('(server)');
  const html = renderToString(element);
  toLocaleString.mockReturnValue('(browser)');

  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const recoverableErrors: unknown[] = [];
  let root: Root | undefined;
  await act(async () => {
    root = hydrateRoot(container, element, { onRecoverableError: (error) => recoverableErrors.push(error) });
  });
  mounted = { root: root as Root, container };
  return { html, container, recoverableErrors, toLocaleString };
}

describe('LocalDateTime', () => {
  it('formats UTC text the same on every machine', () => {
    const date = new Date('2026-11-18T23:30:00-05:00');
    expect(formatUtcDateTime(date)).toBe('2026-11-19 04:30 UTC');
    expect(formatUtcDate(date)).toBe('2026-11-19');
  });

  it("prints the UTC date and time on the server, hydrates without a mismatch, then shows the viewer's own", async () => {
    const { html, container, recoverableErrors, toLocaleString } = await serverThenBrowser(
      <LocalDateTime className="stamp" value="2026-11-18T14:05:00+00:00" />,
    );

    expect(html).toContain('2026-11-18 14:05 UTC');
    expect(html).not.toContain('(server)');
    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toBe('(browser)');
    expect(toLocaleString).toHaveBeenLastCalledWith(undefined, undefined);
    const time = container.querySelector('time.stamp');
    expect(time?.getAttribute('dateTime')).toBe('2026-11-18T14:05:00.000Z');
  });

  it('with a date-only format, prints the UTC date on the server and hands the format to the browser', async () => {
    const format: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
    const { html, container, recoverableErrors, toLocaleString } = await serverThenBrowser(
      <LocalDateTime format={format} value="2026-11-18T14:05:00Z" />,
    );

    expect(html).toContain('>2026-11-18<');
    expect(html).not.toContain('UTC');
    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toBe('(browser)');
    expect(toLocaleString).toHaveBeenLastCalledWith(undefined, format);
  });

  it('with a format that shows the time of day, prints the UTC date and time on the server', () => {
    const html = renderToString(<LocalDateTime format={{ hour: '2-digit', minute: '2-digit' }} value="2026-11-18T14:05:00Z" />);
    expect(html).toContain('2026-11-18 14:05 UTC');
  });

  it('prints an unreadable value as it is, and nothing for none', () => {
    expect(renderToString(<LocalDateTime value="not a date" />)).toBe('<span>not a date</span>');
    expect(renderToString(<LocalDateTime value={null} />)).toBe('');
    expect(renderToString(<LocalDateTime value="" />)).toBe('');
  });
});
