import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const dbServerMocks = vi.hoisted(() => ({
  getServiceRoleSupabaseClient: vi.fn(),
  verifyPackageOnline: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => dbServerMocks);
vi.mock('server-only', () => ({}));

import {
  buildCartCheckoutReference,
  cancelUcpCart,
  cartAccessTokenMatches,
  cartCheckoutHandoffAllowed,
  createUcpCart,
  getUcpCart,
  getUcpCartCheckoutItems,
  mintCartAccessToken,
  parseCartCheckoutReference,
  readCartAccessToken,
  updateUcpCart,
} from './server';

const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const PRODUCT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const BASE_URL = 'https://shop.example';

const product = {
  id: PRODUCT_ID,
  title: 'Live product',
  slug: 'live-product',
  sku: 'LIVE-1',
  upc: null,
  status: 'active',
  price: 25,
  prices: { USD: 25 },
  stock: 10,
  product_type: 'physical',
  is_taxable: true,
  languages: null,
  product_media: [],
  product_categories: [],
  product_variants: [],
  freemius_plans: [],
};

interface CartRow {
  id: string;
  status: string;
  expires_at: string;
  access_token_hash: string | null;
  checkout_url: string | null;
  buyer_identity: Record<string, unknown>;
  line_items: unknown[];
  [key: string]: unknown;
}

type Filter = [op: string, column: string, value: unknown];

interface QueryContext {
  table: string;
  op: 'select' | 'insert' | 'update';
  filters: Filter[];
  payload?: Record<string, unknown>;
  single: boolean;
}

/**
 * Minimal in-memory stand-in for the PostgREST chains server.ts builds. `products` always
 * resolves the one fixture product by id (and nothing by slug/sku/upc), `currencies` is empty so
 * the module falls back to USD, and `ucp_cart_sessions` is a real row store so the tests can see
 * exactly what the create/update/cancel paths wrote.
 */
function createFakeDb() {
  const cartRows: CartRow[] = [];
  const calls: QueryContext[] = [];

  const matches = (row: CartRow, filters: Filter[]) =>
    filters.every(([op, column, value]) => {
      const actual = row[column];
      if (op === 'eq') return actual === value;
      if (op === 'neq') return actual !== value;
      if (op === 'gt') return String(actual) > String(value);
      if (op === 'in') return Array.isArray(value) && value.includes(actual);
      return true;
    });

  const run = (ctx: QueryContext): { data: unknown; error: null } => {
    if (ctx.table === 'currencies') {
      return { data: [], error: null };
    }

    if (ctx.table === 'products' || ctx.table === 'product_variants') {
      const byId = ctx.filters.find(
        ([op, column, value]) =>
          op === 'in' && column === 'id' && Array.isArray(value) && value.includes(PRODUCT_ID)
      );
      return { data: ctx.table === 'products' && byId ? [product] : [], error: null };
    }

    if (ctx.table !== 'ucp_cart_sessions') {
      throw new Error(`Unexpected table ${ctx.table}`);
    }

    if (ctx.op === 'insert') {
      const row: CartRow = {
        id: crypto.randomUUID(),
        status: 'active',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_hash: null,
        checkout_url: null,
        buyer_identity: {},
        line_items: [],
        ...(ctx.payload as Partial<CartRow>),
      };
      cartRows.push(row);
      return { data: { ...row }, error: null };
    }

    const matched = cartRows.filter((row) => matches(row, ctx.filters));
    if (ctx.op === 'update') {
      matched.forEach((row) => Object.assign(row, ctx.payload));
    }

    const data = matched.map((row) => ({ ...row }));
    return { data: ctx.single ? (data[0] ?? null) : data, error: null };
  };

  const client = {
    from(table: string) {
      const ctx: QueryContext = { table, op: 'select', filters: [], single: false };
      calls.push(ctx);
      const builder: Record<string, unknown> = {};
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          if (name === 'insert' || name === 'update') {
            ctx.op = name;
            ctx.payload = args[0] as Record<string, unknown>;
          } else if (name === 'eq' || name === 'neq' || name === 'gt' || name === 'in') {
            ctx.filters.push([name, args[0] as string, args[1]]);
          } else if (name === 'single' || name === 'maybeSingle') {
            ctx.single = true;
          }
          return builder;
        };
      for (const name of [
        'select',
        'insert',
        'update',
        'eq',
        'neq',
        'gt',
        'in',
        'or',
        'order',
        'limit',
        'single',
        'maybeSingle',
      ]) {
        builder[name] = chain(name);
      }
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown
      ) => Promise.resolve().then(() => run(ctx)).then(resolve, reject);
      return builder;
    },
  };

  return { client, cartRows, calls };
}

function makeRequest(path: string, init: RequestInit = {}) {
  return new Request(`${BASE_URL}${path}`, init);
}

const createBody = {
  line_items: [{ item: { id: PRODUCT_ID }, quantity: 2 }],
  buyer: {
    email: 'victim-secret@example.com',
    phone: '+1-555-0199',
    name: 'Victim Buyer',
    shipping_address: { line1: '42 Private Lane', city: 'Ottawa', postal_code: 'K1A0B1' },
  },
};

describe('UCP cart access token helpers', () => {
  it('mints a 32-byte base64url token and stores only its sha256', () => {
    const minted = mintCartAccessToken();
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.tokenHash).toBe(sha256Hex(minted.token));
    expect(mintCartAccessToken().token).not.toBe(minted.token);
  });

  it('reads the token from X-Cart-Token or a bearer Authorization header', () => {
    const { token } = mintCartAccessToken();
    expect(readCartAccessToken(new Request(BASE_URL, { headers: { 'x-cart-token': token } }))).toBe(
      token
    );
    expect(
      readCartAccessToken(new Request(BASE_URL, { headers: { authorization: `Bearer ${token}` } }))
    ).toBe(token);
    expect(readCartAccessToken(new Request(BASE_URL))).toBeNull();
    expect(readCartAccessToken(new Request(BASE_URL, { headers: { 'x-cart-token': 'short' } }))).toBeNull();
  });

  it('matches only the minted token: never the stored hash, a legacy row or no token', () => {
    const { token, tokenHash } = mintCartAccessToken();
    const row = { id: crypto.randomUUID(), access_token_hash: tokenHash };

    expect(cartAccessTokenMatches(row, token)).toBe(true);
    expect(cartAccessTokenMatches(row, mintCartAccessToken().token)).toBe(false);
    expect(cartAccessTokenMatches(row, tokenHash)).toBe(false);
    expect(cartAccessTokenMatches(row, null)).toBe(false);
    expect(cartAccessTokenMatches({ ...row, access_token_hash: null }, token)).toBe(false);
    expect(cartAccessTokenMatches(null, token)).toBe(false);
  });

  it('round-trips the checkout reference and rejects anything malformed', () => {
    const id = crypto.randomUUID();
    const { tokenHash } = mintCartAccessToken();

    expect(parseCartCheckoutReference(buildCartCheckoutReference({ id, access_token_hash: tokenHash }))).toEqual({
      id,
      handoffKey: tokenHash,
    });
    expect(parseCartCheckoutReference(buildCartCheckoutReference({ id, access_token_hash: null }))).toEqual({
      id,
      handoffKey: null,
    });
    expect(parseCartCheckoutReference(`${id}.not-a-hash`)).toBeNull();
    expect(parseCartCheckoutReference(`not-a-uuid.${tokenHash}`)).toBeNull();
    expect(parseCartCheckoutReference('')).toBeNull();
    expect(parseCartCheckoutReference(undefined)).toBeNull();
  });

  it('allows the checkout hand-off with the derived key, and by bare id only for a legacy row', () => {
    const { token, tokenHash } = mintCartAccessToken();
    const row = { id: crypto.randomUUID(), access_token_hash: tokenHash };

    expect(cartCheckoutHandoffAllowed(row, tokenHash)).toBe(true);
    expect(cartCheckoutHandoffAllowed(row, null)).toBe(false);
    expect(cartCheckoutHandoffAllowed(row, token)).toBe(false);
    expect(cartCheckoutHandoffAllowed(row, mintCartAccessToken().tokenHash)).toBe(false);
    expect(cartCheckoutHandoffAllowed({ ...row, access_token_hash: null }, null)).toBe(true);
    expect(cartCheckoutHandoffAllowed(null, tokenHash)).toBe(false);
  });
});

describe('UCP cart routes require the per-cart token', () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_URL', '');
    db = createFakeDb();
    dbServerMocks.getServiceRoleSupabaseClient.mockReturnValue(db.client);
    dbServerMocks.verifyPackageOnline.mockResolvedValue(true);
  });

  async function createCart() {
    const result = await createUcpCart(createBody, makeRequest('/ucp/v1/carts', { method: 'POST' }));
    expect(result.status).toBe(201);
    const body = result.body as Record<string, any>;
    return { id: body.id as string, token: body.access_token as string, body };
  }

  it('create stores sha256(access_token), returns the token once and keeps it out of continue_url', async () => {
    const { id, token, body } = await createCart();
    const row = db.cartRows.find((candidate) => candidate.id === id);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.access_token_hash).toBe(sha256Hex(token));
    expect(body.buyer.email).toBe('victim-secret@example.com');
    expect(body.continue_url).toBe(
      `${BASE_URL}/checkout?ucp_cart=${encodeURIComponent(`${id}.${sha256Hex(token)}`)}`
    );
    expect(body.continue_url).not.toContain(token);
    expect(row?.checkout_url).toBe(body.continue_url);
    expect(JSON.stringify(body)).not.toContain(sha256Hex(token).slice(0, 8) + '"');
  });

  it('get, update and cancel answer 404 without the token, identical to an unknown id, and leave the row alone', async () => {
    const { id } = await createCart();
    const before = JSON.stringify(db.cartRows.find((row) => row.id === id));
    const wrongToken = mintCartAccessToken().token;

    const bare = await getUcpCart(id, makeRequest(`/ucp/v1/carts/${id}`));
    const wrong = await getUcpCart(id, makeRequest(`/ucp/v1/carts/${id}`, { headers: { 'x-cart-token': wrongToken } }));
    const hashAsToken = await getUcpCart(
      id,
      makeRequest(`/ucp/v1/carts/${id}`, { headers: { 'x-cart-token': sha256Hex(wrongToken) } })
    );
    const unknown = await getUcpCart(crypto.randomUUID(), makeRequest('/ucp/v1/carts/x'));

    for (const result of [bare, wrong, hashAsToken, unknown]) {
      expect(result.status).toBe(404);
      expect((result.body as any).messages[0].code).toBe('not_found');
      expect(result.body).not.toHaveProperty('buyer');
    }
    expect(bare.body).toEqual(unknown.body);

    const update = await updateUcpCart(
      id,
      { ...createBody, buyer: { email: 'attacker-redirect@evil.example', name: 'Hijacked' } },
      makeRequest(`/ucp/v1/carts/${id}`, { method: 'PUT' })
    );
    const cancel = await cancelUcpCart(id, makeRequest(`/ucp/v1/carts/${id}/cancel`, { method: 'POST' }));

    expect(update.status).toBe(404);
    expect(cancel.status).toBe(404);
    expect(JSON.stringify(db.cartRows.find((row) => row.id === id))).toBe(before);
    expect(
      db.calls.filter((call) => call.table === 'ucp_cart_sessions' && call.op === 'update').length
    ).toBe(1); // only create's own checkout_url write
  });

  it('get, update and cancel succeed with the token (header or bearer) and never echo it', async () => {
    const { id, token } = await createCart();
    const tokenHeader = { 'x-cart-token': token };

    const read = await getUcpCart(id, makeRequest(`/ucp/v1/carts/${id}`, { headers: tokenHeader }));
    expect(read.status).toBe(200);
    expect((read.body as any).id).toBe(id);
    expect((read.body as any).buyer.email).toBe('victim-secret@example.com');
    expect(read.body).not.toHaveProperty('access_token');
    expect(read.body).not.toHaveProperty('access_token_hash');
    expect(JSON.stringify(read.body)).not.toContain(token);

    const updated = await updateUcpCart(
      id,
      { ...createBody, buyer: { email: 'buyer@example.com', name: 'Same Buyer' } },
      makeRequest(`/ucp/v1/carts/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` } })
    );
    expect(updated.status).toBe(200);
    expect((updated.body as any).buyer.email).toBe('buyer@example.com');
    expect(db.cartRows.find((row) => row.id === id)?.access_token_hash).toBe(sha256Hex(token));

    const cancelled = await cancelUcpCart(
      id,
      makeRequest(`/ucp/v1/carts/${id}/cancel`, { method: 'POST', headers: tokenHeader })
    );
    expect(cancelled.status).toBe(200);
    expect(db.cartRows.find((row) => row.id === id)?.status).toBe('cancelled');

    const afterCancel = await getUcpCart(id, makeRequest(`/ucp/v1/carts/${id}`, { headers: tokenHeader }));
    expect(afterCancel.status).toBe(404);
  });

  it('checkout hydration needs the derived key for a tokenised cart and never accepts the raw token', async () => {
    const { id, token } = await createCart();
    const key = sha256Hex(token);

    expect(await getUcpCartCheckoutItems(id)).toEqual([]);
    expect(await getUcpCartCheckoutItems(`${id}.${token}`)).toEqual([]);
    expect(await getUcpCartCheckoutItems(`${id}.${sha256Hex('other')}`)).toEqual([]);

    const items = await getUcpCartCheckoutItems(`${id}.${key}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ product_id: PRODUCT_ID, quantity: 2 });
    expect(JSON.stringify(items)).not.toContain('victim-secret@example.com');
  });

  it('a legacy row with no token hash is not found through the API but still hydrates checkout by bare id', async () => {
    const legacyId = crypto.randomUUID();
    db.cartRows.push({
      id: legacyId,
      status: 'active',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_token_hash: null,
      checkout_url: `${BASE_URL}/checkout?ucp_cart=${legacyId}`,
      buyer_identity: { email: 'legacy@example.com' },
      line_items: [{ id: 'li_1', cart_item: { id: PRODUCT_ID, product_id: PRODUCT_ID, quantity: 1 } }],
    });

    const anyToken = mintCartAccessToken().token;
    expect((await getUcpCart(legacyId, makeRequest(`/ucp/v1/carts/${legacyId}`))).status).toBe(404);
    expect(
      (await getUcpCart(legacyId, makeRequest(`/ucp/v1/carts/${legacyId}`, { headers: { 'x-cart-token': anyToken } })))
        .status
    ).toBe(404);
    expect((await cancelUcpCart(legacyId, makeRequest(`/ucp/v1/carts/${legacyId}/cancel`))).status).toBe(404);
    expect(db.cartRows.find((row) => row.id === legacyId)?.status).toBe('active');

    expect(await getUcpCartCheckoutItems(legacyId)).toEqual([
      { id: PRODUCT_ID, product_id: PRODUCT_ID, quantity: 1 },
    ]);
  });
});
