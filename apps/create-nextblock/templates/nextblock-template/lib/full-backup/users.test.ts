import { describe, expect, it } from "vitest";

import type { FullBackupUserRecord } from "./manifest";
import { banDurationFor, buildPasswordHashRestoreSql, describeUsers, planUserRestore, toAdminUserPayload } from "./users";

function user(overrides: Partial<FullBackupUserRecord> & { id: string }): FullBackupUserRecord {
  return {
    email: `${overrides.id.slice(0, 8)}@example.com`,
    phone: null,
    password_hash: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ",
    email_confirmed: true,
    phone_confirmed: false,
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    last_sign_in_at: null,
    banned_until: null,
    providers: ["email"],
    has_totp: false,
    is_sso_user: false,
    is_anonymous: false,
    ...overrides,
  };
}

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const WRITER = "33333333-3333-4333-8333-333333333333";
const LOCAL_ONLY = "44444444-4444-4444-8444-444444444444";
const COLLIDER = "55555555-5555-4555-8555-555555555555";

describe("planUserRestore", () => {
  it("creates missing accounts, updates matching ids, and removes the rest after the restore", () => {
    const plan = planUserRestore(
      [user({ id: ADMIN, email: "admin@example.com" }), user({ id: CUSTOMER, email: "customer@example.com" })],
      [
        { id: ADMIN, email: "admin@example.com" },
        { id: LOCAL_ONLY, email: "installer@example.com" },
      ]
    );

    expect(plan.update.map((entry) => entry.id)).toEqual([ADMIN]);
    expect(plan.create.map((entry) => entry.id)).toEqual([CUSTOMER]);
    expect(plan.deleteBeforeRestore).toEqual([]);
    expect(plan.deleteAfterRestore).toEqual([{ id: LOCAL_ONLY, email: "installer@example.com" }]);
    expect(plan.skipped).toEqual([]);
  });

  it("removes an account that holds a backup email under another id before recreating it", () => {
    const plan = planUserRestore(
      [user({ id: ADMIN, email: "Admin@Example.com" })],
      [{ id: COLLIDER, email: "admin@example.com" }]
    );

    expect(plan.deleteBeforeRestore).toEqual([{ id: COLLIDER, email: "admin@example.com" }]);
    expect(plan.deleteAfterRestore).toEqual([]);
    expect(plan.create.map((entry) => entry.id)).toEqual([ADMIN]);
  });

  it("skips what the admin API cannot recreate and never deletes for a skipped account", () => {
    const plan = planUserRestore(
      [
        user({ id: ADMIN }),
        user({ id: CUSTOMER, is_sso_user: true }),
        user({ id: WRITER, is_anonymous: true, email: null }),
        user({ id: LOCAL_ONLY, email: null, phone: null }),
        user({ id: ADMIN }),
      ],
      [{ id: CUSTOMER, email: "sso@example.com" }]
    );

    expect(plan.create.map((entry) => entry.id)).toEqual([ADMIN]);
    expect(plan.skipped.map((entry) => entry.user.id)).toEqual([CUSTOMER, WRITER, LOCAL_ONLY, ADMIN]);
    expect(plan.skipped.map((entry) => entry.reason)).toEqual([
      "SSO accounts cannot be recreated through the admin API",
      "anonymous accounts cannot be recreated through the admin API",
      "the account has neither an email nor a phone number",
      "duplicate id in the backup",
    ]);
    // The SSO account exists on the target under the same id but is not restorable, so it is
    // treated like any other target-only account.
    expect(plan.deleteAfterRestore.map((entry) => entry.id)).toEqual([CUSTOMER]);
  });

  it("keeps a phone-only account", () => {
    const plan = planUserRestore([user({ id: ADMIN, email: null, phone: "+15145550100" })], []);

    expect(plan.create.map((entry) => entry.id)).toEqual([ADMIN]);
  });
});

describe("toAdminUserPayload", () => {
  it("carries the original password hash and confirmation state", () => {
    const payload = toAdminUserPayload(
      user({
        id: ADMIN,
        email: "Admin@Example.com",
        phone: " +15145550100 ",
        phone_confirmed: true,
        user_metadata: { full_name: "Site Admin" },
      })
    );

    expect(payload).toEqual({
      email: "admin@example.com",
      email_confirm: true,
      phone: "+15145550100",
      phone_confirm: true,
      password_hash: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ",
      user_metadata: { full_name: "Site Admin" },
    });
  });

  it("omits the hash for a password-less account and keeps an unconfirmed email unconfirmed", () => {
    const payload = toAdminUserPayload(user({ id: ADMIN, password_hash: null, email_confirmed: false }));

    expect(payload.password_hash).toBeUndefined();
    expect(payload.email_confirm).toBe(false);
    expect(payload.phone).toBeUndefined();
  });

  it("translates a future ban into a GoTrue duration and ignores an expired one", () => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");

    expect(banDurationFor("2026-10-21T12:00:00.000Z", now)).toBe("24h");
    expect(banDurationFor("2026-10-20T12:00:01.000Z", now)).toBe("1h");
    expect(banDurationFor("2026-10-19T12:00:00.000Z", now)).toBeUndefined();
    expect(banDurationFor("not a date", now)).toBeUndefined();
    expect(toAdminUserPayload(user({ id: ADMIN, banned_until: "2026-10-21T12:00:00.000Z" }), now).ban_duration).toBe("24h");
  });
});

describe("buildPasswordHashRestoreSql", () => {
  it("pins each account with a hash and skips password-less ones", () => {
    const sql = buildPasswordHashRestoreSql([
      user({ id: ADMIN, password_hash: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ" }),
      user({ id: CUSTOMER, password_hash: null }),
    ]);

    expect(sql).toContain(
      `UPDATE auth.users SET encrypted_password = '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ', updated_at = pg_catalog.now() WHERE id = '${ADMIN}' AND encrypted_password IS DISTINCT FROM`
    );
    expect(sql).not.toContain(CUSTOMER);
    expect(buildPasswordHashRestoreSql([user({ id: CUSTOMER, password_hash: null })])).toBe("");
  });

  it("refuses values that could not be embedded safely", () => {
    expect(() => buildPasswordHashRestoreSql([user({ id: ADMIN, password_hash: "$2a$10$abc'; DROP TABLE x; --" })])).toThrow(
      "unrecognised password hash"
    );
    expect(() => buildPasswordHashRestoreSql([user({ id: "not-a-uuid", password_hash: "$2a$10$abcdefghijklmnopqrstuvwxyz" })])).toThrow(
      "not a valid UUID"
    );
  });
});

describe("describeUsers", () => {
  it("lists a few emails and counts the rest", () => {
    const users = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `id-${n}`, email: n === 7 ? null : `u${n}@example.com` }));

    expect(describeUsers(users.slice(0, 2))).toBe("u1@example.com, u2@example.com");
    expect(describeUsers(users)).toBe("u1@example.com, u2@example.com, u3@example.com, u4@example.com, u5@example.com and 2 more");
    expect(describeUsers(users.slice(6))).toBe("id-7");
  });
});
