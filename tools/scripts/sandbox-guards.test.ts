import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  findFlagReaderProblems,
  findGuardProblems,
  findUnlistedSideEffects,
  sideEffectsInSource,
} = require('./lib/sandbox-guards.js');
const { scanRepository } = require('./lib/service-role-boundary.js');

const REPO_ROOT = path.resolve(__dirname, '../..');

/** A test that sets the flag and runs every listed function (a default export through its import). */
function fixtureTest(functions: string[]): string {
  const imports = functions.includes('default') ? "import Scripts from './fixture';\n" : '';
  const calls = functions.filter((name) => name !== 'default').map((name) => `${name}();`);
  return `${imports}vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');\n${calls.join('\n')}\nScripts;`;
}

function problemsFor(source: string, functions: string[], test = fixtureTest(functions)): string[] {
  const files: Record<string, string> = { 'fixture.ts': source, 'fixture.test.ts': test };
  const readFile = (repoPath: string) => {
    if (!(repoPath in files)) throw new Error(`ENOENT ${repoPath}`);
    return files[repoPath];
  };
  return findGuardProblems([{ file: 'fixture.ts', functions, test: 'fixture.test.ts', why: 'Why it matters.' }], readFile);
}

describe('sandbox guard check', () => {
  it('accepts the flag compared with true, isSandboxEnvironment() and a binding of the same module', () => {
    const source = `
      import { isSandboxEnvironment } from '@nextblock-cms/db/server';
      const LOCKED = 'Locked in the sandbox.';
      function lockedInSandbox() { return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'; }
      const sandbox = () => process.env['NEXT_PUBLIC_IS_SANDBOX'] === 'true';
      export async function direct() { if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return LOCKED; }
      export async function viaPredicate() { if (isSandboxEnvironment()) throw new Error(LOCKED); }
      export async function viaHelper() { if (lockedInSandbox()) return LOCKED; }
      export const reversed = async () => { if ('true' !== process.env.NEXT_PUBLIC_IS_SANDBOX) return; };
      export const wrapped = cache(async () => { if (sandbox()) return LOCKED; });
      export default function Scripts() { const blocked = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'; return blocked ? null : 1; }
      export async function nested() { return guard(async () => { if (isSandboxEnvironment()) return LOCKED; }); }
      async function local() { if (isSandboxEnvironment()) return LOCKED; }
      export { local as listed };
    `;
    expect(problemsFor(source, ['direct', 'viaPredicate', 'viaHelper', 'reversed', 'wrapped', 'default', 'nested', 'listed'])).toEqual([]);
  });

  it('fails a listed function that lost its check or reads the flag without comparing it with true', () => {
    const source = `
      function lockedInSandbox() { return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'; }
      export async function createUser() { return requireAdmin(); }
      export async function truthy() { if (process.env.NEXT_PUBLIC_IS_SANDBOX) return; }
      export async function wrongValue() { if (process.env.NEXT_PUBLIC_IS_SANDBOX === '1') return; }
      export async function otherFlag() { if (process.env.NEXT_PUBLIC_IS_DEMO === 'true') return; }
      export async function propertyOnly(user) { return user.lockedInSandbox; }
    `;
    const names = ['createUser', 'truthy', 'wrongValue', 'otherFlag', 'propertyOnly'];
    expect(problemsFor(source, names)).toEqual(names.map((name) => `fixture.ts#${name}: no longer checks the sandbox. Why it matters.`));
  });

  it('names a renamed function, a moved module and a test that never sets the flag', () => {
    expect(problemsFor('export async function other() {}', ['createUser'])).toEqual([
      'fixture.ts#createUser: not found. Renamed? Update SANDBOX_GUARDS.',
    ]);
    expect(problemsFor('export async function a() { if (isSandboxEnvironment()) return; }', ['a'], "it('works', () => { a(); });")).toEqual([
      "fixture.test.ts: never sets NEXT_PUBLIC_IS_SANDBOX to 'true', so it cannot prove the refusal in fixture.ts.",
    ]);
    const gone = findGuardProblems([{ file: 'gone.ts', functions: ['a'], test: 'gone.test.ts', why: 'Why.' }], () => {
      throw new Error('ENOENT');
    });
    expect(gone).toEqual(['gone.ts: missing. Moved? Update SANDBOX_GUARDS (tools/scripts/lib/sandbox-guards.js).']);
  });

  it('needs a real stubEnv to true: a comment, a stub to empty or a mocked predicate does not prove the refusal', () => {
    const guarded = 'export async function a() { if (isSandboxEnvironment()) return; }';
    const NEVER_SETS = "fixture.test.ts: never sets NEXT_PUBLIC_IS_SANDBOX to 'true', so it cannot prove the refusal in fixture.ts.";
    for (const test of [
      "// vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true')\na();",
      "vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');\na();",
      "vi.mock('@nextblock-cms/db/server', () => ({ isSandboxEnvironment: () => true }));\na();",
      "vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'false');\na();",
    ]) {
      expect(problemsFor(guarded, ['a'], test), test).toEqual([NEVER_SETS]);
    }
    expect(problemsFor(guarded, ['a'], "process.env.NEXT_PUBLIC_IS_SANDBOX = 'true';\na();")).toEqual([]);
  });

  it('fails a listed function its test never runs, and counts calls through a namespace or a table of names', () => {
    const source = `
      export async function suspend() { if (isSandboxEnvironment()) return; }
      export async function reactivate() { if (isSandboxEnvironment()) return; }
      export async function changeTier() { if (isSandboxEnvironment()) return; }
    `;
    // changeTier is only imported and named in a comment: neither runs it.
    const test = `import { suspend, reactivate, changeTier } from './fixture';
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
      // changeTier is covered elsewhere
      await actions.suspend();
      it.each(['reactivate'])('%s refuses', (name) => actions[name]());`;
    expect(problemsFor(source, ['suspend', 'reactivate', 'changeTier'], test)).toEqual([
      'fixture.test.ts: never runs fixture.ts#changeTier, so its refusal could be removed with every test green.',
    ]);
    const component = "export default function S() { return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' ? null : 1; }";
    expect(problemsFor(component, ['default'], "vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');")).toEqual([
      'fixture.test.ts: never runs fixture.ts#default, so its refusal could be removed with every test green.',
    ]);
  });

  it('does not count a test title, a type or an unused default import as running a function', () => {
    const source = `
      export async function createUser() { if (isSandboxEnvironment()) return; }
      export default function Page() { return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' ? null : 1; }
    `;
    const test = `import Page from './fixture';
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
      describe('createUser', () => { it('refuses', () => {}); });
      type Action = typeof createUser;`;
    expect(problemsFor(source, ['createUser', 'default'], test)).toEqual([
      'fixture.test.ts: never runs fixture.ts#createUser, so its refusal could be removed with every test green.',
      'fixture.test.ts: never runs fixture.ts#default, so its refusal could be removed with every test green.',
    ]);
  });

  it('counts a private guard as run when the test runs an export that reaches it', () => {
    const source = `
      function loadRows() { if (isSandboxEnvironment()) return {}; return read(); }
      export async function hydrate() { return loadRows(); }
      export async function unrelated() { return 1; }
    `;
    expect(problemsFor(source, ['loadRows'], "vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');\nawait hydrate();")).toEqual([]);
    expect(problemsFor(source, ['loadRows'], "vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');\nawait unrelated();")).toEqual([
      'fixture.test.ts: never runs fixture.ts#loadRows, so its refusal could be removed with every test green.',
    ]);
  });

  it('fails a flag reader that stopped reading the flag', () => {
    const readFile = () => 'export function isSandboxEnvironment() { return isDemo(); }';
    expect(findFlagReaderProblems([{ file: 'config.ts', name: 'isSandboxEnvironment' }], readFile)).toEqual([
      "config.ts#isSandboxEnvironment: no longer compares process.env.NEXT_PUBLIC_IS_SANDBOX with 'true', yet guards call it as their sandbox check.",
    ]);
  });

  it('finds mail transports, GoTrue account calls and storage writes, and nothing else', () => {
    const source = `
      import nodemailer from 'nodemailer';
      const transporter = nodemailer.createTransport({ host });
      await supabase.auth.signUp({ email, password });
      await admin.auth.admin.createUser({ email });
      await supabase.auth.getUser();
      await s3.send(new PutObjectCommand({ Bucket, Key }));
      await admin.storage.from(bucket).upload(key, body);
      await supabaseRemoveObjects(keys);
      await s3.send(new GetObjectCommand({ Bucket, Key }));
      link.remove();
    `;
    expect(sideEffectsInSource('fixture.ts', source)).toEqual({
      mail: ['createTransport (line 3)'],
      account: ['auth.signUp (line 4)', 'auth.admin.createUser (line 5)'],
      storage: ['new PutObjectCommand (line 7)', 'storage.from().upload (line 8)', 'supabaseRemoveObjects (line 9)'],
      vendor: [],
    });
  });

  it('finds Stripe writes and Freemius writes, and not their reads or a Stripe data object', () => {
    const stripeSource = `
      async function checkout() { const stripe = await getStripeClient(); return stripe.checkout.sessions.create({}); }
      async function pay(client: Stripe) { await client.transfers.create({}); await client.accounts.retrieve('acct'); }
      function label(stripe: Stripe.Tax.Calculation) { return stripe.tax_type.trim(); }
      async function list() { const stripe = await getStripeClient(); return stripe.customers.list(); }
    `;
    expect(sideEffectsInSource('fixture.ts', stripeSource).vendor).toEqual([
      'stripe.checkout.sessions.create (line 2)',
      'stripe.transfers.create (line 3)',
    ]);
    const freemiusSource = `
      const FM = 'https://api.freemius.com/v1';
      await fetch(\`\${FM}/licenses.json\`);
      await fetch(\`\${FM}/coupons.json\`, { method: 'POST' });
      await fetch(\`\${FM}/coupons.json\`, { method: input.method });
      await fetch(\`\${FM}/plans.json\`, { method: 'GET' });
    `;
    expect(sideEffectsInSource('fixture.ts', freemiusSource).vendor).toEqual([
      'fetch POST in a Freemius module (line 4)',
      'fetch (method not a literal) in a Freemius module (line 5)',
    ]);
    const sdkSource = `import { Freemius } from '@freemius/sdk';
      await client.GET('/products/{id}/plans.json');
      await client.POST('/products/{id}/licenses.json');
    `;
    expect(sideEffectsInSource('fixture.ts', sdkSource).vendor).toEqual(['Freemius SDK POST (line 3)']);
  });

  it('counts code that runs at import as module level, never as an accepted function', () => {
    const repoPath = 'apps/nextblock/lib/seed.ts';
    const modules = new Map([['/repo/seed.ts', { absolute: '/repo/seed.ts', repoPath }]]);
    const source = `
      export async function guarded() { if (isSandboxEnvironment()) return; }
      const created = await admin.auth.admin.createUser({ email });
      const later = { async run() { await admin.auth.admin.deleteUser(id); } };
      const now = (async () => { await admin.auth.admin.updateUserById(id, {}); })();
    `;
    const guards = [{ file: repoPath, functions: ['guarded'], test: 'x.test.ts', why: 'Why.' }];
    const lists = { mail: new Map(), account: new Map([[repoPath, { why: 'Why.' }]]), storage: new Map(), vendor: new Map() };
    const problems = findUnlistedSideEffects(modules, lists, () => source, guards);
    expect(problems.map((problem: string) => problem.split(' calls ')[0])).toEqual([`${repoPath}#(module)`, `${repoPath}#(module)`]);
    // `later` is never used, so nothing can run its method: it stays accepted.
    expect(problems.join('\n')).not.toContain('deleteUser');
  });

  it('finds GoTrue calls on a stored handle, a destructured client, a GoTrue-typed parameter and the MFA API', () => {
    const source = `
      const admin = getServiceRoleSupabaseClient().auth.admin;
      const { auth } = supabase;
      async function wipe(id) { await admin.deleteUser(id); }
      async function join(email, password) { await auth.signUp({ email, password }); }
      async function restore(client: GoTrueAdminApi) { await client.createUser({ email }); }
      async function enrol() { await supabase.auth.mfa.enroll({ factorType: 'totp' }); }
      async function drop(id) { await supabaseAdmin.auth.admin.mfa.deleteFactor({ id, userId }); }
      async function harmless() { await auth.getUser(); await admin.listUsers(); }
    `;
    expect(sideEffectsInSource('fixture.ts', source).account).toEqual([
      'auth.admin.deleteUser (line 4)',
      'auth.signUp (line 5)',
      'auth.admin.createUser (line 6)',
      'auth.mfa.enroll (line 7)',
      'auth.admin.mfa.deleteFactor (line 8)',
    ]);
  });

  it('parses a module whose only GoTrue call is on a destructured client, and finds the R2 delete helper', () => {
    const modules = new Map([
      ['/repo/signup.ts', { absolute: '/repo/signup.ts', repoPath: 'apps/nextblock/lib/signup.ts' }],
      ['/repo/products.ts', { absolute: '/repo/products.ts', repoPath: 'libs/ecommerce/src/lib/products.ts' }],
    ]);
    const sources: Record<string, string> = {
      '/repo/signup.ts': 'const { auth } = supabase; await auth.signUp({ email, password });',
      '/repo/products.ts': 'export async function update() { await deleteMediaFiles(keys); }',
    };
    const lists = { mail: new Map(), account: new Map(), storage: new Map() };
    expect(findUnlistedSideEffects(modules, lists, (absolute: string) => sources[absolute], [])).toEqual([
      'apps/nextblock/lib/signup.ts calls a GoTrue account, second-factor or auth-mail API (auth.signUp (line 1)): refuse it on the sandbox (isSandboxEnvironment()) and list the module in ACCOUNT_WRITERS (tools/scripts/lib/sandbox-guards.js) with how it behaves there.',
      'libs/ecommerce/src/lib/products.ts writes to object storage (deleteMediaFiles (line 1)): refuse it on the sandbox (isSandboxEnvironment()) and list the module in STORAGE_WRITERS (tools/scripts/lib/sandbox-guards.js) with how it behaves there.',
    ]);
  });

  it('checks a listed module call by call: a guard, a helper only guards reach, or a named exemption', () => {
    const repoPath = 'apps/nextblock/app/cms/users/actions.ts';
    const modules = new Map([['/repo/actions.ts', { absolute: '/repo/actions.ts', repoPath }]]);
    const source = `
      async function deleteAuthUser(id) { await admin.auth.admin.deleteUser(id); }
      export async function deleteUserAndProfile(id) { if (isSandboxEnvironment()) return; await deleteAuthUser(id); }
      export async function inviteUser(email) { await admin.auth.admin.inviteUserByEmail(email); }
      export async function seed() { await admin.auth.admin.createUser({ email }); }
      async function sharedHelper() { await admin.auth.admin.updateUserById(id, {}); }
      export async function alsoUsesHelper() { await sharedHelper(); }
    `;
    const guards = [{ file: repoPath, functions: ['deleteUserAndProfile'], test: 'x.test.ts', why: 'Why.' }];
    const account = new Map([[repoPath, { why: 'Why.', exempt: { seed: 'only the reset calls it', gone: 'stale' } }]]);
    const lists = { mail: new Map(), account, storage: new Map() };
    const where = (fn: string, call: string) =>
      `${repoPath}#${fn} calls a GoTrue account, second-factor or auth-mail API (${call}) outside a SANDBOX_GUARDS function of the module or a private helper only those reach: refuse it on the sandbox and list the function in SANDBOX_GUARDS, or exempt it by name with the reason in ACCOUNT_WRITERS (tools/scripts/lib/sandbox-guards.js).`;
    expect(findUnlistedSideEffects(modules, lists, () => source, guards)).toEqual([
      where('inviteUser', 'auth.admin.inviteUserByEmail (line 4)'),
      where('sharedHelper', 'auth.admin.updateUserById (line 6)'),
      `ACCOUNT_WRITERS exempts ${repoPath}#gone, which no longer calls a GoTrue account, second-factor or auth-mail API: remove the exemption.`,
    ]);
  });

  it('lists every payment-provider writer and checks it call by call, like the account writers', () => {
    const modules = new Map([
      ['/repo/refunds.ts', { absolute: '/repo/refunds.ts', repoPath: 'libs/ecommerce/src/lib/refunds.ts' }],
      ['/repo/sync.ts', { absolute: '/repo/sync.ts', repoPath: 'libs/ecommerce/src/lib/sync.ts' }],
    ]);
    const sources: Record<string, string> = {
      '/repo/refunds.ts': 'export async function refund(id) { const stripe = await getStripeClient(); await stripe.refunds.create({ payment_intent: id }); }',
      '/repo/sync.ts': `
        export async function guarded() { if (isSandboxEnvironment()) return; const stripe = await getStripeClient(); await stripe.products.update('p', {}); }
        export async function push() { await fetch(\`\${FREEMIUS_API_URL}/coupons.json\`, { method: 'PUT' }); }
        export class Engine { constructor(private stripe: Stripe) {} async pay() { await this.stripe.transfers.create({}); } }
      `,
    };
    const guards = [{ file: 'libs/ecommerce/src/lib/sync.ts', functions: ['guarded'], test: 'x.test.ts', why: 'Why.' }];
    const vendor = new Map<string, unknown>([
      ['libs/ecommerce/src/lib/sync.ts', { why: 'Why.', exempt: { Engine: 'Connect only', gone: 'stale' } }],
      ['libs/ecommerce/src/lib/old-vendor.ts', 'gone'],
    ]);
    const lists = { mail: new Map(), account: new Map(), storage: new Map(), vendor };
    expect(findUnlistedSideEffects(modules, lists, (absolute: string) => sources[absolute], guards)).toEqual([
      'libs/ecommerce/src/lib/refunds.ts writes to a payment provider (Stripe, Freemius, PayPal) (stripe.refunds.create (line 1)): refuse it on the sandbox (isSandboxEnvironment()) and list the module in VENDOR_WRITERS (tools/scripts/lib/sandbox-guards.js) with how it behaves there.',
      'libs/ecommerce/src/lib/sync.ts#push writes to a payment provider (Stripe, Freemius, PayPal) (fetch PUT in a Freemius module (line 3)) outside a SANDBOX_GUARDS function of the module or a private helper only those reach: refuse it on the sandbox and list the function in SANDBOX_GUARDS, or exempt it by name with the reason in VENDOR_WRITERS (tools/scripts/lib/sandbox-guards.js).',
      'VENDOR_WRITERS exempts libs/ecommerce/src/lib/sync.ts#gone, which no longer writes to a payment provider (Stripe, Freemius, PayPal): remove the exemption.',
      'VENDOR_WRITERS lists libs/ecommerce/src/lib/old-vendor.ts, which no longer has that side effect: remove the entry.',
    ]);
  });

  it('resolves a GoTrue handle by scope: a local merely named auth is not one, a typed or aliased parameter is', () => {
    const source = `
      type AdminApi = SupabaseClient['auth']['admin'];
      async function gate() { const auth = await requireCmsAdmin(); await auth.signUp({}); return auth.user.id; }
      async function carried() { const auth = await requireCmsAdmin(); await auth.supabase.auth.admin.deleteUser(id); }
      async function aliased(api: AdminApi) { await api.createUser({ email }); }
      async function indexed(client: SupabaseClient['auth']) { await client.signUp({ email, password }); }
      async function opaque(auth: any) { await auth.signInWithOtp({ email }); }
      async function optional() { await supabase.auth?.admin.deleteUser(id); await supabase.auth!.mfa.unenroll({ factorId }); }
      async function stored() { const admin = supabase.auth?.admin; await admin.inviteUserByEmail(email); }
    `;
    expect(sideEffectsInSource('fixture.ts', source).account).toEqual([
      'auth.admin.deleteUser (line 4)',
      'auth.admin.createUser (line 5)',
      'auth.signUp (line 6)',
      'auth.signInWithOtp (line 7)',
      'auth.admin.deleteUser (line 8)',
      'auth.mfa.unenroll (line 8)',
      'auth.admin.inviteUserByEmail (line 9)',
    ]);
  });

  it('finds a Stripe client carried in an object, typed on a variable or field, or returned by a loader', () => {
    const source = `
      async function connect(context) { const { stripe } = context; await stripe.accounts.update('acct', {}); await context.stripe.accounts.del('acct'); }
      async function payout(deps) { await deps.stripe.transfers.create({}); await deps.stripe.balance.retrieve(); }
      let cached: Stripe | null = null;
      async function refund() { await cached!.refunds.create({}); const c: Stripe = await build(); await c.payouts.create({}); }
      class Sync { private client: Stripe; async run() { await this.client.customers.create({}); } }
      async function sync() { await (await loadStripe()).charges.create({}); await (await loadStripe()).charges.retrieve('ch'); }
      function keys(config) { return config.stripe.publishableKey.trim(); }
    `;
    expect(sideEffectsInSource('fixture.ts', source).vendor).toEqual([
      'stripe.accounts.update (line 2)',
      'stripe.accounts.del (line 2)',
      'stripe.transfers.create (line 3)',
      'stripe.refunds.create (line 5)',
      'stripe.payouts.create (line 5)',
      'stripe.customers.create (line 6)',
      'stripe.charges.create (line 7)',
    ]);
  });

  it('finds a Freemius write through the shared URL constant, and not a fetch to this site or a comment mention', () => {
    const viaConstant = `
      import { FREEMIUS_API_URL } from './activate-license';
      export async function drop(id) { await fetch(\`\${FREEMIUS_API_URL}/coupons/\${id}.json\`, { method: 'DELETE' }); }
      export async function save(id) { await fetch('/api/cms/payments/test', { method: 'POST' }); await fetch(\`/api/cms/coupons/\${id}\`, { method: 'PUT' }); }
    `;
    expect(sideEffectsInSource('fixture.ts', viaConstant).vendor).toEqual(['fetch DELETE in a Freemius module (line 3)']);
    const commentOnly = `
      // Docs: https://freemius.com/help/documentation/
      export async function save(url) { await fetch(url, { method: 'POST' }); }
    `;
    expect(sideEffectsInSource('fixture.ts', commentOnly).vendor).toEqual([]);
  });

  it('finds PayPal writes (02037): a non-GET fetch in a PayPal module and the client write verbs, not reads or other hosts', () => {
    const client = `
      const BASE = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
      export async function send(request) { const fetch = request.fetch ?? globalThis.fetch; return fetch(request.url, { method: request.method }); }
      export async function token(url) { return fetch(url, { method: 'POST' }); }
      export async function batch(url) { return fetch(url); }
      export async function local() { return fetch('/api/affiliates/paypal', { method: 'POST' }); }
    `;
    expect(sideEffectsInSource('fixture.ts', client).vendor).toEqual([
      'fetch (method not a literal) in a PayPal module (line 3)',
      'fetch POST in a PayPal module (line 4)',
    ]);
    const engine = `
      export async function pay(client) { await client.createPayoutBatch({ senderBatchId }); await client.getPayoutBatch('B1'); }
      export async function cancel(deps) { const item = await deps.client.getPayoutItem('I1'); await deps.client.cancelPayoutItem(item.itemId); }
    `;
    expect(sideEffectsInSource('fixture.ts', engine).vendor).toEqual(['PayPal createPayoutBatch (line 2)', 'PayPal cancelPayoutItem (line 3)']);
    const docsOnly = `
      // Docs: https://api-m.paypal.com/v1/payments/payouts
      export async function save(url) { await fetch(url, { method: 'POST' }); }
    `;
    expect(sideEffectsInSource('fixture.ts', docsOnly).vendor).toEqual([]);
  });

  it('accepts a PayPal write only inside a SANDBOX_GUARDS function of the module (or a helper only those reach)', () => {
    const repoPath = 'apps/nextblock/lib/affiliates/paypal/engine.ts';
    const modules = new Map([['/repo/engine.ts', { absolute: '/repo/engine.ts', repoPath }]]);
    const source = `
      async function sendBatch(client) { await client.createPayoutBatch({}); }
      export async function run(client) { if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return; await sendBatch(client); }
      export async function cancelOne(client) { await client.cancelPayoutItem('I1'); }
    `;
    const guards = [{ file: repoPath, functions: ['run'], test: 'x.test.ts', why: 'Why.' }];
    const lists = { mail: new Map(), account: new Map(), storage: new Map(), vendor: new Map([[repoPath, { why: 'Why.' }]]) };
    expect(findUnlistedSideEffects(modules, lists, () => source, guards)).toEqual([
      `${repoPath}#cancelOne writes to a payment provider (Stripe, Freemius, PayPal) (PayPal cancelPayoutItem (line 4)) outside a SANDBOX_GUARDS function of the module or a private helper only those reach: refuse it on the sandbox and list the function in SANDBOX_GUARDS, or exempt it by name with the reason in VENDOR_WRITERS (tools/scripts/lib/sandbox-guards.js).`,
    ]);
  });

  it('finds the Freemius SDK services and portal processors that write, and not their reads or a Supabase update', () => {
    const source = `import { Freemius } from '@freemius/sdk';
      await freemius.api.license.update(licenseId, { expiration: null });
      await freemius.api.subscription.cancel(subscriptionId);
      await freemius.api.license.retrieve(licenseId);
      await freemius.api.user.retrieveMany();
      await supabase.from('licenses').update({ status }).eq('id', id);
      export const POST = freemius.customerPortal.request.createProcessor({ portalEndpoint });
      await freemius.customerPortal.action.cancelRenewal.processAction(request);
    `;
    expect(sideEffectsInSource('fixture.ts', source).vendor).toEqual([
      'Freemius SDK api.license.update (line 2)',
      'Freemius SDK api.subscription.cancel (line 3)',
      'Freemius SDK customerPortal createProcessor (line 7)',
      'Freemius SDK customerPortal processAction (line 8)',
    ]);
  });

  it('counts a callback, a timer or static class code that runs at import as module level', () => {
    const repoPath = 'apps/nextblock/lib/seed.ts';
    const modules = new Map([['/repo/seed.ts', { absolute: '/repo/seed.ts', repoPath }]]);
    const source = `
      export async function guarded() { if (isSandboxEnvironment()) return; }
      const users = await Promise.all(emails.map((email) => admin.auth.admin.createUser({ email })));
      const pending = ready.then(() => admin.auth.admin.deleteUser(id));
      const timer = setTimeout(() => admin.auth.admin.updateUserById(id, {}), 0);
      export class Seeder { static seeded = admin.auth.admin.inviteUserByEmail(email); static { void admin.auth.admin.generateLink({}); } }
      const cached = cache(async () => admin.auth.admin.deleteUser(id));
      function make() { return class { static made = admin.auth.admin.createUser({ email }); }; }
    `;
    const guards = [{ file: repoPath, functions: ['guarded'], test: 'x.test.ts', why: 'Why.' }];
    const lists = { mail: new Map(), account: new Map([[repoPath, { why: 'Why.' }]]), storage: new Map(), vendor: new Map() };
    const found = findUnlistedSideEffects(modules, lists, () => source, guards).map(
      (problem: string) => problem.match(/#(\S+) calls [^(]*\((auth\.[\w.]+ \(line \d+\))\)/)?.slice(1).join(' ')
    );
    // `cached` and `make` are kept for later (a wrapper call, a function body): never used, they stay accepted.
    expect(found).toEqual([
      '(module) auth.admin.createUser (line 3)',
      '(module) auth.admin.deleteUser (line 4)',
      '(module) auth.admin.updateUserById (line 5)',
      '(module) auth.admin.inviteUserByEmail (line 6)',
      '(module) auth.admin.generateLink (line 6)',
    ]);
  });

  it('accepts a private class only guards reach, and keys an anonymous default class as default', () => {
    const repoPath = 'apps/nextblock/lib/seed.ts';
    const modules = new Map([['/repo/seed.ts', { absolute: '/repo/seed.ts', repoPath }]]);
    const source = `
      class Seeder { async run() { await admin.auth.admin.createUser({ email }); } }
      export async function guarded() { if (isSandboxEnvironment()) return; await new Seeder().run(); }
      export default class { async wipe() { await admin.auth.admin.deleteUser(id); } }
    `;
    const guards = [{ file: repoPath, functions: ['guarded'], test: 'x.test.ts', why: 'Why.' }];
    const withExemptions = (exempt: Record<string, string>) => ({
      mail: new Map(),
      account: new Map([[repoPath, { why: 'Why.', exempt }]]),
      storage: new Map(),
      vendor: new Map(),
    });
    const problems = findUnlistedSideEffects(modules, withExemptions({}), () => source, guards);
    expect(problems.map((problem: string) => problem.split(' calls ')[0])).toEqual([`${repoPath}#default`]);
    expect(findUnlistedSideEffects(modules, withExemptions({ default: 'only the reset runs it' }), () => source, guards)).toEqual([]);
  });

  it('fails an unlisted side effect and a list entry that no longer has one', () => {
    const modules = new Map([['/repo/new-mailer.ts', { absolute: '/repo/new-mailer.ts', repoPath: 'apps/nextblock/lib/new-mailer.ts' }]]);
    const lists = { mail: new Map([['apps/nextblock/lib/old-mailer.ts', 'gone']]), account: new Map(), storage: new Map() };
    expect(findUnlistedSideEffects(modules, lists, () => 'const t = nodemailer.createTransport({});', [])).toEqual([
      'apps/nextblock/lib/new-mailer.ts creates a mail transport (createTransport (line 1)): refuse it on the sandbox (isSandboxEnvironment()) and list the module in MAIL_SENDERS (tools/scripts/lib/sandbox-guards.js) with how it behaves there.',
      'MAIL_SENDERS lists apps/nextblock/lib/old-mailer.ts, which no longer has that side effect: remove the entry.',
    ]);
  });
});

describe('the repository', () => {
  // Scanned once at collection time, like the other repository-wide gates: under a full parallel
  // run the scan alone outlasts a test's default timeout.
  const unlisted: string[] = findUnlistedSideEffects(scanRepository());

  it('keeps every listed sandbox refusal, each with a test that sets the flag', () => {
    expect(findFlagReaderProblems()).toEqual([]);
    expect(findGuardProblems()).toEqual([]);
  });

  it('says how every mail sender, account writer and storage writer behaves on the sandbox', () => {
    expect(unlisted).toEqual([]);
  });

  it('empties the bucket on every sandbox reset, which is what keeps uploads open there', () => {
    // Uploads stay open on the sandbox because nothing a visitor stores outlives the next reset.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'apps/nextblock/app/api/cron/reset-sandbox/route.ts'), 'utf8');
    expect(source).toMatch(/new ListObjectsV2Command\(/);
    expect(sideEffectsInSource('route.ts', source).storage.some((effect: string) => effect.startsWith('new DeleteObjectsCommand'))).toBe(true);
    // And it says so when uploads would land somewhere it does not empty (another backend or bucket).
    expect(source).toContain('checkSandboxUploadTarget(r2BucketName');
  });
});
