// Hostname and IP-literal blocklist for server-side fetches of user-supplied URLs.
// Moved out of ai-global-agent-tools.ts (which re-exports it) so the alt-text image
// downloader can use it without importing the whole tool registry.

/**
 * Unwrap an IPv4-mapped IPv6 address to its dotted-quad form.
 *
 * `http://[::ffff:127.0.0.1]/` reaches loopback just as `http://127.0.0.1/` does,
 * but the WHATWG URL parser normalises it to `::ffff:7f00:1` — which matches none of
 * the IPv4 private-range checks below. Without this, the mapped form is a working
 * bypass of the entire SSRF blocklist. Decimal and hex hosts (`http://2130706433/`)
 * need no special handling: the URL parser already normalises those to dotted-quad.
 */
function unwrapMappedIpv4(host: string): string | null {
  const mapped = host.match(/^::ffff:(.+)$/i);

  if (!mapped) {
    return null;
  }

  const rest = mapped[1] as string;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
    return rest;
  }

  const hextets = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);

  if (!hextets) {
    return null;
  }

  const high = Number.parseInt(hextets[1] as string, 16);
  const low = Number.parseInt(hextets[2] as string, 16);

  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

/** Exported for the SSRF regression tests in ai-global-agent-ssrf.test.ts. */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  // `::` is the unspecified address and reaches loopback on most stacks.
  if (
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }

  const mappedIpv4 = unwrapMappedIpv4(host);

  if (mappedIpv4) {
    return isBlockedFetchHost(mappedIpv4);
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);

    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return true;
    }
  }

  return false;
}
