import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-03: on the public sandbox the demo admin could save the SMTP host while the username
 * and password stayed in SMTP_USER / SMTP_PASS. SMTP AUTH hands the credentials to whatever
 * server the transport connects to, so pointing the host at their own server captured the
 * deployment's login on the next send. These tests pin the two rules that close it: the sandbox
 * saves nothing and reads only its env, and env credentials go only to SMTP_HOST everywhere.
 *
 * 2026-11-04: the stored envelopes were not bound to their row, so an admin session that could
 * write site_settings copied the Stripe key's envelope into email_secret.pass, saved its own host
 * and received the key through SMTP AUTH. "an envelope copied in from another row" pins the fix
 * with real envelopes: each credential opens only from its own field.
 */

const mocks = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  upserts: [] as Array<{ key: string; value: unknown }>,
  serviceClientBuilt: 0,
  /** What the module sealed with encryptWithEnvKey, and for which slot. */
  sealed: [] as Array<{ value: string; slot: string }>,
}));

function fakeClient() {
  return {
    from: (table: string) => {
      expect(table).toBe('site_settings');
      return {
        select: () => ({
          eq: (_column: string, key: string) => ({
            maybeSingle: async () => ({ data: mocks.rows.has(key) ? { value: mocks.rows.get(key) } : null, error: null }),
          }),
        }),
        upsert: async (row: { key: string; value: unknown }) => {
          mocks.upserts.push(row);
          mocks.rows.set(row.key, row.value);
          return { error: null };
        },
      };
    },
  };
}

vi.mock('@nextblock-cms/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nextblock-cms/db/server')>();
  return {
    ...actual,
    createClient: () => fakeClient(),
    getServiceRoleSupabaseClient: () => {
      mocks.serviceClientBuilt += 1;
      return fakeClient();
    },
    // A reversible stand-in for the AES envelope, recording the slot it was sealed for.
    encryptWithEnvKey: (value: string, slot: string) => {
      mocks.sealed.push({ value, slot });
      return `enc:${value}`;
    },
    // `enc:UNREADABLE` stands for an envelope sealed under an earlier key (well formed, not
    // decryptable). A real envelope goes through the real decrypt, slot check included.
    tryDecryptWithEnvKey: (value: unknown, slot: Parameters<typeof actual.tryDecryptWithEnvKey>[1]) =>
      typeof value === 'string'
        ? value.startsWith('enc:') && value !== 'enc:UNREADABLE'
          ? value.slice(4)
          : null
        : actual.tryDecryptWithEnvKey(value, slot),
    getSecretEnvelopeStatus: (value: unknown) =>
      typeof value === 'string'
        ? { hasStoredValue: value.startsWith('enc:'), last4: value.slice(-4) }
        : actual.getSecretEnvelopeStatus(value),
  };
});
vi.mock('../auth/cms-actor', () => ({ requireCmsAdmin: async () => ({ supabase: fakeClient() }) }));

import {
  getEmailSettingsView,
  invalidateEmailConfigCache,
  isEmailConfigured,
  resolveEmailServerConfig,
  saveEmailSettings,
} from './email-settings';

// The real envelope functions (the mock above swaps encryptWithEnvKey for a stand-in).
const db = await vi.importActual<typeof import('@nextblock-cms/db/server')>('@nextblock-cms/db/server');
const TEST_KEY = 'email-settings-test-key';
const USER_SLOT = db.siteSettingSecretSlot('email_secret', 'user');
const PASS_SLOT = db.siteSettingSecretSlot('email_secret', 'pass');
const STRIPE_SLOT = db.siteSettingSecretSlot('payment_secret', 'stripeSecretKey');

/** An envelope exactly as 0.23.0 and earlier wrote it: version 1, no associated data. */
function legacyEnvelope(value: string, encryptionSecret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(encryptionSecret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    last4: value.slice(-4),
    updatedAt: '2026-01-02T03:04:05.000Z',
    version: 1,
  };
}

const ENV_SMTP = {
  SMTP_HOST: 'mail.provider.example',
  SMTP_PORT: '2525',
  SMTP_USER: 'deployment-user',
  SMTP_PASS: 'deployment-pass',
  SMTP_FROM_EMAIL: 'donotreply@site.example',
  SMTP_FROM_NAME: 'Site',
};
const ATTACKER_HOST = { host: 'smtp.attacker.example', port: '25', fromEmail: '', fromName: '', secure: false };

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.rows.clear();
  mocks.upserts = [];
  mocks.serviceClientBuilt = 0;
  mocks.sealed = [];
  invalidateEmailConfigCache();
  for (const [name, value] of Object.entries(ENV_SMTP)) vi.stubEnv(name, value);
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('saveEmailSettings', () => {
  it('refuses every save on the sandbox before writing anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(saveEmailSettings({ ...ATTACKER_HOST })).rejects.toThrow('Email settings cannot be changed in the sandbox.');
    await expect(saveEmailSettings({ ...ATTACKER_HOST, user: 'u', pass: 'p' })).rejects.toThrow('cannot be changed in the sandbox');
    expect(mocks.upserts).toEqual([]);
  });

  it('refuses a port that is not a port before writing anything', async () => {
    await expect(saveEmailSettings({ host: '', port: '465 (SSL)', fromEmail: '', fromName: '', secure: true })).rejects.toThrow(
      'Port must be a whole number from 1 to 65535.'
    );
    expect(mocks.upserts).toEqual([]);
  });

  it('saves the public fields and encrypts new credentials on a regular install', async () => {
    await saveEmailSettings({ host: 'smtp.cms.example', port: '465', fromEmail: 'a@site.example', fromName: 'A', secure: true, user: 'cms-user', pass: 'cms-pass' });

    expect(mocks.upserts.map((row) => row.key)).toEqual(['email_public', 'email_secret']);
    expect(mocks.rows.get('email_secret')).toEqual({ user: 'enc:cms-user', pass: 'enc:cms-pass' });
  });

  it('seals each new credential for its own field of email_secret', async () => {
    await saveEmailSettings({ host: 'smtp.cms.example', port: '465', fromEmail: '', fromName: '', secure: true, user: 'cms-user', pass: 'cms-pass' });

    expect(mocks.sealed).toEqual([
      { value: 'cms-user', slot: 'site_settings:email_secret:user' },
      { value: 'cms-pass', slot: 'site_settings:email_secret:pass' },
    ]);
  });

  it('re-seals a credential stored before 0.23.1 on a save that changes neither, keeping the other', async () => {
    vi.stubEnv('NEXTBLOCK_ENCRYPTION_KEY', TEST_KEY);
    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: legacyEnvelope('cms-pass', TEST_KEY) });

    await saveEmailSettings({ host: 'smtp.cms.example', port: '465', fromEmail: '', fromName: '', secure: true });

    const stored = mocks.rows.get('email_secret') as { user: unknown; pass: { version: number } };
    expect(stored.user).toBe('enc:cms-user');
    expect(stored.pass.version).toBe(2);
    expect(db.tryDecryptWithEnvKey(stored.pass, PASS_SLOT)).toBe('cms-pass');
    expect(db.tryDecryptWithEnvKey(stored.pass, USER_SLOT)).toBeNull();
    expect(mocks.sealed).toEqual([]);
  });

  it('writes no email_secret row when there is nothing new to store or re-seal', async () => {
    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: 'enc:cms-pass' });

    await saveEmailSettings({ host: 'smtp.cms.example', port: '465', fromEmail: '', fromName: '', secure: true });

    expect(mocks.upserts.map((row) => row.key)).toEqual(['email_public']);
  });
});

describe('resolveEmailServerConfig', () => {
  it('reads only the deployment env on the sandbox, whatever its database holds', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.rows.set('email_public', { ...ATTACKER_HOST });
    mocks.rows.set('email_secret', { user: 'enc:planted', pass: 'enc:planted' });

    const config = await resolveEmailServerConfig({ silent: true });

    expect(config).toMatchObject({ host: 'mail.provider.example', port: 2525, auth: { user: 'deployment-user', pass: 'deployment-pass' } });
    expect(mocks.serviceClientBuilt).toBe(0);
  });

  it('sends env credentials only to SMTP_HOST and SMTP_PORT, whatever host the CMS saved', async () => {
    mocks.rows.set('email_public', { ...ATTACKER_HOST });

    const config = await resolveEmailServerConfig();

    expect(config).toMatchObject({
      host: 'mail.provider.example',
      port: 2525,
      secure: false,
      requireTLS: true,
      auth: { user: 'deployment-user', pass: 'deployment-pass' },
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('the host and port saved in CMS Settings → Email are ignored'));
  });

  it('pins to SMTP_HOST when only one of the two credentials comes from the env', async () => {
    mocks.rows.set('email_public', { ...ATTACKER_HOST });
    mocks.rows.set('email_secret', { user: 'enc:cms-user' });

    const config = await resolveEmailServerConfig({ silent: true });

    expect(config).toMatchObject({ host: 'mail.provider.example', auth: { user: 'cms-user', pass: 'deployment-pass' } });
  });

  it('keeps a stored username and password with the host saved next to them', async () => {
    mocks.rows.set('email_public', { host: 'smtp.cms.example', port: '465', fromEmail: '', fromName: '', secure: true });
    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: 'enc:cms-pass' });

    const config = await resolveEmailServerConfig({ silent: true });

    expect(config).toMatchObject({ host: 'smtp.cms.example', port: 465, secure: true, auth: { user: 'cms-user', pass: 'cms-pass' } });
  });

  it('still pairs env credentials with the CMS host when SMTP_HOST is unset (a split legacy setup)', async () => {
    vi.stubEnv('SMTP_HOST', '');
    mocks.rows.set('email_public', { host: 'smtp.cms.example', port: '587', fromEmail: '', fromName: '', secure: false });

    const config = await resolveEmailServerConfig({ silent: true });

    expect(config).toMatchObject({ host: 'smtp.cms.example', port: 587, auth: { user: 'deployment-user' } });
  });

  it('resolves an env-only setup', async () => {
    const config = await resolveEmailServerConfig({ silent: true });

    expect(config).toMatchObject({ host: 'mail.provider.example', port: 2525, from: '"Site" <donotreply@site.example>' });
  });

  describe('an envelope copied in from another row', () => {
    beforeEach(() => {
      vi.stubEnv('NEXTBLOCK_ENCRYPTION_KEY', TEST_KEY);
    });

    it('never reaches SMTP AUTH: the password reads as missing, so the env login goes to SMTP_HOST', async () => {
      mocks.rows.set('email_public', { ...ATTACKER_HOST });
      mocks.rows.set('email_secret', {
        user: db.encryptWithEnvKey('attacker-user', USER_SLOT),
        pass: db.encryptWithEnvKey('sk_live_victim', STRIPE_SLOT),
      });

      const config = await resolveEmailServerConfig({ silent: true });

      expect(config).toMatchObject({ host: 'mail.provider.example', auth: { user: 'attacker-user', pass: 'deployment-pass' } });
      expect(JSON.stringify(config)).not.toContain('sk_live_victim');
    });

    it('sends nothing when the env has no login to fall back on', async () => {
      vi.stubEnv('SMTP_HOST', '');
      vi.stubEnv('SMTP_USER', '');
      vi.stubEnv('SMTP_PASS', '');
      mocks.rows.set('email_public', { ...ATTACKER_HOST });
      mocks.rows.set('email_secret', {
        user: db.encryptWithEnvKey('attacker-user', USER_SLOT),
        pass: db.encryptWithEnvKey('sk_live_victim', STRIPE_SLOT),
      });

      expect(await resolveEmailServerConfig({ silent: true })).toBeNull();
    });

    it('opens neither credential when user and password trade places', async () => {
      mocks.rows.set('email_public', { ...ATTACKER_HOST });
      mocks.rows.set('email_secret', {
        user: db.encryptWithEnvKey('cms-pass', PASS_SLOT),
        pass: db.encryptWithEnvKey('cms-user', USER_SLOT),
      });

      const config = await resolveEmailServerConfig({ silent: true });

      expect(config).toMatchObject({ host: 'mail.provider.example', auth: { user: 'deployment-user', pass: 'deployment-pass' } });
    });

    it('still uses credentials sealed for their own fields, and a version 1 pair from before 0.23.1', async () => {
      mocks.rows.set('email_public', { host: 'smtp.cms.example', port: '465', fromEmail: '', fromName: '', secure: true });
      mocks.rows.set('email_secret', {
        user: db.encryptWithEnvKey('cms-user', USER_SLOT),
        pass: db.encryptWithEnvKey('cms-pass', PASS_SLOT),
      });
      expect(await resolveEmailServerConfig({ silent: true })).toMatchObject({
        host: 'smtp.cms.example',
        auth: { user: 'cms-user', pass: 'cms-pass' },
      });

      invalidateEmailConfigCache();
      mocks.rows.set('email_secret', { user: legacyEnvelope('old-user', TEST_KEY), pass: legacyEnvelope('old-pass', TEST_KEY) });
      expect(await resolveEmailServerConfig({ silent: true })).toMatchObject({
        host: 'smtp.cms.example',
        auth: { user: 'old-user', pass: 'old-pass' },
      });
    });
  });

  // 2026-11-04: pinning the host also pinned the port to SMTP_PORT alone, so an install with
  // SMTP_HOST / SMTP_USER / SMTP_PASS in the env and its port only in the CMS sent no mail at all,
  // email sign-in codes included. A CMS port may come back for that same server, first, as every
  // CMS field does, because it cannot move the credentials off SMTP_HOST, and nothing saved in the
  // CMS may send them unencrypted.
  describe('the port of env credentials pinned to SMTP_HOST', () => {
    const cmsRow = (host: string, port: string, secure: boolean) => ({ host, port, fromEmail: '', fromName: '', secure });
    const resolveSilently = () => resolveEmailServerConfig({ silent: true });

    it('takes the CMS port saved for that same server first, with its TLS toggle', async () => {
      // SMTP_PORT is 2525 here.
      mocks.rows.set('email_public', cmsRow('mail.provider.example', '465', false));
      expect(await resolveSilently()).toMatchObject({ host: 'mail.provider.example', port: 465, secure: true });

      // A non-standard implicit-TLS port keeps the toggle saved with it (it timed out before).
      invalidateEmailConfigCache();
      vi.stubEnv('SMTP_PORT', '2465');
      mocks.rows.set('email_public', cmsRow('MAIL.provider.example', '2465', true));
      expect(await resolveEmailServerConfig()).toMatchObject({ port: 2465, secure: true });
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('are ignored'));
    });

    it('takes a CMS port saved with no CMS host, judging TLS by the port and demanding it', async () => {
      mocks.rows.set('email_public', cmsRow('', '465', false));
      expect(await resolveSilently()).toMatchObject({ host: 'mail.provider.example', port: 465, secure: true });

      invalidateEmailConfigCache();
      mocks.rows.set('email_public', cmsRow('', '8025', true));
      expect(await resolveSilently()).toMatchObject({ host: 'mail.provider.example', port: 8025, secure: false, requireTLS: true });
    });

    it('lets the CMS toggle raise TLS on the env port, never lower it below the env alone', async () => {
      vi.stubEnv('SMTP_PORT', '8465');
      mocks.rows.set('email_public', cmsRow('mail.provider.example', '', true));
      expect(await resolveSilently()).toMatchObject({ port: 8465, secure: true });

      // Switched off, it gives what the env alone gives on that port.
      invalidateEmailConfigCache();
      mocks.rows.set('email_public', cmsRow('mail.provider.example', '', false));
      expect(await resolveSilently()).toMatchObject({ port: 8465, secure: false, requireTLS: false });
    });

    it('asks nothing more when the CMS port repeats the env port, so a plaintext relay keeps working', async () => {
      vi.stubEnv('SMTP_HOST', 'relay.internal');
      vi.stubEnv('SMTP_PORT', '2526');
      for (const row of [cmsRow('', '2526', false), cmsRow('relay.internal', '2526', false)]) {
        invalidateEmailConfigCache();
        mocks.rows.set('email_public', row);
        expect(await resolveSilently()).toMatchObject({ host: 'relay.internal', port: 2526, secure: false, requireTLS: false });
      }

      // Moving it to another port does demand TLS.
      invalidateEmailConfigCache();
      mocks.rows.set('email_public', cmsRow('', '2527', false));
      expect(await resolveSilently()).toMatchObject({ port: 2527, requireTLS: true });
    });

    it('never moves env credentials off SMTP_HOST, nor below the encryption the env alone gives', async () => {
      for (const smtpPort of ['', '2525', '2526', '465']) {
        vi.stubEnv('SMTP_PORT', smtpPort);
        invalidateEmailConfigCache();
        mocks.rows.clear();
        const envOnly = await resolveSilently();
        for (const host of ['', 'mail.provider.example', 'MAIL.PROVIDER.EXAMPLE', 'smtp.other.example', 'localhost']) {
          for (const port of ['', '465', '587', '2526', '2527', '8465', 'abc']) {
            for (const secure of [true, false]) {
              invalidateEmailConfigCache();
              mocks.rows.set('email_public', cmsRow(host, port, secure));
              const config = await resolveSilently();
              const where = JSON.stringify({ smtpPort, host, port, secure });
              const encrypted = Boolean(config?.secure || config?.requireTLS);
              expect(config?.host, where).toBe('mail.provider.example');
              if (envOnly?.secure || envOnly?.requireTLS) expect(encrypted, where).toBe(true);
              if (config?.port !== envOnly?.port) expect(encrypted, where).toBe(true);
            }
          }
        }
      }
    });

    it('says why a CMS port that moves the env login now needs TLS', async () => {
      vi.stubEnv('SMTP_PORT', '');
      for (const row of [cmsRow('', '2526', false), cmsRow('mail.provider.example', '2526', false)]) {
        invalidateEmailConfigCache();
        warnSpy.mockClear();
        mocks.rows.set('email_public', row);
        expect(await resolveEmailServerConfig()).toMatchObject({ port: 2526, secure: false, requireTLS: true });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('moves the SMTP_USER / SMTP_PASS login off the default port 587, so it must upgrade to TLS there')
        );
      }
    });

    it('reads a value that is not a port as 465 with implicit TLS on for SMTP_HOST, ahead of SMTP_PORT', async () => {
      // SMTP_PORT is 2525 here; before 2026-11-03 the saved value won and nodemailer read it as 465.
      mocks.rows.set('email_public', cmsRow('mail.provider.example', '465 (SSL)', true));

      expect(await resolveSilently()).toMatchObject({ port: 465, secure: true });
    });

    it('leaves a loopback relay in plaintext whatever port the CMS moved it to', async () => {
      vi.stubEnv('SMTP_HOST', 'localhost');
      vi.stubEnv('SMTP_PORT', '1025');
      mocks.rows.set('email_public', cmsRow('', '1026', false));

      expect(await resolveSilently()).toMatchObject({ host: 'localhost', port: 1026, secure: false, requireTLS: false });
    });

    it('ignores the port and toggle saved for another host', async () => {
      vi.stubEnv('SMTP_PORT', '8465');
      mocks.rows.set('email_public', cmsRow('smtp.other.example', '465', true));

      // The env port's own TLS rule stands: the operator chose that port.
      expect(await resolveSilently()).toMatchObject({ host: 'mail.provider.example', port: 8465, secure: false, requireTLS: false });
    });

    it('uses SMTP_PORT when the same server saved no port', async () => {
      mocks.rows.set('email_public', cmsRow('mail.provider.example', '', true));

      expect(await resolveSilently()).toMatchObject({ port: 2525, secure: false, requireTLS: true });
    });

    describe('when SMTP_PORT is unset', () => {
      beforeEach(() => vi.stubEnv('SMTP_PORT', ''));

      it('uses the submission port, not the port saved for another host', async () => {
        mocks.rows.set('email_public', { ...ATTACKER_HOST });

        expect(await resolveEmailServerConfig()).toMatchObject({
          host: 'mail.provider.example',
          port: 587,
          secure: false,
          requireTLS: true,
          auth: { user: 'deployment-user', pass: 'deployment-pass' },
        });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('uses port 587. Set SMTP_PORT'));
      });

      it('uses the submission port for an env-only setup, and for a same-server row without a port', async () => {
        expect(await resolveSilently()).toMatchObject({ host: 'mail.provider.example', port: 587, requireTLS: true });

        invalidateEmailConfigCache();
        mocks.rows.set('email_public', cmsRow('mail.provider.example', '', true));
        expect(await resolveSilently()).toMatchObject({ port: 587, secure: false, requireTLS: true });
      });

      it.each(['abc', '0', '587 smtp', '70000', '-1', '0x24B', '1e3', '587\n[email] forged'])(
        'refuses a CMS port that is not a port (%j) and uses 587 with TLS demanded',
        async (port) => {
          mocks.rows.set('email_public', cmsRow('', port, false));

          expect(await resolveSilently()).toMatchObject({ host: 'mail.provider.example', port: 587, requireTLS: true });
        }
      );

      it('reads a value that is not a port as 465 when implicit TLS is on for SMTP_HOST, as nodemailer did', async () => {
        mocks.rows.set('email_public', cmsRow('mail.provider.example', '465 (SSL)', true));
        expect(await resolveEmailServerConfig()).toMatchObject({ port: 465, secure: true });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('"465 (SSL)" saved in CMS Settings → Email is not an SMTP port, so mail to SMTP_HOST uses port 465.')
        );
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('No usable SMTP_PORT'));

        invalidateEmailConfigCache();
        mocks.rows.set('email_public', cmsRow('mail.provider.example', '465 (SSL)', false));
        expect(await resolveSilently()).toMatchObject({ port: 587, secure: false, requireTLS: true });
      });

      it('never reads a CMS port on the sandbox', async () => {
        vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
        mocks.rows.set('email_public', cmsRow('mail.provider.example', '465', true));

        expect(await resolveEmailServerConfig()).toMatchObject({ host: 'mail.provider.example', port: 587 });
        expect(mocks.serviceClientBuilt).toBe(0);
        // Nothing there points at the CMS screen, which the sandbox never reads.
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No usable SMTP_PORT, so mail to SMTP_HOST uses port 587.'));
      });
    });

    it('also uses 587 for an SMTP_PORT that is not a port', async () => {
      vi.stubEnv('SMTP_PORT', 'smtp');

      expect(await resolveSilently()).toMatchObject({ port: 587, requireTLS: true });
    });
  });

  it('keeps CMS credentials on the CMS host and port, and maps a CMS port that is not a port to 465 or 587', async () => {
    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: 'enc:cms-pass' });
    mocks.rows.set('email_public', { host: 'smtp.cms.example', port: '2525', fromEmail: '', fromName: '', secure: false });
    expect(await resolveEmailServerConfig({ silent: true })).toMatchObject({ host: 'smtp.cms.example', port: 2525, auth: { user: 'cms-user' } });

    // Not a port: nodemailer would quietly pick one and settle for opportunistic STARTTLS on 587.
    invalidateEmailConfigCache();
    mocks.rows.set('email_public', { host: 'smtp.cms.example', port: '587\n[email] forged', fromEmail: '', fromName: '', secure: false });
    expect(await resolveEmailServerConfig()).toMatchObject({ port: 587, secure: false, requireTLS: true });
    const notice = warnSpy.mock.calls.map((call) => String(call[0])).find((message) => message.includes('is not an SMTP port'));
    expect(notice).toBeDefined();
    expect(notice).not.toContain('\n');

    invalidateEmailConfigCache();
    mocks.rows.set('email_public', { host: 'smtp.cms.example', port: 'abc', fromEmail: '', fromName: '', secure: true });
    expect(await resolveEmailServerConfig({ silent: true })).toMatchObject({ port: 465, secure: true });
  });

  it('logs a stored value short and in printable ASCII only', async () => {
    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: 'enc:cms-pass' });
    const lineSeparator = String.fromCharCode(0x2028);
    for (const port of [`587${lineSeparator}[email] forged`, `587${String.fromCharCode(0x202e)}x`, '9'.repeat(200)]) {
      invalidateEmailConfigCache();
      warnSpy.mockClear();
      mocks.rows.set('email_public', { host: 'smtp.cms.example', port, fromEmail: '', fromName: '', secure: false });
      await resolveEmailServerConfig();

      const notice = warnSpy.mock.calls.map((call) => String(call[0])).find((message) => message.includes('is not an SMTP port'));
      expect(notice, port.slice(0, 20)).toBeDefined();
      // Printable ASCII, plus the message's own arrow and ellipsis.
      expect(notice).toMatch(/^[\x20-\x7e…→]*$/);
      expect((notice ?? '').length).toBeLessThan(150);
    }
  });

  it('keeps the warnings of a silent check for the next call that may log, then prints them once', async () => {
    vi.stubEnv('SMTP_PORT', '');

    expect(await isEmailConfigured()).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    await resolveEmailServerConfig();
    await resolveEmailServerConfig();
    const portNotices = warnSpy.mock.calls.filter((call) => String(call[0]).includes('No usable SMTP_PORT'));
    expect(portNotices).toHaveLength(1);

    // The TLS correction waits too.
    invalidateEmailConfigCache();
    warnSpy.mockClear();
    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: 'enc:cms-pass' });
    mocks.rows.set('email_public', { host: 'smtp.cms.example', port: '587', fromEmail: '', fromName: '', secure: true });
    await resolveEmailServerConfig({ silent: true });
    expect(warnSpy).not.toHaveBeenCalled();
    await resolveEmailServerConfig();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('requires TLS mode "STARTTLS"'));

    // So does "not configured", which the 2FA and security actions check silently first.
    invalidateEmailConfigCache();
    warnSpy.mockClear();
    mocks.rows.clear();
    vi.stubEnv('SMTP_USER', '');
    expect(await isEmailConfigured()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(await resolveEmailServerConfig()).toBeNull();
    expect(warnSpy.mock.calls.filter((call) => String(call[0]).includes('Email is not configured'))).toHaveLength(1);
  });
});

describe('getEmailSettingsView', () => {
  it('flags the sandbox as read-only and a CMS host that env credentials override', async () => {
    mocks.rows.set('email_public', { ...ATTACKER_HOST });
    expect(await getEmailSettingsView()).toMatchObject({ readOnly: false, hostPinnedToEnv: true });

    mocks.rows.set('email_secret', { user: 'enc:cms-user', pass: 'enc:cms-pass' });
    expect(await getEmailSettingsView()).toMatchObject({ hostPinnedToEnv: false });

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(await getEmailSettingsView()).toMatchObject({ readOnly: true });
  });

  it('treats SMTP_HOST written in another case as the same host, as the resolver does', async () => {
    mocks.rows.set('email_public', { host: ' MAIL.Provider.example ', port: '465', fromEmail: '', fromName: '', secure: true });

    expect(await getEmailSettingsView()).toMatchObject({ hostPinnedToEnv: false });
  });

  it('flags the saved host as unused when the stored login can no longer be decrypted, as the resolver does', async () => {
    mocks.rows.set('email_public', { ...ATTACKER_HOST });
    mocks.rows.set('email_secret', { user: 'enc:UNREADABLE', pass: 'enc:UNREADABLE' });

    expect(await getEmailSettingsView()).toMatchObject({ hasUser: true, hostPinnedToEnv: true });
    expect(await resolveEmailServerConfig({ silent: true })).toMatchObject({ host: 'mail.provider.example', auth: { user: 'deployment-user' } });
  });

  // Both hints describe what saving the form would change. The sandbox saves nothing and sends only
  // through its SMTP_* env, so there it shows the read-only note alone.
  const NO_CMS_HOST = { host: '', port: '', fromEmail: '', fromName: '', secure: true };

  it('shows neither the env-fallback nor the pinned-host hint on the sandbox, only read-only', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    mocks.rows.set('email_public', NO_CMS_HOST);
    expect(await getEmailSettingsView()).toMatchObject({ envFallbackActive: false, hostPinnedToEnv: false, readOnly: true });

    mocks.rows.set('email_public', { ...ATTACKER_HOST });
    expect(await getEmailSettingsView()).toMatchObject({ envFallbackActive: false, hostPinnedToEnv: false, readOnly: true });
  });

  it.each(['', 'false', 'TRUE', '1'])('keeps both hints off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j)', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    // No host saved, SMTP_HOST in the env: saving would move SMTP into the database.
    mocks.rows.set('email_public', NO_CMS_HOST);
    expect(await getEmailSettingsView()).toMatchObject({ envFallbackActive: true, hostPinnedToEnv: false, readOnly: false });

    // A saved host the env credentials override.
    mocks.rows.set('email_public', { ...ATTACKER_HOST });
    expect(await getEmailSettingsView()).toMatchObject({ envFallbackActive: false, hostPinnedToEnv: true, readOnly: false });
  });
});
