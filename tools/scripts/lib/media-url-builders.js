// Media display URLs come from resolveMediaUrl, never from the public media base by hand.
//
// A media row's key displays from the public media base (NEXT_PUBLIC_R2_BASE_URL: R2, MinIO, or
// Supabase Storage's public endpoint), except the keys of files bundled in
// apps/nextblock/public/images, which the app serves from /images/… (BUNDLED_PUBLIC_MEDIA_KEYS).
// The seed, the sandbox reset and migration 02032 point media rows at those files. Until 2026-11-13
// fifteen modules joined the base to the key by hand, so those rows showed a broken image wherever
// the base was set: the CMS products list, the product editor, the product page, the shop grid.
// resolveMediaUrl (@nextblock-cms/utils/media-url, re-exported app-side as
// lib/media/resolveMediaUrl.ts) is the one place that knows the bundled keys.
//
// The check fails on a module in apps/nextblock or libs that reads the base outside
// MEDIA_BASE_READERS: a code reference to NEXT_PUBLIC_R2_BASE_URL or NEXT_PUBLIC_R2_PUBLIC_URL
// (`process.env.X`, `process.env['X']`, a destructured name, a string that is the name) or a string
// holding Supabase Storage's public object path. Comments do not count, and neither does a longer
// message that mentions a name. A module that reads the base only as configuration (the CSP, the
// setup wizard, the storage provider, backups, image-origin allow-lists) is listed with why; display
// code calls resolveMediaUrl, resolveMediaUrlWithSupabaseFallback or getPublicMediaBaseUrl.

const fs = require('node:fs');
const ts = require('typescript');

const { scanRepository } = require('./service-role-boundary.js');

/** The env vars that hold the public media base. */
const MEDIA_BASE_ENV_NAMES = new Set(['NEXT_PUBLIC_R2_BASE_URL', 'NEXT_PUBLIC_R2_PUBLIC_URL']);
/** Supabase Storage's public object endpoint, the base on the native Supabase backend. */
const SUPABASE_PUBLIC_OBJECT_PATH = '/storage/v1/object/public';
/** Cheap text test before a module is parsed. */
const HINT = /NEXT_PUBLIC_R2_(?:BASE|PUBLIC)_URL|\/storage\/v1\/object\/public/;

/** Modules allowed to read the public media base, with why. Display code never belongs here. */
const MEDIA_BASE_READERS = new Map([
  ['libs/utils/src/lib/media-url.ts', 'the shared resolver: getPublicMediaBaseUrl, the bundled keys, the Supabase fallback.'],
  ['apps/nextblock/next.config.js', 'build config: inlines NEXT_PUBLIC_R2_BASE_URL (Supabase Storage on a zero-key deploy) and derives the image remotePatterns.'],
  ['apps/nextblock/proxy.ts', 'the CSP: the media hosts as img-src/connect-src origins.'],
  ['apps/nextblock/lib/storage/provider.ts', "the storage provider: resolveMediaBaseUrl(), the server's runtime base (Supabase Storage included)."],
  ['apps/nextblock/app/setup/page.tsx', "the setup wizard's current storage settings."],
  ['apps/nextblock/app/setup/SetupWizard.tsx', 'the setup wizard writes the env vars it collects.'],
  ['apps/nextblock/lib/full-backup/server.ts', "backups: the manifest records the source base and a restore rewrites URLs to the destination's."],
  ['apps/nextblock/app/cms/settings/backup-restore/BackupRestoreWorkspace.tsx', "backups: the restore form's default destination base."],
  ['apps/nextblock/lib/affiliates/image-origins.ts', 'the storefront image-origin allow-list (origins, not URLs).'],
  ['apps/nextblock/app/(public)/partners/_components/storefront-loader.ts', "the origins the storefront card's avatar fetch may reach (origins, not URLs)."],
]);

/** Script kind by extension, as the boundary scan does: `.js` may hold JSX. */
function parseSource(fileName, source) {
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(fileName)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(fileName)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source; // drop a byte-order mark
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

const isTemplatePiece = (node) => ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);

/** Every read of the public media base in a parsed module, as `what (line n)`. */
function referencesIn(sourceFile) {
  const found = [];
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    if (ts.isIdentifier(node) && MEDIA_BASE_ENV_NAMES.has(node.text)) {
      found.push(`${node.text} (line ${at(node)})`);
    } else if (ts.isStringLiteralLike(node) && MEDIA_BASE_ENV_NAMES.has(node.text)) {
      found.push(`'${node.text}' (line ${at(node)})`);
    }
    if ((ts.isStringLiteralLike(node) || isTemplatePiece(node)) && node.text.includes(SUPABASE_PUBLIC_OBJECT_PATH)) {
      found.push(`${SUPABASE_PUBLIC_OBJECT_PATH} (line ${at(node)})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Every read of the public media base in a module's source, as `what (line n)`. */
function mediaBaseReferencesInSource(fileName, source) {
  return referencesIn(parseSource(fileName, source));
}

/**
 * Modules that read the public media base without a MEDIA_BASE_READERS entry or cannot be parsed,
 * and entries whose module no longer reads it.
 */
function findHandBuiltMediaUrlProblems(
  modules = scanRepository(),
  readers = MEDIA_BASE_READERS,
  readFile = (absolute) => fs.readFileSync(absolute, 'utf8')
) {
  const problems = [];
  const seen = new Set();
  for (const mod of modules.values()) {
    const source = readFile(mod.absolute);
    if (!HINT.test(source)) continue;
    const sourceFile = parseSource(mod.absolute, source);
    if (sourceFile.parseDiagnostics?.length > 0) {
      problems.push(`${mod.repoPath} cannot be parsed, so the media URL scan cannot check it: fix the syntax error.`);
      continue;
    }
    const found = referencesIn(sourceFile);
    if (found.length === 0) continue;
    seen.add(mod.repoPath);
    if (!readers.has(mod.repoPath)) {
      problems.push(
        `${mod.repoPath} reads the public media base (${found.join(', ')}): build media URLs with resolveMediaUrl or resolveMediaUrlWithSupabaseFallback (@nextblock-cms/utils/media-url; app-side lib/media/resolveMediaUrl.ts), which serve the bundled public/images keys from /images. A module that reads the base only as configuration goes in MEDIA_BASE_READERS (tools/scripts/lib/media-url-builders.js) with why.`
      );
    }
  }
  for (const repoPath of readers.keys()) {
    if (!seen.has(repoPath)) problems.push(`MEDIA_BASE_READERS lists ${repoPath}, which no longer reads the public media base: remove the entry.`);
  }
  return problems;
}

module.exports = { MEDIA_BASE_READERS, findHandBuiltMediaUrlProblems, mediaBaseReferencesInSource };
