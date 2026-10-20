import type { Json } from "@nextblock-cms/db";

export const FULL_BACKUP_ARCHIVE_TYPE = "nextblock-full-site-backup";
export const FULL_BACKUP_VERSION = 1;
export const FULL_BACKUP_CONFIRMATION = "RESTORE FULL BACKUP";
export const FULL_BACKUP_MANIFEST_PATH = "manifest.json";
export const FULL_BACKUP_DATABASE_PATH = "database/dump.sql";
export const FULL_BACKUP_CONTENT_PATH = "content/nextblock-content-backup.json";
export const FULL_BACKUP_STORAGE_PREFIX = "storage/objects/";
export const FULL_BACKUP_USERS_PATH = "users/auth-users.json";
export const FULL_BACKUP_USERS_TYPE = "nextblock-auth-users-v1";

export type FullBackupMediaUrlMode = "rewrite_to_destination" | "keep_exact_urls";

/**
 * One `auth.users` account as exported for migration. `password_hash` is the ORIGINAL bcrypt
 * hash, replayed through the GoTrue admin API on restore so the original password keeps
 * working; nothing here is a session, token or TOTP secret.
 */
export interface FullBackupUserRecord {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  email_confirmed: boolean;
  phone_confirmed: boolean;
  user_metadata: Record<string, unknown>;
  created_at: string | null;
  last_sign_in_at: string | null;
  banned_until: string | null;
  /** Identity providers on the source (`email`, `google`, …); only `email`/`phone` cross over. */
  providers: string[];
  /** The account had a verified authenticator app on the source; it must be re-enrolled. */
  has_totp: boolean;
  is_sso_user: boolean;
  is_anonymous: boolean;
}

export interface FullBackupUsersBundleV1 {
  type: typeof FULL_BACKUP_USERS_TYPE;
  version: 1;
  exported_at: string;
  users: FullBackupUserRecord[];
}

export interface FullBackupStorageObjectManifest {
  key: string;
  archive_path: string;
  size: number | null;
  etag: string | null;
  content_type: string | null;
  last_modified: string | null;
}

export interface FullBackupManifestV1 {
  type: typeof FULL_BACKUP_ARCHIVE_TYPE;
  version: typeof FULL_BACKUP_VERSION;
  exported_at: string;
  app: {
    name: string;
    version: string | null;
  };
  database: {
    path: typeof FULL_BACKUP_DATABASE_PATH;
    created_with: "pg_dump";
  };
  content: {
    path: typeof FULL_BACKUP_CONTENT_PATH;
    type: "nextblock-content-backup-v1";
  };
  storage: {
    bucket: string | null;
    source_base_url: string | null;
    public_url: string | null;
    objects: FullBackupStorageObjectManifest[];
  };
  /** Absent (null) in archives exported before accounts were included. */
  users: {
    path: typeof FULL_BACKUP_USERS_PATH;
    count: number;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Modular-crypt hashes as GoTrue stores them (bcrypt `$2a$…`, argon2 `$argon2id$…`, scrypt):
 * the alphabet excludes quotes and whitespace, which is what lets the restore embed a hash in
 * SQL without escaping.
 */
export const PASSWORD_HASH_PATTERN = /^\$[A-Za-z0-9./+=$,-]{20,}$/;

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseFullBackupUsersBundle(content: string): FullBackupUsersBundleV1 {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || parsed.type !== FULL_BACKUP_USERS_TYPE || parsed.version !== 1) {
    throw new Error("Backup archive user bundle must be a NextBlock auth users bundle version 1.");
  }
  if (!Array.isArray(parsed.users)) {
    throw new Error("Backup archive user bundle is missing its users list.");
  }

  const users = parsed.users.map((item, index): FullBackupUserRecord => {
    if (!isRecord(item)) {
      throw new Error(`User bundle entry ${index + 1} must be an object.`);
    }
    const id = typeof item.id === "string" ? item.id.toLowerCase() : "";
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`User bundle entry ${index + 1} has an invalid account id.`);
    }
    const passwordHash = optionalString(item.password_hash);
    if (passwordHash && !PASSWORD_HASH_PATTERN.test(passwordHash)) {
      throw new Error(`User bundle entry ${index + 1} has an unrecognised password hash.`);
    }

    return {
      id,
      email: optionalString(item.email),
      phone: optionalString(item.phone),
      password_hash: passwordHash,
      email_confirmed: item.email_confirmed === true,
      phone_confirmed: item.phone_confirmed === true,
      user_metadata: isRecord(item.user_metadata) ? item.user_metadata : {},
      created_at: optionalString(item.created_at),
      last_sign_in_at: optionalString(item.last_sign_in_at),
      banned_until: optionalString(item.banned_until),
      providers: Array.isArray(item.providers)
        ? item.providers.filter((provider): provider is string => typeof provider === "string")
        : [],
      has_totp: item.has_totp === true,
      is_sso_user: item.is_sso_user === true,
      is_anonymous: item.is_anonymous === true,
    };
  });

  return {
    type: FULL_BACKUP_USERS_TYPE,
    version: 1,
    exported_at: typeof parsed.exported_at === "string" ? parsed.exported_at : "",
    users,
  };
}

export function normalizeMediaBaseUrl(value?: string | null) {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}

export function encodeObjectKeyForArchive(objectKey: string) {
  const normalized = objectKey.trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("R2 object key is required.");
  }
  if (normalized.includes("\0")) {
    throw new Error("R2 object key contains an invalid null byte.");
  }

  return Buffer.from(normalized, "utf8").toString("base64url");
}

export function decodeObjectKeyFromArchive(encoded: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Archive object path is not a valid encoded object key.");
  }

  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (!decoded || decoded.includes("\0") || decoded.startsWith("/") || decoded.includes("..")) {
    throw new Error("Archive object path decodes to an unsafe object key.");
  }

  return decoded;
}

export function archivePathForObjectKey(objectKey: string) {
  return `${FULL_BACKUP_STORAGE_PREFIX}${encodeObjectKeyForArchive(objectKey)}`;
}

export function objectKeyFromArchivePath(archivePath: string) {
  if (!archivePath.startsWith(FULL_BACKUP_STORAGE_PREFIX)) {
    throw new Error("Archive object path must be inside storage/objects.");
  }

  const encoded = archivePath.slice(FULL_BACKUP_STORAGE_PREFIX.length);
  if (!encoded || encoded.includes("/")) {
    throw new Error("Archive object path has an invalid encoded object key.");
  }

  return decodeObjectKeyFromArchive(encoded);
}

export function isValidFullBackupConfirmation(value: string) {
  return value.trim() === FULL_BACKUP_CONFIRMATION;
}

export function parseFullBackupManifest(content: string): FullBackupManifestV1 {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Full backup manifest must be a JSON object.");
  }
  if (parsed.type !== FULL_BACKUP_ARCHIVE_TYPE || parsed.version !== FULL_BACKUP_VERSION) {
    throw new Error("Backup archive must be a NextBlock full site backup version 1.");
  }
  if (!isRecord(parsed.database) || parsed.database.path !== FULL_BACKUP_DATABASE_PATH) {
    throw new Error("Backup archive is missing its database dump entry.");
  }
  if (!isRecord(parsed.content) || parsed.content.path !== FULL_BACKUP_CONTENT_PATH) {
    throw new Error("Backup archive is missing its content bundle entry.");
  }
  if (!isRecord(parsed.storage) || !Array.isArray(parsed.storage.objects)) {
    throw new Error("Backup archive is missing its storage manifest.");
  }

  const objects = parsed.storage.objects.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Storage manifest entry ${index + 1} must be an object.`);
    }
    const key = typeof item.key === "string" ? item.key : "";
    const archivePath = typeof item.archive_path === "string" ? item.archive_path : "";
    if (!key || !archivePath) {
      throw new Error(`Storage manifest entry ${index + 1} is missing its key or archive path.`);
    }
    if (objectKeyFromArchivePath(archivePath) !== key.replace(/^\/+/, "")) {
      throw new Error(`Storage manifest entry ${index + 1} has a mismatched archive path.`);
    }

    return {
      key: key.replace(/^\/+/, ""),
      archive_path: archivePath,
      size: typeof item.size === "number" ? item.size : null,
      etag: typeof item.etag === "string" ? item.etag : null,
      content_type: typeof item.content_type === "string" ? item.content_type : null,
      last_modified: typeof item.last_modified === "string" ? item.last_modified : null,
    };
  });

  return {
    type: FULL_BACKUP_ARCHIVE_TYPE,
    version: FULL_BACKUP_VERSION,
    exported_at: typeof parsed.exported_at === "string" ? parsed.exported_at : "",
    app: {
      name: isRecord(parsed.app) && typeof parsed.app.name === "string" ? parsed.app.name : "nextblock",
      version: isRecord(parsed.app) && typeof parsed.app.version === "string" ? parsed.app.version : null,
    },
    database: {
      path: FULL_BACKUP_DATABASE_PATH,
      created_with: "pg_dump",
    },
    content: {
      path: FULL_BACKUP_CONTENT_PATH,
      type: "nextblock-content-backup-v1",
    },
    storage: {
      bucket: typeof parsed.storage.bucket === "string" ? parsed.storage.bucket : null,
      source_base_url:
        typeof parsed.storage.source_base_url === "string" ? parsed.storage.source_base_url : null,
      public_url: typeof parsed.storage.public_url === "string" ? parsed.storage.public_url : null,
      objects,
    },
    users:
      isRecord(parsed.users) && parsed.users.path === FULL_BACKUP_USERS_PATH
        ? {
            path: FULL_BACKUP_USERS_PATH,
            count: typeof parsed.users.count === "number" ? parsed.users.count : 0,
          }
        : null,
  };
}

export function replaceMediaBaseUrlInString(value: string, sourceBaseUrl: string, destinationBaseUrl: string) {
  const source = normalizeMediaBaseUrl(sourceBaseUrl);
  const destination = normalizeMediaBaseUrl(destinationBaseUrl);
  if (!source || !destination || source === destination || !value.includes(source)) {
    return value;
  }

  return value.split(source).join(destination);
}

export function replaceMediaBaseUrlInJson(
  value: Json | null,
  sourceBaseUrl: string,
  destinationBaseUrl: string
): Json | null {
  if (value === null) return null;

  if (typeof value === "string") {
    return replaceMediaBaseUrlInString(value, sourceBaseUrl, destinationBaseUrl);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceMediaBaseUrlInJson(item as Json, sourceBaseUrl, destinationBaseUrl)) as Json;
  }

  if (isRecord(value)) {
    const rewritten: Record<string, Json | null> = {};
    for (const [key, item] of Object.entries(value)) {
      rewritten[key] = replaceMediaBaseUrlInJson(item as Json, sourceBaseUrl, destinationBaseUrl);
    }
    return rewritten as Json;
  }

  return value;
}
