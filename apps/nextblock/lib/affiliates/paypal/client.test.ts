import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PayPal Payouts client (02037). PayPal is never called here: every test passes a fake `fetch`
 * (never api-m.paypal.com or api-m.sandbox.paypal.com). It proves the sandbox refusal before any
 * request, the fixed hosts and `/v1/` paths, the token cache, the create-batch request (the
 * PayPal-Request-Id is the sender_batch_id, amounts in PayPal's format, an ASCII subject), the error
 * mapping the engine acts on (a reused sender_batch_id is adopted), zod on every answer, and that the
 * secret never leaves the Basic header.
 */

vi.mock('server-only', () => ({}));

import {
  AFFILIATE_PAYPAL_API_BASE_URLS,
  AffiliatePayPalError,
  canAffiliatePayPalSendAmount,
  classifyAffiliatePayPalResponse,
  clearAffiliatePayPalTokenCache,
  createAffiliatePayPalClient,
  formatAffiliatePayPalApiAmount,
  isAffiliatePayPalPayoutCurrency,
  isAffiliatePayPalZeroDecimalCurrency,
  parseAffiliatePayPalAmountMinor,
  sendAffiliatePayPalRequest,
  toAffiliatePayPalAscii,
  type AffiliatePayPalCredentials,
} from './client';

type Answer = { status: number; body?: unknown };
type Call = { url: string; init: RequestInit };

const CREDENTIALS: AffiliatePayPalCredentials = { environment: 'sandbox', clientId: 'AbCdEfGhIjKlMnOp1234', secret: 'super-secret-value-xyz' };
const TOKEN_BODY = {
  access_token: 'A21AA-token',
  token_type: 'Bearer',
  expires_in: 32400,
  scope: 'https://uri.paypal.com/services/payments/payouts https://uri.paypal.com/payments/payouts openid',
  app_id: 'APP-80W284485P519543T',
};

/** A fake fetch answering each call from the queue (the last answer repeats), recording the calls. */
function fakeFetch(...answers: Answer[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers.length > 1 ? (answers.shift() as Answer) : (answers[0] as Answer);
    const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}

function bodyOf(call: Call | undefined): any {
  return JSON.parse(String(call?.init.body ?? 'null'));
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  clearAffiliatePayPalTokenCache();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('sendAffiliatePayPalRequest', () => {
  it('refuses on the public sandbox before any fetch, whatever the request', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { fetch, mock } = fakeFetch({ status: 200, body: TOKEN_BODY });
    await expect(
      sendAffiliatePayPalRequest({ environment: 'live', path: '/v1/payments/payouts', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000, fetch })
    ).rejects.toMatchObject({ kind: 'sandbox' });
    const client = createAffiliatePayPalClient(CREDENTIALS, { fetch });
    await expect(client.getToken()).rejects.toMatchObject({ kind: 'sandbox' });
    await expect(
      client.createPayoutBatch({
        senderBatchId: 'b1',
        emailSubject: 'Payout',
        emailMessage: 'Thanks',
        items: [{ receiver: 'p@example.com', amountCents: 1000, currency: 'USD', note: 'n', senderItemId: 'x' }],
      })
    ).rejects.toMatchObject({ kind: 'sandbox' });
    await expect(client.cancelPayoutItem('ITEM1')).rejects.toMatchObject({ kind: 'sandbox' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('builds the URL from the environment host and a /v1/ path only, and refuses redirects', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: {} });
    await sendAffiliatePayPalRequest({ environment: 'sandbox', path: '/v1/reporting/balances', method: 'GET', headers: {}, timeoutMs: 1000, fetch });
    await sendAffiliatePayPalRequest({ environment: 'live', path: '/v1/reporting/balances', method: 'GET', headers: {}, timeoutMs: 1000, fetch });
    expect(calls.map((call) => call.url)).toEqual([
      `${AFFILIATE_PAYPAL_API_BASE_URLS.sandbox}/v1/reporting/balances`,
      `${AFFILIATE_PAYPAL_API_BASE_URLS.live}/v1/reporting/balances`,
    ]);
    expect(AFFILIATE_PAYPAL_API_BASE_URLS).toEqual({ sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' });
    expect(calls[0]?.init.redirect).toBe('error');

    for (const path of ['https://evil.example/v1/x', '//evil.example/v1/x', '/v2/payments', '/v1/../oauth2', '/v1/a b']) {
      await expect(
        sendAffiliatePayPalRequest({ environment: 'sandbox', path, method: 'GET', headers: {}, timeoutMs: 1000, fetch })
      ).rejects.toMatchObject({ kind: 'refused' });
    }
    await expect(
      sendAffiliatePayPalRequest({ environment: 'staging' as never, path: '/v1/x', method: 'GET', headers: {}, timeoutMs: 1000, fetch })
    ).rejects.toMatchObject({ kind: 'refused' });
    expect(calls).toHaveLength(2);
  });

  it('maps a network failure and a timeout to unavailable (the outcome is unknown)', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(
      sendAffiliatePayPalRequest({ environment: 'sandbox', path: '/v1/x', method: 'GET', headers: {}, timeoutMs: 1000, fetch: failing })
    ).rejects.toMatchObject({ kind: 'unavailable' });

    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    ) as unknown as typeof globalThis.fetch;
    await expect(
      sendAffiliatePayPalRequest({ environment: 'sandbox', path: '/v1/x', method: 'POST', headers: {}, timeoutMs: 5, fetch: hanging })
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('the token', () => {
  it('asks with HTTP Basic, caches it per credentials, and keeps the secret out of the URL and body', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: TOKEN_BODY });
    const client = createAffiliatePayPalClient(CREDENTIALS, { fetch });
    const token = await client.getToken();
    expect(token.accessToken).toBe('A21AA-token');
    expect(token.scopes).toContain('https://uri.paypal.com/payments/payouts');
    expect(token.appId).toBe('APP-80W284485P519543T');
    expect(calls[0]?.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('grant_type=client_credentials');
    expect(headersOf(calls[0])['Authorization']).toBe(
      `Basic ${Buffer.from(`${CREDENTIALS.clientId}:${CREDENTIALS.secret}`).toString('base64')}`
    );
    expect(calls[0]?.url).not.toContain(CREDENTIALS.secret);

    await client.getToken();
    await createAffiliatePayPalClient(CREDENTIALS, { fetch }).getToken();
    expect(calls).toHaveLength(1);
    await client.getToken({ fresh: true });
    expect(calls).toHaveLength(2);
    // Other credentials never reuse it.
    await createAffiliatePayPalClient({ ...CREDENTIALS, secret: 'another-secret' }, { fetch }).getToken();
    expect(calls).toHaveLength(3);
  });

  it('renews a token five minutes before it expires', async () => {
    let now = 1_000_000;
    const { fetch, calls } = fakeFetch({ status: 200, body: { ...TOKEN_BODY, expires_in: 3600 } });
    const client = createAffiliatePayPalClient(CREDENTIALS, { fetch, now: () => now });
    await client.getToken();
    now += 54 * 60 * 1000;
    await client.getToken();
    expect(calls).toHaveLength(1);
    now += 2 * 60 * 1000;
    await client.getToken();
    expect(calls).toHaveLength(2);
  });

  it('reads rejected credentials (401, or 400 invalid_client) as credentials, and a bad token body as malformed', async () => {
    await expect(
      createAffiliatePayPalClient(CREDENTIALS, { fetch: fakeFetch({ status: 401, body: { error: 'invalid_client' } }).fetch }).getToken()
    ).rejects.toMatchObject({ kind: 'credentials', code: 'INVALID_CLIENT' });
    clearAffiliatePayPalTokenCache();
    await expect(
      createAffiliatePayPalClient(CREDENTIALS, { fetch: fakeFetch({ status: 400, body: { error: 'invalid_request' } }).fetch }).getToken()
    ).rejects.toMatchObject({ kind: 'credentials' });
    clearAffiliatePayPalTokenCache();
    await expect(
      createAffiliatePayPalClient(CREDENTIALS, { fetch: fakeFetch({ status: 200, body: { access_token: '', token_type: 'Bearer' } }).fetch }).getToken()
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('refuses credentials of the wrong shape before any request', () => {
    expect(() => createAffiliatePayPalClient({ ...CREDENTIALS, secret: ' ' })).toThrow(AffiliatePayPalError);
    expect(() => createAffiliatePayPalClient({ ...CREDENTIALS, environment: 'prod' as never })).toThrow(AffiliatePayPalError);
  });
});

describe('createPayoutBatch', () => {
  const input = {
    senderBatchId: 'b5a7c2e0-1111-4222-8333-944455556666',
    emailSubject: 'Votre paiement de Café Été',
    emailMessage: 'Thank you   for\n promoting us.',
    items: [
      { receiver: 'partner@example.com', amountCents: 1234, currency: 'USD', note: 'Commissions (3)', senderItemId: 'payout-1' },
      { receiver: 'other@example.com', amountCents: 5000, currency: 'JPY', note: 'Commissions (1)', senderItemId: 'payout-2' },
    ],
  };

  it('sends one idempotent request: PayPal-Request-Id is the sender_batch_id, amounts in PayPal format, PayPal wallets', async () => {
    const { fetch, calls } = fakeFetch(
      { status: 200, body: TOKEN_BODY },
      { status: 201, body: { batch_header: { payout_batch_id: 'BATCH123', batch_status: 'PENDING', sender_batch_header: { sender_batch_id: input.senderBatchId } } } }
    );
    const created = await createAffiliatePayPalClient(CREDENTIALS, { fetch }).createPayoutBatch(input);
    expect(created).toEqual({ batchId: 'BATCH123', status: 'PENDING' });

    const request = calls[1];
    expect(request?.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts');
    expect(request?.init.method).toBe('POST');
    expect(headersOf(request)['PayPal-Request-Id']).toBe(input.senderBatchId);
    expect(headersOf(request)['Authorization']).toBe('Bearer A21AA-token');
    const body = bodyOf(request);
    expect(body.sender_batch_header).toEqual({
      sender_batch_id: input.senderBatchId,
      recipient_type: 'EMAIL',
      email_subject: 'Votre paiement de Cafe Ete',
      email_message: 'Thank you for promoting us.',
    });
    expect(body.items).toEqual([
      {
        recipient_type: 'EMAIL',
        amount: { value: '12.34', currency: 'USD' },
        receiver: 'partner@example.com',
        note: 'Commissions (3)',
        sender_item_id: 'payout-1',
        recipient_wallet: 'PAYPAL',
        purpose: 'SERVICES',
      },
      {
        recipient_type: 'EMAIL',
        amount: { value: '5000', currency: 'JPY' },
        receiver: 'other@example.com',
        note: 'Commissions (1)',
        sender_item_id: 'payout-2',
        recipient_wallet: 'PAYPAL',
        purpose: 'SERVICES',
      },
    ]);
  });

  it('refuses a bad sender id, an empty batch or a zero amount without calling PayPal', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: TOKEN_BODY });
    const client = createAffiliatePayPalClient(CREDENTIALS, { fetch });
    await expect(client.createPayoutBatch({ ...input, senderBatchId: 'bad id!' })).rejects.toMatchObject({ kind: 'refused' });
    await expect(client.createPayoutBatch({ ...input, items: [] })).rejects.toMatchObject({ kind: 'refused' });
    await expect(
      client.createPayoutBatch({ ...input, items: [{ ...input.items[0], amountCents: 0 }] as typeof input.items })
    ).rejects.toMatchObject({ kind: 'refused' });
    expect(calls.filter((call) => call.url.endsWith('/v1/payments/payouts'))).toHaveLength(0);
  });

  it('refuses a currency PayPal Payouts does not send, and a HUF or TWD amount with a fraction, without calling PayPal', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: TOKEN_BODY });
    const client = createAffiliatePayPalClient(CREDENTIALS, { fetch });
    const one = (currency: string, amountCents: number) => ({ ...input, items: [{ ...input.items[0], currency, amountCents }] as typeof input.items });
    await expect(client.createPayoutBatch(one('KRW', 5000))).rejects.toMatchObject({ kind: 'refused', code: 'CURRENCY_NOT_SUPPORTED' });
    await expect(client.createPayoutBatch(one('HUF', 123456))).rejects.toMatchObject({ kind: 'refused', code: 'NOT_WHOLE_UNITS' });
    await expect(client.createPayoutBatch(one('TWD', 98765))).rejects.toMatchObject({ kind: 'refused', code: 'NOT_WHOLE_UNITS' });
    expect(calls.filter((call) => call.url.endsWith('/v1/payments/payouts'))).toHaveLength(0);
  });

  it('adopts the batch of a 2xx answer that does not validate when its batch id is readable, and calls the rest malformed', async () => {
    const readable = fakeFetch({ status: 200, body: TOKEN_BODY }, { status: 201, body: { batch_header: { payout_batch_id: 'BATCH777', batch_status: 42 } } });
    await expect(createAffiliatePayPalClient(CREDENTIALS, { fetch: readable.fetch }).createPayoutBatch(input)).resolves.toEqual({
      batchId: 'BATCH777',
      status: null,
    });
    // a null batch_status is not malformed
    clearAffiliatePayPalTokenCache();
    const nullStatus = fakeFetch({ status: 200, body: TOKEN_BODY }, { status: 201, body: { batch_header: { payout_batch_id: 'BATCH778', batch_status: null } } });
    await expect(createAffiliatePayPalClient(CREDENTIALS, { fetch: nullStatus.fetch }).createPayoutBatch(input)).resolves.toEqual({
      batchId: 'BATCH778',
      status: null,
    });
    clearAffiliatePayPalTokenCache();
    const unreadable = fakeFetch({ status: 200, body: TOKEN_BODY }, { status: 201, body: { batch_header: { payout_batch_id: '../v1/oauth2/token' } } });
    await expect(createAffiliatePayPalClient(CREDENTIALS, { fetch: unreadable.fetch }).createPayoutBatch(input)).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('adopts the original batch when PayPal says the sender_batch_id was used, and links it', async () => {
    const { fetch } = fakeFetch(
      { status: 200, body: TOKEN_BODY },
      {
        status: 400,
        body: {
          name: 'USER_BUSINESS_ERROR',
          debug_id: 'abc123',
          details: [{ issue: 'SENDER_BATCH_ID_ALREADY_USED' }],
          links: [{ href: 'https://api-m.sandbox.paypal.com/v1/payments/payouts/ORIGINAL99', rel: 'self', method: 'GET' }],
        },
      }
    );
    await expect(createAffiliatePayPalClient(CREDENTIALS, { fetch }).createPayoutBatch(input)).rejects.toMatchObject({
      kind: 'duplicate_batch',
      batchId: 'ORIGINAL99',
      debugId: 'abc123',
    });
  });

  it('maps PayPal refusals to what the engine acts on', async () => {
    const cases: Array<[Answer, string]> = [
      [{ status: 422, body: { name: 'INSUFFICIENT_FUNDS' } }, 'insufficient_funds'],
      [{ status: 403, body: { name: 'NOT_AUTHORIZED' } }, 'not_enabled'],
      [{ status: 400, body: { name: 'REQUIRED_SCOPE_MISSING' } }, 'not_enabled'],
      [{ status: 429, body: { name: 'RATE_LIMIT_REACHED' } }, 'rate_limited'],
      [{ status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } }, 'unavailable'],
      [{ status: 409, body: { name: 'PREVIOUS_REQUEST_IN_PROGRESS' } }, 'unavailable'],
      [{ status: 400, body: { name: 'VALIDATION_ERROR', details: [{ issue: 'INVALID_EMAIL' }] } }, 'refused'],
      [{ status: 201, body: { batch_header: { payout_batch_id: 'has spaces' } } }, 'malformed'],
    ];
    for (const [answer, kind] of cases) {
      clearAffiliatePayPalTokenCache();
      const { fetch } = fakeFetch({ status: 200, body: TOKEN_BODY }, answer);
      await expect(createAffiliatePayPalClient(CREDENTIALS, { fetch }).createPayoutBatch(input)).rejects.toMatchObject({ kind });
    }
  });

  it('retries once with a fresh token after a 401 on the API call', async () => {
    const { fetch, calls } = fakeFetch(
      { status: 200, body: TOKEN_BODY },
      { status: 401, body: { error: 'invalid_token' } },
      { status: 200, body: { ...TOKEN_BODY, access_token: 'A21AA-second' } },
      { status: 201, body: { batch_header: { payout_batch_id: 'BATCH124' } } }
    );
    const created = await createAffiliatePayPalClient(CREDENTIALS, { fetch }).createPayoutBatch(input);
    expect(created.batchId).toBe('BATCH124');
    expect(calls.map((call) => call.url.replace('https://api-m.sandbox.paypal.com', ''))).toEqual([
      '/v1/oauth2/token',
      '/v1/payments/payouts',
      '/v1/oauth2/token',
      '/v1/payments/payouts',
    ]);
    // The same idempotency key on the retry: PayPal pays the batch once.
    expect(headersOf(calls[3])['PayPal-Request-Id']).toBe(input.senderBatchId);
    expect(headersOf(calls[3])['Authorization']).toBe('Bearer A21AA-second');
  });
});

describe('reads and the cancel', () => {
  const item = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    payout_item_id: id,
    transaction_id: status === 'SUCCESS' ? `TX${id}` : null,
    transaction_status: status,
    payout_item_fee: { value: '0.25', currency: 'USD' },
    payout_batch_id: 'BATCH1',
    payout_item: { sender_item_id: `payout-${id}`, receiver: 'p@example.com', amount: { value: '10.00', currency: 'USD' } },
    ...extra,
  });

  it('reads every page of a batch with total_required, and validates each item', async () => {
    const { fetch, calls } = fakeFetch(
      { status: 200, body: TOKEN_BODY },
      { status: 200, body: { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'SUCCESS' }, items: [item('I1', 'SUCCESS')], total_pages: 2 } },
      {
        status: 200,
        body: { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'SUCCESS' }, items: [item('I2', 'UNCLAIMED'), item('I3', 'FAILED', { errors: { name: 'RECEIVER_UNREGISTERED' } })] },
      }
    );
    const batch = await createAffiliatePayPalClient(CREDENTIALS, { fetch }).getPayoutBatchItems('BATCH1');
    expect(batch.status).toBe('SUCCESS');
    expect(batch.items.map((entry) => [entry.itemId, entry.status, entry.transactionId, entry.feeCents, entry.senderItemId, entry.errorName])).toEqual([
      ['I1', 'SUCCESS', 'TXI1', 25, 'payout-I1', null],
      ['I2', 'UNCLAIMED', null, 25, 'payout-I2', null],
      ['I3', 'FAILED', null, 25, 'payout-I3', 'RECEIVER_UNREGISTERED'],
    ]);
    expect(calls[1]?.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts/BATCH1?page=1&page_size=1000&total_required=true');
    expect(calls[2]?.url).toContain('page=2&');
  });

  it('refuses an id of the wrong shape before it reaches a path', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: TOKEN_BODY });
    const client = createAffiliatePayPalClient(CREDENTIALS, { fetch });
    await expect(client.getPayoutItem('../oauth2/token')).rejects.toMatchObject({ kind: 'refused' });
    await expect(client.getPayoutBatch('a/b')).rejects.toMatchObject({ kind: 'refused' });
    expect(calls).toHaveLength(0);
  });

  it('cancels an unclaimed item with POST …/cancel and reads the item PayPal answers', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: TOKEN_BODY }, { status: 200, body: item('I2', 'RETURNED') });
    const cancelled = await createAffiliatePayPalClient(CREDENTIALS, { fetch }).cancelPayoutItem('I2');
    expect(cancelled.status).toBe('RETURNED');
    expect(calls[1]?.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts-item/I2/cancel');
    expect(calls[1]?.init.method).toBe('POST');
    expect(bodyOf(calls[1])).toEqual({});
  });

  it('reads balances in minor units, and drops a malformed amount', async () => {
    const { fetch } = fakeFetch(
      { status: 200, body: TOKEN_BODY },
      {
        status: 200,
        body: {
          balances: [
            { currency: 'CAD', primary: true, available_balance: { value: '1234.56', currency_code: 'CAD' } },
            { currency: 'JPY', available_balance: { value: '700', currency_code: 'JPY' } },
            { currency: 'USD' },
          ],
        },
      }
    );
    expect(await createAffiliatePayPalClient(CREDENTIALS, { fetch }).getBalances()).toEqual([
      { currency: 'CAD', primary: true, availableCents: 123456 },
      { currency: 'JPY', primary: false, availableCents: 700 },
      { currency: 'USD', primary: false, availableCents: null },
    ]);
  });
});

describe('helpers', () => {
  it('knows the currencies PayPal Payouts sends, and which take whole units only', () => {
    for (const currency of ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'JPY', 'HUF', 'TWD', 'MXN']) expect(isAffiliatePayPalPayoutCurrency(currency), currency).toBe(true);
    for (const currency of ['KRW', 'INR', 'ZAR', 'RUB', 'TRY', '', 'usd ']) {
      expect(isAffiliatePayPalPayoutCurrency(currency), currency).toBe(currency === 'usd ');
    }
    expect(isAffiliatePayPalZeroDecimalCurrency('HUF')).toBe(true);
    expect(isAffiliatePayPalZeroDecimalCurrency('USD')).toBe(false);
    expect(canAffiliatePayPalSendAmount(2500, 'USD')).toBe(true);
    expect(canAffiliatePayPalSendAmount(123400, 'HUF')).toBe(true);
    expect(canAffiliatePayPalSendAmount(123456, 'HUF')).toBe(false);
    expect(canAffiliatePayPalSendAmount(5000, 'KRW')).toBe(false);
    expect(canAffiliatePayPalSendAmount(0, 'USD')).toBe(false);
  });

  it('formats and parses PayPal amounts per currency', () => {
    expect(formatAffiliatePayPalApiAmount(1234, 'USD')).toBe('12.34');
    expect(formatAffiliatePayPalApiAmount(5, 'CAD')).toBe('0.05');
    expect(formatAffiliatePayPalApiAmount(5000, 'JPY')).toBe('5000');
    // HUF and TWD keep two decimals in the store, none at PayPal
    expect(formatAffiliatePayPalApiAmount(123400, 'HUF')).toBe('1234');
    expect(formatAffiliatePayPalApiAmount(98700, 'TWD')).toBe('987');
    expect(formatAffiliatePayPalApiAmount(123456, 'HUF')).toBeNull();
    expect(parseAffiliatePayPalAmountMinor('12.34', 'USD')).toBe(1234);
    expect(parseAffiliatePayPalAmountMinor('-1.00', 'USD')).toBeNull();
    expect(parseAffiliatePayPalAmountMinor('1e3', 'USD')).toBeNull();
  });

  it('folds text to the single-byte characters PayPal shows', () => {
    expect(toAffiliatePayPalAscii('Versement — Été 2026 ✓', 255)).toBe('Versement Ete 2026');
    expect(toAffiliatePayPalAscii('x'.repeat(300), 255)).toHaveLength(255);
  });

  it('never classifies an unknown 4xx as retryable, and keeps only checked codes', () => {
    const error = classifyAffiliatePayPalResponse(400, { name: '<script>', debug_id: 'not ok!' });
    expect(error.kind).toBe('refused');
    expect(error.code).toBeNull();
    expect(error.debugId).toBeNull();
    expect(error.message).not.toContain('<script>');
  });
});
