import { describe, expect, it } from 'vitest';

import {
  NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV,
  isForwardedPeerLoopback,
  isLoopbackIpAddress,
  isMcpLocalhostTrustOptedIn,
} from './mcp-loopback-trust';

// Mirrors `isLocalhostHost` in libs/cortex/src/lib/mcp-tokens.ts (the route injects the
// real one); the cortex barrel is not imported here because it drags in server modules
// whose aliases the vitest config does not mirror.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
const deps = {
  isLocalhostHost: (value: string | null | undefined) => {
    const host = value?.trim().toLowerCase();
    if (!host) return false;
    const withoutPort = host.startsWith('[') ? host.replace(/\]:\d+$/, ']') : host.replace(/:\d+$/, '');
    return LOOPBACK_HOSTNAMES.has(withoutPort) || withoutPort.endsWith('.localhost');
  },
};

describe('isMcpLocalhostTrustOptedIn', () => {
  it('is off unless the variable is literally true', () => {
    expect(isMcpLocalhostTrustOptedIn({})).toBe(false);
    expect(isMcpLocalhostTrustOptedIn({ [NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]: '' })).toBe(false);
    expect(isMcpLocalhostTrustOptedIn({ [NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]: '1' })).toBe(false);
    expect(isMcpLocalhostTrustOptedIn({ [NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]: 'yes' })).toBe(false);
    expect(isMcpLocalhostTrustOptedIn({ [NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]: 'false' })).toBe(false);
    expect(isMcpLocalhostTrustOptedIn({ [NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]: 'true' })).toBe(true);
    expect(isMcpLocalhostTrustOptedIn({ [NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]: ' TRUE ' })).toBe(true);
  });
});

describe('isLoopbackIpAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]', '[::1]:4200', '127.0.0.1:4200', '"127.0.0.1"', ' ::1 '])(
    'accepts %p',
    (value) => {
      expect(isLoopbackIpAddress(value)).toBe(true);
    }
  );

  it.each(['', '10.0.0.1', '192.168.1.10', '203.0.113.5', '::2', '::ffff:10.0.0.1', 'localhost', '_hidden', 'unknown', '[::ffff:203.0.113.5]:80', '1270.0.0.1'])(
    'rejects %p',
    (value) => {
      expect(isLoopbackIpAddress(value)).toBe(false);
    }
  );
});

describe('isForwardedPeerLoopback', () => {
  it('passes a bare request and loopback-only peer headers', () => {
    expect(isForwardedPeerLoopback(new Headers(), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '127.0.0.1' }), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '::1' }), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '::ffff:127.0.0.1' }), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '127.0.0.1, ::1' }), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ forwarded: 'for=127.0.0.1;proto=http' }), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ forwarded: 'for="[::1]:3000"' }), deps)).toBe(true);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-host': 'localhost:4200' }), deps)).toBe(true);
  });

  it('refuses when any peer header names a non-loopback address', () => {
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '203.0.113.5' }), deps)).toBe(false);
    // A proxy appended the real client behind a spoofed loopback entry.
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '127.0.0.1, 203.0.113.5' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ 'x-real-ip': '10.0.0.7' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ 'cf-connecting-ip': '198.51.100.9' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '198.51.100.9' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ forwarded: 'for=203.0.113.5' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ forwarded: 'for=127.0.0.1, for=203.0.113.5' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ forwarded: 'proto=https' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': 'unknown' }), deps)).toBe(false);
  });

  it('refuses a non-local forwarded host even when the peer looks local', () => {
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'cms.example.com' }), deps)).toBe(false);
    expect(isForwardedPeerLoopback(new Headers({ 'x-forwarded-host': 'evil.com' }), deps)).toBe(false);
  });
});
