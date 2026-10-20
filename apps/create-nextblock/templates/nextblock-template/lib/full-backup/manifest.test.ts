import { describe, expect, it } from "vitest";

import {
  FULL_BACKUP_ARCHIVE_TYPE,
  FULL_BACKUP_CONFIRMATION,
  FULL_BACKUP_CONTENT_PATH,
  FULL_BACKUP_DATABASE_PATH,
  FULL_BACKUP_STORAGE_PREFIX,
  FULL_BACKUP_USERS_PATH,
  FULL_BACKUP_USERS_TYPE,
  archivePathForObjectKey,
  isValidFullBackupConfirmation,
  objectKeyFromArchivePath,
  parseFullBackupManifest,
  parseFullBackupUsersBundle,
  replaceMediaBaseUrlInJson,
  replaceMediaBaseUrlInString,
} from "./manifest";

function buildManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: FULL_BACKUP_ARCHIVE_TYPE,
    version: 1,
    exported_at: "2026-05-27T00:00:00.000Z",
    app: {
      name: "nextblock",
      version: "0.3.0",
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
      bucket: "old-bucket",
      source_base_url: "https://old-assets.example.com",
      public_url: null,
      objects: [
        {
          key: "uploads/products/shirt.webp",
          archive_path: archivePathForObjectKey("uploads/products/shirt.webp"),
          size: 123,
          etag: "\"abc\"",
          content_type: "image/webp",
          last_modified: "2026-05-27T00:00:00.000Z",
        },
      ],
    },
    ...overrides,
  });
}

describe("full backup manifest helpers", () => {
  it("encodes and decodes R2 object keys without changing addresses", () => {
    const objectKey = "uploads/products/shirt.webp";
    const archivePath = archivePathForObjectKey(objectKey);

    expect(archivePath.startsWith(FULL_BACKUP_STORAGE_PREFIX)).toBe(true);
    expect(objectKeyFromArchivePath(archivePath)).toBe(objectKey);
  });

  it("rejects archive object paths that escape the storage prefix", () => {
    expect(() => objectKeyFromArchivePath("../database/dump.sql")).toThrow(
      "Archive object path must be inside storage/objects."
    );
  });

  it("validates manifest object path and key pairs", () => {
    const manifest = parseFullBackupManifest(buildManifest());

    expect(manifest.storage.objects).toHaveLength(1);
    expect(manifest.storage.objects[0].key).toBe("uploads/products/shirt.webp");
  });

  it("rejects mismatched manifest object paths", () => {
    const manifest = JSON.parse(buildManifest());
    manifest.storage.objects[0].archive_path = archivePathForObjectKey("uploads/other.webp");

    expect(() => parseFullBackupManifest(JSON.stringify(manifest))).toThrow(
      "has a mismatched archive path"
    );
  });

  it("rewrites old media base URLs inside strings and JSON content", () => {
    const html =
      '<img src="https://old-assets.example.com/uploads/products/shirt.webp" alt="Shirt">';
    expect(
      replaceMediaBaseUrlInString(
        html,
        "https://old-assets.example.com/",
        "https://new-assets.example.com/"
      )
    ).toContain("https://new-assets.example.com/uploads/products/shirt.webp");

    expect(
      replaceMediaBaseUrlInJson(
        {
          html_content: html,
          nested: ["https://old-assets.example.com/uploads/hero.webp"],
        },
        "https://old-assets.example.com",
        "https://new-assets.example.com"
      )
    ).toEqual({
      html_content:
        '<img src="https://new-assets.example.com/uploads/products/shirt.webp" alt="Shirt">',
      nested: ["https://new-assets.example.com/uploads/hero.webp"],
    });
  });

  it("keeps exact URLs when no destination rewrite is requested", () => {
    const value = "https://old-assets.example.com/uploads/hero.webp";

    expect(replaceMediaBaseUrlInString(value, "", "https://new-assets.example.com")).toBe(value);
  });

  it("requires the typed destructive restore confirmation", () => {
    expect(isValidFullBackupConfirmation(FULL_BACKUP_CONFIRMATION)).toBe(true);
    expect(isValidFullBackupConfirmation("restore full backup")).toBe(false);
  });

  it("reads the users entry and treats its absence as an older archive", () => {
    expect(parseFullBackupManifest(buildManifest()).users).toBeNull();
    expect(parseFullBackupManifest(buildManifest({ users: { path: FULL_BACKUP_USERS_PATH, count: 3 } })).users).toEqual({
      path: FULL_BACKUP_USERS_PATH,
      count: 3,
    });
    expect(parseFullBackupManifest(buildManifest({ users: { path: "elsewhere.json", count: 3 } })).users).toBeNull();
  });
});

describe("full backup users bundle", () => {
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "admin@example.com",
    password_hash: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ",
    email_confirmed: true,
    user_metadata: { full_name: "Site Admin" },
    providers: ["email"],
    has_totp: true,
  };

  function bundle(users: unknown[]) {
    return JSON.stringify({ type: FULL_BACKUP_USERS_TYPE, version: 1, exported_at: "2026-10-20T00:00:00.000Z", users });
  }

  it("parses records and fills defaults for optional fields", () => {
    const parsed = parseFullBackupUsersBundle(bundle([record]));

    expect(parsed.users).toEqual([
      {
        id: record.id,
        email: "admin@example.com",
        phone: null,
        password_hash: record.password_hash,
        email_confirmed: true,
        phone_confirmed: false,
        user_metadata: { full_name: "Site Admin" },
        created_at: null,
        last_sign_in_at: null,
        banned_until: null,
        providers: ["email"],
        has_totp: true,
        is_sso_user: false,
        is_anonymous: false,
      },
    ]);
  });

  it("rejects a bundle of another type, an invalid id, or an unrecognised hash", () => {
    expect(() => parseFullBackupUsersBundle(JSON.stringify({ type: "other", version: 1, users: [] }))).toThrow(
      "auth users bundle version 1"
    );
    expect(() => parseFullBackupUsersBundle(bundle([{ ...record, id: "not-a-uuid" }]))).toThrow("invalid account id");
    expect(() => parseFullBackupUsersBundle(bundle([{ ...record, password_hash: "plaintext" }]))).toThrow(
      "unrecognised password hash"
    );
  });
});
