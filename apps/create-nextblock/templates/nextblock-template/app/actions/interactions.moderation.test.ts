import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staff answer and moderation actions of app/actions/interactions.ts: replyToInteraction
 * (publishes an approved reply) and updateInteractionStatus (publishes or hides a review). Both
 * write cms_interactions with the service role, and a server action never passes the CMS layout's
 * 2FA redirect. Until 2026-11-13 they read the role through the cookie client
 * (getProfileWithRoleServerSide), so an ADMIN password alone (the first factor) published replies
 * and moderated. They now resolve getCmsActor(), and this file runs the real one, with
 * evaluateTwoFactor() behind it, against a faked cookie session (as
 * app/actions/package-actions.test.ts does): an enrolled factor not verified this session (aal1, or
 * no email-code cookie) is refused with nothing written, exactly like no session and the wrong role.
 * Who may act is unchanged: replies and moderation stay ADMIN-only.
 */

const PARENT_ID = "44444444-4444-4444-4444-444444444444";

type Write =
  | { op: "insert"; row: Record<string, unknown> }
  | { op: "update"; patch: Record<string, unknown>; filter: [string, unknown] };

const mocks = vi.hoisted(() => ({
  user: { id: "admin-1" } as { id: string } | null,
  role: "ADMIN" as string | null,
  /** The caller's `user_security_settings` row: the second factor they enrolled, if any. */
  mfa: null as { mfa_enabled: boolean; mfa_type: "totp" | "email" } | null,
  /** The assurance level of this session (a TOTP factor is verified at aal2). */
  aal: "aal1" as "aal1" | "aal2",
  interactions: [] as Array<Record<string, unknown>>,
  writes: [] as Array<Record<string, unknown>>,
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  revalidatePath: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@nextblock-cms/db/server", () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The pre-2026-11-13 role read: the caller's own profile through the cookie client, no second
  // factor. Kept so a return to it is judged by the refusals below, not by a missing export.
  getProfileWithRoleServerSide: async () => (mocks.role ? { role: mocks.role } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, unstable_cache: (fn: unknown) => fn }));
// No trusted-device or email-code cookie: the second factor counts only through the session itself.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("./email", () => ({ sendEmail: mocks.sendEmail }));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock("../../lib/privacy/settings", () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import { replyToInteraction, updateInteractionStatus } from "./interactions";

/** The service-role client: cms_interactions reads by id, and every insert and update it is asked for. */
function fakeServiceClient() {
  return {
    from: (table: string) => {
      if (table !== "cms_interactions") throw new Error(`Unexpected service-role table ${table}`);
      return {
        select: () => ({
          eq: (_column: string, id: unknown) => ({
            single: async () => {
              const row = mocks.interactions.find((candidate) => candidate.id === id) ?? null;
              return row ? { data: row, error: null } : { data: null, error: { code: "PGRST116" } };
            },
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          mocks.writes.push({ op: "insert", row } satisfies Write);
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (column: string, value: unknown) => {
            mocks.writes.push({ op: "update", patch, filter: [column, value] } satisfies Write);
            return { error: null };
          },
        }),
      };
    },
  };
}

/** The cookie session: the signed-in user, their own profile role and second factor, the session's assurance level. */
function fakeCookieClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: mocks.aal, nextLevel: "aal2" }, error: null }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === "profiles") return { data: mocks.role ? { role: mocks.role } : null, error: null };
            if (table === "user_security_settings") return { data: mocks.mfa, error: null };
            throw new Error(`Unexpected cookie-client read of ${table}`);
          },
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_IS_SANDBOX", "");
  mocks.user = { id: "admin-1" };
  mocks.role = "ADMIN";
  mocks.mfa = null;
  mocks.aal = "aal1";
  mocks.interactions = [
    { id: PARENT_ID, product_id: "prod-1", post_id: null, parent_id: null, products: { slug: "my-product" }, posts: null },
  ];
  mocks.writes = [];
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => fakeServiceClient());
  mocks.revalidatePath.mockReset();
  mocks.sendEmail.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SECOND_FACTOR = "Complete two-factor verification, then try again.";

/** Callers each action refuses, and how it words the refusal: [label, arrange, reply message, status message]. */
const REFUSED_CALLERS: ReadonlyArray<readonly [string, () => void, string, string]> = [
  ["a caller with no session", () => {
    mocks.user = null;
    mocks.role = null;
  }, "Not authenticated", "Not authenticated"],
  ["a signed-in customer (USER)", () => {
    mocks.role = "USER";
  }, "Unauthorized. Admin permissions required to reply.", "Unauthorized. Admin or Writer permissions required."],
  ["a WRITER", () => {
    mocks.role = "WRITER";
  }, "Unauthorized. Admin permissions required to reply.", "Unauthorized. Admin permissions required to moderate."],
  ["an ADMIN whose enrolled authenticator app this session has not passed (aal1)", () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: "totp" };
    mocks.aal = "aal1";
  }, SECOND_FACTOR, SECOND_FACTOR],
  ["an ADMIN whose enrolled email code this session has not passed", () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: "email" };
  }, SECOND_FACTOR, SECOND_FACTOR],
];

/** Nothing reached cms_interactions: no service-role client, no write, no revalidation, no mail. */
function expectNothingWritten() {
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  expect(mocks.writes).toEqual([]);
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
  expect(mocks.sendEmail).not.toHaveBeenCalled();
}

describe("replyToInteraction authorizes through getCmsActor()", () => {
  it.each(REFUSED_CALLERS)("refuses %s with nothing written", async (_label, arrange, message) => {
    arrange();

    expect(await replyToInteraction(PARENT_ID, "Thanks for the review!")).toEqual({ error: message });
    expectNothingWritten();
  });

  const expectReplyPublished = () => {
    expect(mocks.writes).toEqual([
      {
        op: "insert",
        row: {
          type: "comment",
          status: "approved",
          content: "Thanks for the review!",
          rating: null,
          user_id: "admin-1",
          parent_id: PARENT_ID,
          product_id: "prod-1",
          post_id: null,
        },
      },
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/product/my-product");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/cms/messages");
  };

  it("publishes the reply for an ADMIN whose session passed the enrolled second factor (aal2)", async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: "totp" };
    mocks.aal = "aal2";

    expect(await replyToInteraction(PARENT_ID, "  Thanks for the review!  ")).toEqual({ success: true });
    expectReplyPublished();
  });

  it("publishes the reply for an ADMIN who enrolled no second factor", async () => {
    expect(await replyToInteraction(PARENT_ID, "Thanks for the review!")).toEqual({ success: true });
    expectReplyPublished();
  });
});

describe("updateInteractionStatus authorizes through getCmsActor()", () => {
  it.each(REFUSED_CALLERS)("refuses %s with nothing written", async (_label, arrange, _replyMessage, message) => {
    arrange();

    expect(await updateInteractionStatus(PARENT_ID, "approved")).toEqual({ error: message });
    expectNothingWritten();
  });

  const expectApproved = () => {
    expect(mocks.writes).toEqual([{ op: "update", patch: { status: "approved" }, filter: ["id", PARENT_ID] }]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/product/my-product");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/cms/interactions");
  };

  it("approves for an ADMIN whose session passed the enrolled second factor (aal2)", async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: "totp" };
    mocks.aal = "aal2";

    expect(await updateInteractionStatus(PARENT_ID, "approved")).toEqual({ success: true });
    expectApproved();
  });

  it("approves for an ADMIN who enrolled no second factor", async () => {
    expect(await updateInteractionStatus(PARENT_ID, "approved")).toEqual({ success: true });
    expectApproved();
  });

  it("reports a missing interaction without writing", async () => {
    expect(await updateInteractionStatus("55555555-5555-4555-8555-555555555555", "denied")).toEqual({
      error: "Interaction not found.",
    });
    expect(mocks.writes).toEqual([]);
  });
});
