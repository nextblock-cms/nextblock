import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  // Reached transitively: interactions -> email -> email/branding -> site-settings, which
  // wraps its reader in unstable_cache at module scope. Pass the loader straight through.
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

const dbServerMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  getProfileWithRoleServerSide: vi.fn(),
}));

// Deliberately exports no `headers`: the notification link must not come from the
// request's Host header, so nothing in the module under test may reach for it.
const headersMocks = vi.hoisted(() => {
  const get = vi.fn();
  const set = vi.fn();
  return {
    cookies: vi.fn().mockResolvedValue({ get, set }),
  };
});

const emailMocks = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

// The notification-address actions authorize with requireCmsAdmin() and write with the
// service-role client it returns (migration 02028: the key is in the second-factor tier).
const cmsActorMocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("next/headers", () => headersMocks);
vi.mock("@nextblock-cms/db/server", () => dbServerMocks);
vi.mock("server-only", () => ({}));
vi.mock("./email", () => emailMocks);
vi.mock("../../lib/auth/cms-actor", () => cmsActorMocks);

import {
  submitInteraction,
  toggleReaction,
  updateInteractionStatus,
  getNotificationEmails,
  saveNotificationEmails,
} from "./interactions";

const INTERACTION_ID = "44444444-4444-4444-4444-444444444444";

/**
 * A chainable PostgREST-style query stub: every builder method returns the same object,
 * `await`ing it (or calling single/maybeSingle) resolves to `result`.
 */
function makeQuery(result: unknown) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "gte", "is", "order", "limit", "insert", "update", "range"]) {
    q[method] = vi.fn(() => q);
  }
  q.single = vi.fn(() => Promise.resolve(result));
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function authedClient(userId: string | null, extra: Record<string, unknown> = {}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
    ...extra,
  };
}

/** Service-role client whose `from(table)` dispatches to a per-table query stub. */
function serviceClient(tables: Record<string, Record<string, any>>) {
  const from = vi.fn((table: string) => {
    const q = tables[table];
    if (!q) throw new Error(`unexpected service-role table ${table}`);
    return q;
  });
  return { from, client: { from } };
}

function pendingRows(count: number, ageMs: number) {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  return Array.from({ length: count }, () => ({ created_at: createdAt }));
}

describe("Interactions Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("submitInteraction", () => {
    const review = {
      type: "review" as const,
      content: "Awesome tool, works perfectly!",
      rating: 5,
      productId: "prod-1",
    };

    function arrange(opts: {
      pending?: { data: unknown; error: unknown };
      emails?: string;
    } = {}) {
      // `.insert()` with no `.select()`: a RETURNING clause is checked against the
      // approved-only SELECT policy and fails for a plain USER, so the action must not
      // ask for the row back. The stub has no `select` so a regression throws here.
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      const userFrom = vi.fn(() => ({ insert: insertMock }));
      dbServerMocks.createClient.mockReturnValue(authedClient("user-1", { from: userFrom }));

      const pendingQuery = makeQuery(opts.pending ?? { data: [], error: null });
      const settingsQuery = makeQuery({
        data: opts.emails ? { value: { emails: opts.emails } } : null,
        error: null,
      });
      const svc = serviceClient({ cms_interactions: pendingQuery, site_settings: settingsQuery });
      dbServerMocks.getServiceRoleSupabaseClient.mockReturnValue(svc.client);

      return { insertMock, userFrom, pendingQuery, serviceFrom: svc.from };
    }

    it("returns an error if the user is not logged in", async () => {
      dbServerMocks.createClient.mockReturnValue(authedClient(null));

      const res = await submitInteraction({
        type: "review",
        content: "Great product!",
        rating: 5,
        productId: "prod-1",
      });

      expect(res).toEqual({ error: "You must be logged in to submit a review or comment." });
      expect(dbServerMocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    it("inserts a new review successfully and triggers revalidation", async () => {
      const { insertMock, userFrom, pendingQuery } = arrange();

      const res = await submitInteraction(review);

      expect(res.success).toBe(true);
      expect(userFrom).toHaveBeenCalledWith("cms_interactions");
      expect(insertMock).toHaveBeenCalledWith({
        type: "review",
        status: "pending",
        content: "Awesome tool, works perfectly!",
        rating: 5,
        user_id: "user-1",
        product_id: "prod-1",
        post_id: null,
        reactions: {},
      });
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/cms/interactions");
      // The throttle counted THIS user's pending rows as the service role (a USER cannot
      // read their own pending rows under RLS).
      expect(pendingQuery.eq).toHaveBeenCalledWith("user_id", "user-1");
      expect(pendingQuery.eq).toHaveBeenCalledWith("status", "pending");
      expect(pendingQuery.limit).toHaveBeenCalledWith(50);
    });

    it("rejects a sixth pending submission inside the 10-minute window", async () => {
      const { insertMock } = arrange({
        pending: { data: pendingRows(5, 60_000), error: null },
      });

      const res = await submitInteraction(review);

      expect(res.success).toBeUndefined();
      expect(res.error).toMatch(/submitted several/i);
      // Generic on purpose: no limit, window or count is disclosed.
      expect(res.error).not.toMatch(/\d/);
      expect(insertMock).not.toHaveBeenCalled();
      expect(emailMocks.sendEmail).not.toHaveBeenCalled();
    });

    it("allows a submission when the recent pending rows are below the burst limit", async () => {
      const { insertMock } = arrange({
        pending: { data: pendingRows(4, 60_000), error: null },
      });

      const res = await submitInteraction(review);

      expect(res.success).toBe(true);
      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it("ignores old pending rows for the burst limit but enforces the 50-row backlog ceiling", async () => {
      const dayMs = 24 * 60 * 60_000;
      const { insertMock: insertBelowCeiling } = arrange({
        pending: { data: pendingRows(49, dayMs), error: null },
      });
      expect((await submitInteraction(review)).success).toBe(true);
      expect(insertBelowCeiling).toHaveBeenCalledTimes(1);

      const { insertMock: insertAtCeiling } = arrange({
        pending: { data: pendingRows(50, dayMs), error: null },
      });
      const res = await submitInteraction(review);
      expect(res.error).toMatch(/submitted several/i);
      expect(insertAtCeiling).not.toHaveBeenCalled();
    });

    it("fails closed when the pending count cannot be read", async () => {
      const { insertMock } = arrange({
        pending: { data: null, error: { message: "boom" } },
      });

      const res = await submitInteraction(review);

      expect(res.error).toBe("Could not submit right now. Please try again later.");
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("fails closed when the service-role client is unavailable", async () => {
      arrange();
      dbServerMocks.getServiceRoleSupabaseClient.mockImplementation(() => {
        throw new Error("Missing Supabase Service Role environment variables");
      });

      const res = await submitInteraction(review);

      expect(res.success).toBeUndefined();
      expect(res.error).toBeTruthy();
    });

    describe("moderator notification link", () => {
      const savedEnv = { ...process.env };

      afterEach(() => {
        process.env = { ...savedEnv };
      });

      it("points at the configured site URL, not the request host, and is attribute-safe", async () => {
        process.env.NEXT_PUBLIC_URL = "https://shop.example.com/";
        arrange({ emails: "mods@example.com" });

        const res = await submitInteraction({
          ...review,
          content: 'Nice product "><img src=x onerror=alert(1)>',
        });

        expect(res.success).toBe(true);
        expect(emailMocks.sendEmail).toHaveBeenCalledTimes(1);
        const message = emailMocks.sendEmail.mock.calls[0][0] as {
          to: string;
          html: string;
          text: string;
        };
        expect(message.to).toBe("mods@example.com");
        expect(message.html).toContain('href="https://shop.example.com/cms/interactions"');
        expect(message.text).toContain("Moderation Dashboard: https://shop.example.com/cms/interactions");
        expect(message.html).not.toContain("evil");
        // Visitor text is still escaped.
        expect(message.html).not.toContain("<img src=x");
        expect(message.html).toContain("&lt;img src=x");
      });

      it("falls back to the local default when no site URL is configured", async () => {
        delete process.env.NEXT_PUBLIC_URL;
        delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
        delete process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL;
        arrange({ emails: "mods@example.com" });

        await submitInteraction(review);

        const message = emailMocks.sendEmail.mock.calls[0][0] as { html: string };
        expect(message.html).toContain('href="http://localhost:3000/cms/interactions"');
      });
    });
  });

  describe("toggleReaction", () => {
    function arrange(opts: { user?: string | null; reactions?: unknown; cookie?: string } = {}) {
      const getCookieMock = vi.fn().mockReturnValue(opts.cookie ? { value: opts.cookie } : undefined);
      const setCookieMock = vi.fn();
      headersMocks.cookies.mockResolvedValue({ get: getCookieMock, set: setCookieMock } as any);

      dbServerMocks.createClient.mockReturnValue(authedClient(opts.user === undefined ? "user-1" : opts.user));

      const query = makeQuery({
        data: {
          reactions: opts.reactions ?? { likes: 3 },
          type: "review",
          product_id: "prod-1",
          post_id: null,
          products: { slug: "my-product" },
        },
        error: null,
      });
      const svc = serviceClient({ cms_interactions: query });
      dbServerMocks.getServiceRoleSupabaseClient.mockReturnValue(svc.client);

      return { query, serviceFrom: svc.from, setCookieMock };
    }

    it("toggles a reaction and updates cookies", async () => {
      const { query, setCookieMock } = arrange();

      const res = await toggleReaction(INTERACTION_ID);

      expect(res.success).toBe(true);
      expect(res.count).toBe(4);
      expect(res.hasReacted).toBe(true);
      expect(query.update).toHaveBeenCalledWith({ reactions: { likes: 4 } });
      expect(query.eq).toHaveBeenCalledWith("id", INTERACTION_ID);
      // Only published rows can be reacted to; the lookup bypasses RLS.
      expect(query.eq).toHaveBeenCalledWith("status", "approved");
      expect(setCookieMock).toHaveBeenCalledWith(
        "reacted_interactions",
        JSON.stringify([INTERACTION_ID]),
        expect.any(Object)
      );
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/product/my-product");
    });

    it("removes the reaction when the cookie says the user already reacted", async () => {
      const { query } = arrange({ cookie: JSON.stringify([INTERACTION_ID]) });

      const res = await toggleReaction(INTERACTION_ID);

      expect(res).toMatchObject({ success: true, count: 2, hasReacted: false });
      expect(query.update).toHaveBeenCalledWith({ reactions: { likes: 2 } });
    });

    it("rejects an unauthenticated caller without touching the row", async () => {
      const { serviceFrom } = arrange({ user: null });

      const res = await toggleReaction(INTERACTION_ID);

      expect(res).toEqual({ error: "You must be logged in to react." });
      expect(serviceFrom).not.toHaveBeenCalled();
      expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("rejects a malformed interaction id before any lookup", async () => {
      const { serviceFrom } = arrange();

      expect(await toggleReaction("int-1")).toEqual({ error: "Interaction ID is required." });
      expect(await toggleReaction("")).toEqual({ error: "Interaction ID is required." });
      expect(await toggleReaction(undefined as unknown as string)).toEqual({
        error: "Interaction ID is required.",
      });
      expect(serviceFrom).not.toHaveBeenCalled();
      expect(dbServerMocks.createClient).not.toHaveBeenCalled();
    });

    it("rejects a reaction type outside the allowlist", async () => {
      const { serviceFrom } = arrange();

      expect(await toggleReaction(INTERACTION_ID, "__proto__")).toEqual({ error: "Unsupported reaction." });
      expect(await toggleReaction(INTERACTION_ID, "hearts")).toEqual({ error: "Unsupported reaction." });
      expect(serviceFrom).not.toHaveBeenCalled();
    });

    it("clamps a malformed stored count so a toggle moves it by exactly one", async () => {
      const { query } = arrange({ reactions: { likes: -12.5 } });

      const res = await toggleReaction(INTERACTION_ID);

      expect(res).toMatchObject({ success: true, count: 1 });
      expect(query.update).toHaveBeenCalledWith({ reactions: { likes: 1 } });
    });

    it("never writes a negative count", async () => {
      const { query } = arrange({ reactions: { likes: 0 }, cookie: JSON.stringify([INTERACTION_ID]) });

      const res = await toggleReaction(INTERACTION_ID);

      expect(res).toMatchObject({ success: true, count: 0 });
      expect(query.update).toHaveBeenCalledWith({ reactions: { likes: 0 } });
    });

    it("returns not found when the row is not approved", async () => {
      const { query } = arrange();
      query.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });

      const res = await toggleReaction(INTERACTION_ID);

      expect(res).toEqual({ error: "Interaction not found." });
      expect(query.update).not.toHaveBeenCalled();
    });
  });

  describe("updateInteractionStatus", () => {
    it("returns error if non-admin attempts moderation", async () => {
      dbServerMocks.createClient.mockReturnValue(authedClient("user-1"));
      dbServerMocks.getProfileWithRoleServerSide.mockResolvedValue({
        role: "WRITER",
      } as any);

      const res = await updateInteractionStatus("int-1", "approved");
      expect(res.error).toContain("Unauthorized");
    });

    it("allows admins to approve and triggers path revalidation", async () => {
      dbServerMocks.createClient.mockReturnValue(authedClient("admin-1"));
      dbServerMocks.getProfileWithRoleServerSide.mockResolvedValue({
        role: "ADMIN",
      } as any);

      const singleMock = vi.fn().mockResolvedValue({
        data: {
          product_id: "prod-1",
          post_id: null,
          products: { slug: "my-product" },
        },
        error: null,
      });
      const eqSelectMock = vi.fn().mockReturnValue({ single: singleMock });
      const selectMock = vi.fn().mockReturnValue({ eq: eqSelectMock });
      const eqUpdateMock = vi.fn().mockResolvedValue({ error: null });
      const updateMock = vi.fn().mockReturnValue({ eq: eqUpdateMock });
      const fromMock = vi.fn().mockReturnValue({
        select: selectMock,
        update: updateMock,
      });

      dbServerMocks.getServiceRoleSupabaseClient.mockReturnValue({
        from: fromMock,
      });

      const res = await updateInteractionStatus("int-1", "approved");

      expect(res.success).toBe(true);
      expect(updateMock).toHaveBeenCalledWith({ status: "approved" });
      expect(eqUpdateMock).toHaveBeenCalledWith("id", "int-1");
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/product/my-product");
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/cms/interactions");
    });
  });

  describe("Notification Emails Settings Actions", () => {
    it("returns error if non-admin attempts to get or save configuration", async () => {
      cmsActorMocks.requireCmsAdmin.mockRejectedValue(new Error("Forbidden"));

      const getRes = await getNotificationEmails();
      expect(getRes.error).toContain("Unauthorized");

      const saveRes = await saveNotificationEmails("test@example.com");
      expect(saveRes.error).toContain("Unauthorized");
    });

    it("refuses a caller without a session (or with a pending second factor)", async () => {
      cmsActorMocks.requireCmsAdmin.mockRejectedValue(new Error("Unauthorized"));

      expect((await getNotificationEmails()).error).toBe("Not authenticated");
      expect((await saveNotificationEmails("test@example.com")).error).toBe("Not authenticated");
    });

    it("allows admins to get configuration through the service-role client", async () => {
      const maybeSingleMock = vi.fn().mockResolvedValue({
        data: { value: { emails: "a@b.com, c@d.com" } },
        error: null,
      });
      const eqMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
      const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
      const fromMock = vi.fn().mockReturnValue({ select: selectMock });
      cmsActorMocks.requireCmsAdmin.mockResolvedValue({ supabase: { from: fromMock }, userId: "admin-1" });

      const res = await getNotificationEmails();
      expect(res.success).toBe(true);
      expect(res.emails).toBe("a@b.com, c@d.com");
      expect(fromMock).toHaveBeenCalledWith("site_settings");
      expect(dbServerMocks.createClient).not.toHaveBeenCalled();
    });

    it("allows admins to save configuration through the service-role client", async () => {
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      const fromMock = vi.fn().mockReturnValue({ upsert: upsertMock });
      cmsActorMocks.requireCmsAdmin.mockResolvedValue({ supabase: { from: fromMock }, userId: "admin-1" });

      const res = await saveNotificationEmails(" a@b.com , c@d.com ");
      expect(res.success).toBe(true);
      expect(res.emails).toBe("a@b.com, c@d.com");
      expect(upsertMock).toHaveBeenCalledWith({
        key: "interactions_notification_emails",
        value: { emails: "a@b.com, c@d.com" },
      });
      expect(dbServerMocks.createClient).not.toHaveBeenCalled();
    });
  });
});
