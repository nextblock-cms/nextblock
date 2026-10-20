/**
 * Pure planning helpers for migrating accounts with a full backup.
 *
 * Accounts are recreated through the GoTrue admin API (`POST /admin/users` honours an explicit
 * `id` and a `password_hash`), never by writing `auth.*` rows: that keeps the restore valid across
 * GoTrue versions and keeps every account's ORIGINAL bcrypt hash, so whoever restores a backup
 * still needs the original passwords afterwards. What cannot cross: authenticator-app (TOTP)
 * secrets, social-login identities, SSO and anonymous accounts.
 */
import { PASSWORD_HASH_PATTERN, type FullBackupUserRecord } from "./manifest";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TargetAuthUser {
  id: string;
  email: string | null;
}

export interface SkippedUser {
  user: FullBackupUserRecord;
  reason: string;
}

export interface UserRestorePlan {
  /** Backup accounts whose id does not exist on this project yet. */
  create: FullBackupUserRecord[];
  /** Backup accounts whose id already exists here (same project, or a previous restore). */
  update: FullBackupUserRecord[];
  /** Accounts on this project that hold an email a backup account needs under a different id. */
  deleteBeforeRestore: TargetAuthUser[];
  /** Every other account on this project that is not in the backup. */
  deleteAfterRestore: TargetAuthUser[];
  skipped: SkippedUser[];
}

export function normalizeEmail(value: string | null | undefined) {
  const trimmed = (value || "").trim().toLowerCase();
  return trimmed || null;
}

export function planUserRestore(
  backupUsers: FullBackupUserRecord[],
  targetUsers: TargetAuthUser[]
): UserRestorePlan {
  const plan: UserRestorePlan = {
    create: [],
    update: [],
    deleteBeforeRestore: [],
    deleteAfterRestore: [],
    skipped: [],
  };

  const restorable: FullBackupUserRecord[] = [];
  const seenIds = new Set<string>();
  for (const user of backupUsers) {
    if (seenIds.has(user.id)) {
      plan.skipped.push({ user, reason: "duplicate id in the backup" });
      continue;
    }
    seenIds.add(user.id);

    if (user.is_sso_user) {
      plan.skipped.push({ user, reason: "SSO accounts cannot be recreated through the admin API" });
      continue;
    }
    if (user.is_anonymous) {
      plan.skipped.push({ user, reason: "anonymous accounts cannot be recreated through the admin API" });
      continue;
    }
    if (!normalizeEmail(user.email) && !(user.phone || "").trim()) {
      plan.skipped.push({ user, reason: "the account has neither an email nor a phone number" });
      continue;
    }
    restorable.push(user);
  }

  const backupIds = new Set(restorable.map((user) => user.id));
  const backupEmails = new Set(
    restorable.map((user) => normalizeEmail(user.email)).filter((email): email is string => Boolean(email))
  );
  const targetById = new Map(targetUsers.map((user) => [user.id, user]));

  for (const user of restorable) {
    if (targetById.has(user.id)) {
      plan.update.push(user);
    } else {
      plan.create.push(user);
    }
  }

  for (const target of targetUsers) {
    if (backupIds.has(target.id)) continue;
    const email = normalizeEmail(target.email);
    if (email && backupEmails.has(email)) {
      plan.deleteBeforeRestore.push(target);
    } else {
      plan.deleteAfterRestore.push(target);
    }
  }

  return plan;
}

/** GoTrue bans with a Go duration string; express "banned until T" as hours from now. */
export function banDurationFor(bannedUntil: string | null, now = Date.now()) {
  if (!bannedUntil) return undefined;
  const until = Date.parse(bannedUntil);
  if (Number.isNaN(until) || until <= now) return undefined;
  const hours = Math.ceil((until - now) / 3_600_000);
  return `${hours}h`;
}

export interface AdminUserPayload {
  email?: string;
  phone?: string;
  password_hash?: string;
  email_confirm?: boolean;
  phone_confirm?: boolean;
  user_metadata: Record<string, unknown>;
  ban_duration?: string;
}

export function toAdminUserPayload(user: FullBackupUserRecord, now = Date.now()): AdminUserPayload {
  const email = normalizeEmail(user.email);
  const phone = (user.phone || "").trim();
  const payload: AdminUserPayload = {
    user_metadata: user.user_metadata || {},
  };

  if (email) {
    payload.email = email;
    payload.email_confirm = user.email_confirmed;
  }
  if (phone) {
    payload.phone = phone;
    payload.phone_confirm = user.phone_confirmed;
  }
  if (user.password_hash) {
    payload.password_hash = user.password_hash;
  }

  const banDuration = banDurationFor(user.banned_until, now);
  if (banDuration) payload.ban_duration = banDuration;

  return payload;
}

/**
 * SQL that pins every restored account to its ORIGINAL password hash, run inside the restore
 * transaction. `POST /admin/users` honours `password_hash`, but `PUT /admin/users/{id}` ignores
 * it (GoTrue v2.189), so an account that already existed on this site would otherwise keep
 * whatever password it had here. `encrypted_password` has existed in every GoTrue release and
 * the restoring role holds UPDATE on `auth.users`. Values are embedded verbatim: ids and hashes
 * were validated against alphabets that cannot contain a quote.
 */
export function buildPasswordHashRestoreSql(users: FullBackupUserRecord[]) {
  const statements: string[] = [];
  for (const user of users) {
    if (!user.password_hash) continue;
    if (!UUID_PATTERN.test(user.id)) {
      throw new Error(`Account id ${user.id} is not a valid UUID.`);
    }
    if (!PASSWORD_HASH_PATTERN.test(user.password_hash)) {
      throw new Error(`Account ${user.email || user.id} has an unrecognised password hash.`);
    }
    statements.push(
      `UPDATE auth.users SET encrypted_password = '${user.password_hash}', updated_at = pg_catalog.now() WHERE id = '${user.id}' AND encrypted_password IS DISTINCT FROM '${user.password_hash}';`
    );
  }
  if (statements.length === 0) return "";
  return ["-- NextBlock full restore: pin restored accounts to their original password hashes.", ...statements, ""].join("\n");
}

/** Summary lines for the restore result; emails are listed only up to `limit` to keep it short. */
export function describeUsers(users: Array<{ email: string | null; id: string }>, limit = 5) {
  const labels = users.map((user) => user.email || user.id);
  if (labels.length <= limit) return labels.join(", ");
  return `${labels.slice(0, limit).join(", ")} and ${labels.length - limit} more`;
}
