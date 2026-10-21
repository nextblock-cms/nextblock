// The migration security lint: what a forward migration may do to the objects the Data API
// (anon, authenticated) can reach.
//
// Supabase grants nothing on objects created in `public` (changelog 45329: the default for
// projects created since 2026-05-30 and for every existing project from 2026-10-30; existing
// objects keep their grants). The baseline (02003) grants on every table and sequence it ships
// and the catch-up replays generation-1 files that carry their own, so the only way to lose
// the API on an object is a forward migration that creates one without granting on it in the
// same file. PostgREST then answers 42501 for that object whatever its policies say, and
// nothing in the repo notices until a user does. `npm run db:migrate:check` and the bundle
// generator refuse such a file. Rules + the rationale: docs/04 → "Row Level Security Patterns".
//
// The same lint also refuses, in forward migrations:
//   - a new table in `public` without ENABLE ROW LEVEL SECURITY in the same file, and
//     DISABLE / NO FORCE ROW LEVEL SECURITY on a `public` table;
//   - a SECURITY DEFINER function or procedure created (or ALTERed to definer) in `public`
//     without REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated in the same file, or granted
//     back to one of them (Postgres grants EXECUTE to PUBLIC on every new function and Supabase
//     grants anon/authenticated by name, so revoking from PUBLIC alone is not enough), matched
//     by argument types, not by name; and a definer function in any schema without SET
//     search_path;
//   - a write grant (INSERT/UPDATE/DELETE/TRUNCATE) on a `public` table to anon or PUBLIC;
//   - a new `public` view without security_invoker (the deploy pass grants anon SELECT on every
//     view, and a definer-rights view reads past RLS), security_invoker turned off, and a
//     `public` materialized view the file does not revoke from the API roles;
//   - a permissive policy for anon, authenticated, PUBLIC or no TO at all whose USING or WITH
//     CHECK is a constant, outside PUBLIC_READ_TABLES reads;
//   - objects that reach `public` around these checks (top-level SELECT ... INTO, SET SCHEMA
//     public), role membership for an API role, BYPASSRLS / SUPERUSER, and CREATE on schema
//     public for an API role;
//   - an EXECUTE in a DO block or function whose statement the lint cannot read. The template
//     of EXECUTE format('...') and of EXECUTE '...' || expr is linted like any other statement
//     (%I / %s / non-literal parts become wildcards); anything else needs a
//     `-- nb-lint: dynamic-sql reviewed: <why>` comment right above it.
// findRevokesUndoneByGrantPass() and findGrantsWidenedByGrantPass() are the companion checks
// run by migration-grants.test.ts: a revoke from anon/authenticated that the post-apply
// GRANTS_SQL hands back on every deploy, and a new table or view whose migration grants it
// less than that pass does. grantPassGuardProblems() checks that every to_regclass /
// to_regprocedure guard in that pass names the object the statement inside it touches.
//
// Every check reads statements from a real tokenizer (comments, '' / E'' strings, $tag$
// quotes, "identifiers"): only bodies that follow DO or AS (and EXECUTE templates) are code,
// every other string is a literal. A file the tokenizer cannot read (an unterminated quote or
// comment, unbalanced parentheses) is refused outright, never linted half-way.

const { isBaselineMigration, isCatchupMigration, parseMigrationName } = require('./migration-naming');

const API_ROLES = ['anon', 'authenticated', 'service_role', 'public'];
const ROLES_HINT = 'anon, authenticated, service_role';
const API_CALLERS = ['public', 'anon', 'authenticated'];
const REVOKE_LIST_HINT =
  'API_ROLE_REVOKE_SQL in BOTH apps/nextblock/tools/lib/migrate-core.mjs and apps/nextblock/lib/setup/schema-apply.ts';

/* ------------------------------------------------------------------ tokenizer --- */

class SqlSyncError extends Error {}

const SPACE_AT = /\s+/y;
const DOLLAR_TAG_AT = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
const WORD_AT = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;
const NUMBER_AT = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Index just past the quoted run that opens at `start`; a doubled quote is an escape. */
function quotedEnd(sql, start, quote, backslashEscapes, what) {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (backslashEscapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new SqlSyncError(`unterminated ${what} starting on line ${lineAt(sql, start)}`);
}

const E_ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** The value of an E'...' body: backslash escapes and doubled quotes resolved. */
function unescapeE(body) {
  return body.replace(/''|\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (match, escape) => {
    if (match === "''") return "'";
    const head = escape[0];
    if (E_ESCAPES[head]) return E_ESCAPES[head];
    if (head === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (head === 'u' || head === 'U') return String.fromCodePoint(parseInt(escape.slice(1), 16));
    if (/[0-7]/.test(head)) return String.fromCharCode(parseInt(escape, 8));
    return escape;
  });
}

/**
 * Lex SQL into { type, start, end, text, ... } tokens: space, comment, word (with `upper`),
 * qident / string / dollar (with the unquoted `value`; dollar also has `tag`), param, number
 * and single-character op. Throws SqlSyncError on an unterminated comment, string, quoted
 * identifier or dollar quote: everything after one would be read in the wrong mode.
 */
function lex(sql) {
  const tokens = [];
  const n = sql.length;
  const push = (type, start, end, extra) => tokens.push({ type, start, end, text: sql.slice(start, end), ...extra });
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    SPACE_AT.lastIndex = i;
    if (SPACE_AT.test(sql)) {
      push('space', i, SPACE_AT.lastIndex);
      i = SPACE_AT.lastIndex;
      continue;
    }
    if (c === '-' && next === '-') {
      const newline = sql.indexOf('\n', i);
      const end = newline === -1 ? n : newline;
      push('comment', i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      if (depth > 0) throw new SqlSyncError(`unterminated /* comment starting on line ${lineAt(sql, i)}`);
      push('comment', i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      const end = quotedEnd(sql, i, "'", false, 'string');
      push('string', i, end, { value: sql.slice(i + 1, end - 1).replace(/''/g, "'") });
      i = end;
      continue;
    }
    if (c === '"') {
      const end = quotedEnd(sql, i, '"', false, 'quoted identifier');
      push('qident', i, end, { value: sql.slice(i + 1, end - 1).replace(/""/g, '"') });
      i = end;
      continue;
    }
    if (c === '$') {
      DOLLAR_TAG_AT.lastIndex = i;
      const tag = DOLLAR_TAG_AT.exec(sql);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close === -1) throw new SqlSyncError(`unterminated dollar quote ${tag[0]} starting on line ${lineAt(sql, i)}`);
        push('dollar', i, close + tag[0].length, { tag: tag[0], value: sql.slice(i + tag[0].length, close) });
        i = close + tag[0].length;
        continue;
      }
      if (/\d/.test(next || '')) {
        let j = i + 1;
        while (j < n && /\d/.test(sql[j])) j += 1;
        push('param', i, j);
        i = j;
        continue;
      }
    }
    WORD_AT.lastIndex = i;
    const word = WORD_AT.exec(sql);
    if (word) {
      const end = WORD_AT.lastIndex;
      // E'...' only when the whole word is E; `LIKE'%\'` is a plain string after LIKE.
      if ((word[0] === 'E' || word[0] === 'e') && sql[end] === "'") {
        const close = quotedEnd(sql, end, "'", true, "E'' string");
        push('string', i, close, { value: unescapeE(sql.slice(end + 1, close - 1)) });
        i = close;
        continue;
      }
      push('word', i, end, { upper: word[0].toUpperCase() });
      i = end;
      continue;
    }
    NUMBER_AT.lastIndex = i;
    const number = NUMBER_AT.exec(sql);
    if (number) {
      push('number', i, NUMBER_AT.lastIndex);
      i = NUMBER_AT.lastIndex;
      continue;
    }
    push('op', i, i + 1);
    i += 1;
  }
  return tokens;
}

/** A source whose parentheses do not balance was mis-read (or is not valid SQL). */
function checkParens(tokens, source) {
  const opens = [];
  for (const t of tokens) {
    if (t.type !== 'op') continue;
    if (t.text === '(') opens.push(t.start);
    else if (t.text === ')') {
      if (opens.length === 0) throw new SqlSyncError(`unbalanced ')' on line ${lineAt(source, t.start)}`);
      opens.pop();
    }
  }
  if (opens.length > 0) throw new SqlSyncError(`'(' on line ${lineAt(source, opens[opens.length - 1])} is never closed`);
}

const isSignificant = (t) => t.type !== 'space' && t.type !== 'comment';
const isWord = (t, upper) => Boolean(t) && t.type === 'word' && t.upper === upper;
const isWordIn = (t, uppers) => Boolean(t) && t.type === 'word' && uppers.includes(t.upper);
const isOp = (t, text) => Boolean(t) && t.type === 'op' && t.text === text;

function nextSignificant(tokens, k) {
  for (let i = k + 1; i < tokens.length; i += 1) if (isSignificant(tokens[i])) return tokens[i];
  return null;
}

/* --------------------------------------------------------------- identifiers --- */

/** Placeholders for the parts of a dynamic statement the lint cannot know. */
const WILD_IDENT = 'nbdyn_i';
const WILD_TEXT = 'nbdyn_s';
const isWildName = (name) => name === WILD_IDENT || name === WILD_TEXT;

const canonicalIdent = (value) => /^[a-z_][a-z0-9_$]*$/.test(value);

/**
 * How the lint names an identifier: unquoted words fold to lower case like Postgres does; a
 * quoted identifier keeps its exact spelling, encoded as `nbq_<hex>` unless it is already a
 * lower-case name. So public."Secrets" and public.secrets stay two different tables.
 */
const encodeIdent = (value) => (canonicalIdent(value) ? value : `nbq_${Buffer.from(value, 'utf8').toString('hex')}`);

/** A lint name as it is written in SQL, for messages. */
function display(name) {
  if (name === WILD_IDENT) return '%I (dynamic)';
  if (name === WILD_TEXT) return '%s (dynamic)';
  const quoted = /^nbq_([0-9a-f]+)$/.exec(name);
  if (quoted) return `"${Buffer.from(quoted[1], 'hex').toString('utf8').replace(/"/g, '""')}"`;
  return name;
}

const quoteIdent = (value) => (canonicalIdent(value) ? value : `"${value.replace(/"/g, '""')}"`);

/* ------------------------------------------------- regions and statements --- */

// A region is a run of SQL the database reads as code: the file itself ('top'), a DO body
// ('do'), a function body ('function', runs later, when called) or the template of an EXECUTE
// ('dynamic'). Each region is lexed on its own, so a quote inside a body can never desync the
// file around it. `executes` is true when the region runs while the migration applies.

function newStatement(region) {
  return { text: '', tokens: [], comments: [], region, opaqueExecute: false, guard: null };
}

/** DO $$...$$, DO LANGUAGE x '...', and AS $$...$$ / AS '...' (function bodies) hold code. */
function bodyKind(previous) {
  const [c, b, a] = [previous[previous.length - 3], previous[previous.length - 2], previous[previous.length - 1]];
  if (isWord(a, 'AS')) return 'function';
  if (isWord(a, 'DO')) return 'do';
  if (a && a.type === 'word' && isWord(b, 'LANGUAGE') && isWord(c, 'DO')) return 'do';
  return null;
}

/**
 * plpgsql EXECUTE runs a string as SQL; EXECUTE FUNCTION/PROCEDURE (triggers) and the EXECUTE
 * privilege do not.
 */
function isDynamicExecute(previous, tokens, k) {
  const before = previous[previous.length - 1];
  if (isWordIn(before, ['GRANT', 'REVOKE']) || isOp(before, ',')) return false;
  const after = nextSignificant(tokens, k);
  if (!after || isWordIn(after, ['FUNCTION', 'PROCEDURE', 'ON']) || isOp(after, ',') || isOp(after, ';')) return false;
  return true;
}

/** Index of the token that ends an EXECUTE expression: `;`, INTO or USING at depth 0. */
function executeEnd(tokens, from) {
  let depth = 0;
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isOp(t, '(')) depth += 1;
    else if (isOp(t, ')')) depth -= 1;
    else if (depth === 0 && (isOp(t, ';') || isWordIn(t, ['INTO', 'USING']))) return i;
  }
  return tokens.length;
}

/** Split significant tokens at top-level occurrences of the op `sep`. */
function splitTokens(tokens, sep = ',') {
  const parts = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (isOp(t, '(') || isOp(t, '[')) depth += 1;
    else if (isOp(t, ')') || isOp(t, ']')) depth -= 1;
    if (depth === 0 && isOp(t, sep)) parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts.filter((p) => p.length > 0);
}

const isLiteralPiece = (piece) => piece.length === 1 && (piece[0].type === 'string' || piece[0].type === 'dollar');

function literalValue(piece) {
  if (!piece) return null;
  if (isLiteralPiece(piece)) return piece[0].value;
  if (piece.length === 1 && piece[0].type === 'number') return piece[0].text;
  return null;
}

/** `name(args)` spanning the whole piece, as { name, args } (args split at top-level commas). */
function callOf(piece) {
  if (piece.length < 3 || piece[0].type !== 'word' || !isOp(piece[1], '(') || !isOp(piece[piece.length - 1], ')')) return null;
  let depth = 0;
  for (let i = 1; i < piece.length; i += 1) {
    if (isOp(piece[i], '(')) depth += 1;
    else if (isOp(piece[i], ')')) {
      depth -= 1;
      if (depth === 0 && i !== piece.length - 1) return null;
    }
  }
  return { name: piece[0].text.toLowerCase(), args: splitTokens(piece.slice(2, -1)) };
}

/** format()'s template with each %I / %s / %L replaced by its literal argument or a wildcard. */
function substituteFormat(template, args) {
  let next = 0;
  return template.replace(/%(?:(\d+)\$)?(?:-?\d*|\*)?([sIL%])/g, (match, position, type) => {
    if (type === '%') return '%';
    const index = position ? Number(position) - 1 : next;
    next = index + 1;
    const value = literalValue(args[index]);
    if (type === 'I') return value === null ? WILD_IDENT : quoteIdent(value);
    if (type === 'L') return value === null ? "''" : `'${value.replace(/'/g, "''")}'`;
    return value === null ? WILD_TEXT : value;
  });
}

/**
 * The SQL an EXECUTE expression runs, as far as the source shows it: a literal, format() with
 * a literal template, or a `||` concatenation with at least one literal piece. Non-literal
 * parts become wildcards. Null when nothing of the statement is visible.
 */
function executeTemplate(expression) {
  const pieces = [[]];
  let depth = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const t = expression[i];
    if (isOp(t, '(')) depth += 1;
    else if (isOp(t, ')')) depth -= 1;
    const next = expression[i + 1];
    if (depth === 0 && isOp(t, '|') && isOp(next, '|') && next.start === t.end) {
      pieces.push([]);
      i += 1;
      continue;
    }
    pieces[pieces.length - 1].push(t);
  }
  let literal = false;
  let text = '';
  for (const piece of pieces) {
    if (isLiteralPiece(piece)) {
      literal = true;
      text += piece[0].value;
      continue;
    }
    const call = callOf(piece);
    if (call && call.name === 'format') {
      if (!isLiteralPiece(call.args[0] || [])) return null;
      literal = true;
      text += substituteFormat(call.args[0][0].value, call.args.slice(1));
    } else if (call && call.name === 'quote_ident') {
      const value = literalValue(call.args[0]);
      text += value === null ? WILD_IDENT : quoteIdent(value);
    } else if (call && (call.name === 'quote_literal' || call.name === 'quote_nullable')) {
      text += "''";
    } else {
      text += ` ${WILD_TEXT} `;
    }
  }
  return literal ? text : null;
}

function guardOf(tokens) {
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (isWordIn(tokens[i], ['TO_REGCLASS', 'TO_REGPROCEDURE', 'TO_REGPROC']) && isOp(tokens[i + 1], '(') && tokens[i + 2].type === 'string') {
      return { fn: tokens[i].text.toLowerCase(), literal: tokens[i + 2].value };
    }
  }
  return null;
}

/**
 * IF / ELSIF / ELSE / END IF tracking in a plpgsql region, so a statement knows which
 * `if to_regclass(...) is not null then` guard it runs under. CASE ... END is skipped.
 */
function trackFlow(flow, t, tokens, k) {
  if (isOp(t, '(')) flow.depth += 1;
  else if (isOp(t, ')')) flow.depth -= 1;
  if (flow.pendingIf && !(isWord(t, 'THEN') && flow.depth === flow.pendingIf.depth)) {
    flow.pendingIf.tokens.push(t);
    return;
  }
  if (t.type !== 'word') return;
  switch (t.upper) {
    case 'END': {
      const next = nextSignificant(tokens, k);
      if (isWord(next, 'IF')) {
        flow.ifs.pop();
        flow.skipIf = true;
      } else if (isWord(next, 'CASE')) {
        flow.caseDepth = Math.max(0, flow.caseDepth - 1);
        flow.skipCase = true;
      } else if (!isWord(next, 'LOOP') && flow.caseDepth > 0) flow.caseDepth -= 1;
      break;
    }
    case 'IF':
      if (flow.skipIf) flow.skipIf = false;
      else flow.pendingIf = { tokens: [], depth: flow.depth };
      break;
    case 'ELSIF':
    case 'ELSEIF':
      flow.ifs.pop();
      flow.pendingIf = { tokens: [], depth: flow.depth };
      break;
    case 'THEN':
      if (flow.pendingIf) {
        flow.ifs.push({ guard: guardOf(flow.pendingIf.tokens), else: false });
        flow.pendingIf = null;
      }
      break;
    case 'ELSE':
      if (flow.caseDepth === 0 && flow.ifs.length > 0) flow.ifs[flow.ifs.length - 1].else = true;
      break;
    case 'CASE':
      if (flow.skipCase) flow.skipCase = false;
      else flow.caseDepth += 1;
      break;
    default:
  }
}

function inBody(render, source, token, what) {
  try {
    return render();
  } catch (error) {
    if (error instanceof SqlSyncError) {
      throw new SqlSyncError(`${error.message} (inside the ${what} that starts on line ${lineAt(source, token.start)})`);
    }
    throw error;
  }
}

const wordToken = (t) => ({ type: 'word', text: t.text, upper: t.upper });

/**
 * Lex one region, append its statements (and those of every region nested in it) to `out`,
 * and return its code: comments dropped, literals emptied to '', quoted identifiers in their
 * lint form, and nested code wrapped in $tag$ quotes so that rendering the code again yields
 * the same code (codeOnly is idempotent).
 */
function renderRegion(source, region, out) {
  const tokens = lex(source);
  checkParens(tokens, source);
  // Identity of the region for comparing dynamic statements: literals kept, layout dropped.
  region.fingerprint = tokens
    .filter(isSignificant)
    .map((t) => (t.type === 'word' ? t.text.toLowerCase() : t.text))
    .join(' ');
  const plpgsql = region.kind === 'do' || region.kind === 'function';
  const flow = { ifs: [], pendingIf: null, caseDepth: 0, depth: 0, skipIf: false, skipCase: false };
  const guard = () => {
    for (let i = flow.ifs.length - 1; i >= 0; i -= 1) if (flow.ifs[i].guard && !flow.ifs[i].else) return flow.ifs[i].guard;
    return region.guard || null;
  };
  let code = '';
  let statement = newStatement(region);
  const previous = [];
  const emit = (text, token) => {
    code += text;
    statement.text += text;
    if (token) statement.tokens.push(token);
  };
  const finish = () => {
    if (statement.tokens.length > 0) {
      statement.guard = guard();
      out.push(statement);
    }
    statement = newStatement(region);
  };
  const subRegion = (kind, executes, extra) => ({ kind, executes, depth: region.depth + 1, parent: region, guard: guard(), ...extra });

  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type === 'space') {
      emit(t.text);
      continue;
    }
    if (t.type === 'comment') {
      code += ' ';
      statement.text += ' ';
      statement.comments.push(t.text);
      continue;
    }
    if (plpgsql) trackFlow(flow, t, tokens, k);

    if (t.type === 'string' || t.type === 'dollar') {
      const kind = bodyKind(previous);
      if (kind) {
        const sub = subRegion(kind, region.executes && kind === 'do');
        const inner = inBody(() => renderRegion(t.value, sub, out), source, t, kind === 'do' ? 'DO body' : 'function body');
        const tag = t.type === 'dollar' ? t.tag : `$nb_sq_${sub.depth}$`;
        code += tag + inner + tag;
        statement.text += ' nb_body ';
        statement.tokens.push({ type: 'body', text: 'nb_body', region: sub });
      } else {
        emit("''", { type: 'string', text: "''", value: t.value });
      }
    } else if (t.type === 'qident') {
      const name = encodeIdent(t.value);
      const text = canonicalIdent(t.value) ? `"${t.value}"` : name;
      emit(text, { type: 'ident', text, name });
    } else if (plpgsql && isWord(t, 'EXECUTE') && isDynamicExecute(previous, tokens, k)) {
      const end = executeEnd(tokens, k + 1);
      const template = executeTemplate(tokens.slice(k + 1, end).filter(isSignificant));
      if (template === null) {
        statement.opaqueExecute = true;
        emit(t.text, wordToken(t));
      } else {
        const sub = subRegion('dynamic', region.executes, { context: region.fingerprint });
        const inner = inBody(() => renderRegion(template, sub, out), source, t, 'EXECUTE template');
        const tag = `$nb_dyn_${sub.depth}$`;
        code += `${t.text} ${tag}${inner}${tag}`;
        statement.text += `${t.text} nb_body`;
        statement.tokens.push(wordToken(t), { type: 'body', text: 'nb_body', region: sub });
        k = end - 1;
      }
    } else if (isOp(t, ';')) {
      code += ';';
      statement.text += ';';
      finish();
    } else {
      emit(t.text, t.type === 'word' ? wordToken(t) : { type: t.type, text: t.text });
    }
    previous.push(t);
    if (previous.length > 3) previous.shift();
  }
  finish();
  return code;
}

const ANALYSIS_CACHE = new Map();

/** { code, statements } for a SQL source; throws SqlSyncError when it cannot be read. */
function analyse(sql) {
  const cached = ANALYSIS_CACHE.get(sql);
  if (cached) return cached;
  const statements = [];
  const code = renderRegion(sql, { kind: 'top', executes: true, depth: 0, parent: null, guard: null }, statements);
  const result = { code, statements };
  if (ANALYSIS_CACHE.size >= 64) ANALYSIS_CACHE.delete(ANALYSIS_CACHE.keys().next().value);
  ANALYSIS_CACHE.set(sql, result);
  return result;
}

/**
 * The SQL with comments removed, every string literal emptied and quoted identifiers in their
 * lint form, so `CREATE TABLE` inside seed copy or a RAISE message is never mistaken for DDL.
 * Code bodies (DO, AS, EXECUTE templates) stay, wrapped in $tag$ quotes: a DO block that
 * creates a table needs the grant like any other statement. Idempotent.
 */
function codeOnly(sql) {
  return analyse(sql).code;
}

/* ------------------------------------------------------ statement parsing helpers --- */

const identToken = (t) => Boolean(t) && (t.type === 'ident' || t.type === 'word');
const nameOfToken = (t) => (t.type === 'ident' ? t.name : t.text.toLowerCase());
const isPublic = (schema) => !schema || schema === 'public';
const tokensText = (tokens) => tokens.map((t) => t.text).join(' ');

/** `[schema.]name` at tokens[i], as { schema, name, next }. */
function readName(tokens, i) {
  if (!identToken(tokens[i])) return null;
  if (isOp(tokens[i + 1], '.') && identToken(tokens[i + 2])) {
    return { schema: nameOfToken(tokens[i]), name: nameOfToken(tokens[i + 2]), next: i + 3 };
  }
  return { schema: null, name: nameOfToken(tokens[i]), next: i + 1 };
}

/** The parenthesised group that opens at tokens[i], as { inner, next }. */
function parenGroup(tokens, i) {
  if (!isOp(tokens[i], '(')) return null;
  let depth = 0;
  for (let j = i; j < tokens.length; j += 1) {
    if (isOp(tokens[j], '(')) depth += 1;
    else if (isOp(tokens[j], ')')) {
      depth -= 1;
      if (depth === 0) return { inner: tokens.slice(i + 1, j), next: j + 1 };
    }
  }
  return null;
}

/** Indexes where the given word sequence starts. */
function findSequence(tokens, words) {
  const hits = [];
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    if (words.every((w, o) => isWord(tokens[i + o], w))) hits.push(i);
  }
  return hits;
}

/** Split at commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/* ------------------------------------------------------------ function signatures --- */

const TYPE_ALIASES = new Map([
  ['int', 'integer'],
  ['int4', 'integer'],
  ['int8', 'bigint'],
  ['int2', 'smallint'],
  ['float8', 'double precision'],
  ['float', 'double precision'],
  ['float4', 'real'],
  ['bool', 'boolean'],
  ['varchar', 'character varying'],
  ['char varying', 'character varying'],
  ['char', 'character'],
  ['bpchar', 'character'],
  ['timestamptz', 'timestamp with time zone'],
  ['timestamp', 'timestamp without time zone'],
  ['timetz', 'time with time zone'],
  ['time', 'time without time zone'],
  ['decimal', 'numeric'],
]);

const MULTIWORD_TYPE_RE =
  /^(?:double precision|character varying|char varying|national character(?: varying)?|bit varying|(?:timestamp|time) with(?:out)? time zone|interval(?: (?:year|month|day|hour|minute|second)(?: to (?:month|hour|minute|second))?)?)$/;

function normalizeType(text) {
  let type = text.toLowerCase().replace(/\s+/g, ' ').trim();
  type = type.replace(/^(?:pg_catalog|public)\./, '');
  const array = (/(?:\[\])+$/.exec(type) || [''])[0];
  const base = type.slice(0, type.length - array.length).trim();
  return (TYPE_ALIASES.get(base) || base) + array;
}

const isTypeExpression = (text) => {
  const base = text.toLowerCase().replace(/(?:\[\])+$/, '').trim();
  return /^[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?$/.test(base) || MULTIWORD_TYPE_RE.test(base);
};

/**
 * The argument types that identify a function: names, modes, defaults and type modifiers
 * dropped, OUT arguments left out, aliases resolved (`p timestamptz DEFAULT now()` →
 * `timestamp with time zone`). '' for no arguments.
 */
function normalizeSignature(argsText) {
  const tidy = argsText
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*\[\s*\d*\s*\]/g, '[]')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')');
  const types = [];
  for (const raw of splitTopLevel(tidy)) {
    let arg = raw.replace(/\s*(?:\bDEFAULT\b|=)[\s\S]*$/i, '');
    while (/\([^()]*\)/.test(arg)) arg = arg.replace(/\([^()]*\)/g, '');
    const words = arg.trim().split(/\s+/).filter(Boolean);
    let mode = 'in';
    if (words.length > 1 && /^(?:in|out|inout|variadic)$/i.test(words[0])) mode = words.shift().toLowerCase();
    if (mode === 'out' || words.length === 0) continue;
    if (words.length > 1 && !isTypeExpression(words.join(' '))) words.shift();
    types.push(normalizeType(words.join(' ')));
  }
  return types.join(', ');
}

const sigMatch = (a, b) => a === null || a === undefined || b === null || b === undefined || a === b;
const sigText = (signature) => (signature === null || signature === undefined ? '' : `(${signature})`);

/* ------------------------------------------------------- GRANT / REVOKE statements --- */

const FULL_PRIVILEGES = {
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
  function: ['EXECUTE'],
};

/** `public.f(uuid)`, `"public"."t"`, `t` → { name, signature } when in public (or unqualified), else null. */
function objectRef(raw) {
  const m = /^\s*(?:"?([a-z_][a-z0-9_$]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?\s*(?:\(([\s\S]*)\))?\s*$/i.exec(raw);
  if (!m) return null;
  if (m[1] && m[1].toLowerCase() !== 'public') return null;
  return { name: m[2].toLowerCase(), signature: m[3] === undefined ? null : normalizeSignature(m[3]) };
}

const PRIVILEGE_RE = /\b(GRANT|REVOKE)\s+(?:GRANT\s+OPTION\s+FOR\s+)?([^;]*?)\s+ON\s+([^;]*?)\s+(?:TO|FROM)\s+([^;]*)/gi;

/** The object-privilege GRANT / REVOKE in one statement (see privilegeStatements). */
function privilegeStatementsOf(statement) {
  const out = [];
  const text = statement.text;
  for (const m of text.matchAll(PRIVILEGE_RE)) {
    const action = m[1].toUpperCase();
    const objects = m[3].trim();
    let kind;
    let all = false;
    let defaults = false;
    let rest = objects;
    const allMatch = /^ALL\s+(TABLES|SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES)\s+IN\s+SCHEMA\s+"?([a-z_][a-z0-9_$]*)"?\s*$/i.exec(objects);
    const defaultMatch = /^(TABLES|SEQUENCES|FUNCTIONS|ROUTINES)$/i.exec(objects);
    if (allMatch) {
      if (allMatch[2].toLowerCase() !== 'public') continue;
      all = true;
      const k = allMatch[1].toUpperCase();
      kind = k === 'TABLES' ? 'table' : k === 'SEQUENCES' ? 'sequence' : 'function';
      rest = '';
    } else if (defaultMatch) {
      // ALTER DEFAULT PRIVILEGES [FOR ROLE r] [IN SCHEMA s] GRANT ... ON TABLES TO ...
      const head = /\bALTER\s+DEFAULT\s+PRIVILEGES\b([^;]*)$/i.exec(text.slice(0, m.index));
      if (!head) continue;
      const scope = /\bIN\s+SCHEMA\s+([^;]*)$/i.exec(head[1]);
      if (scope && !splitTopLevel(scope[1]).some((s) => s.replace(/"/g, '').toLowerCase() === 'public')) continue;
      all = true;
      defaults = true;
      const k = defaultMatch[1].toUpperCase();
      kind = k === 'TABLES' ? 'table' : k === 'SEQUENCES' ? 'sequence' : 'function';
      rest = '';
    } else {
      const keyword = /^(TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|TYPE|DOMAIN|LANGUAGE|LARGE\s+OBJECT|FOREIGN\s+DATA\s+WRAPPER|FOREIGN\s+SERVER|TABLESPACE|PARAMETER)\s+/i.exec(objects);
      const word = keyword ? keyword[1].toUpperCase() : 'TABLE';
      if (word === 'TABLE') kind = 'table';
      else if (word === 'SEQUENCE') kind = 'sequence';
      else if (word === 'FUNCTION' || word === 'PROCEDURE' || word === 'ROUTINE') kind = 'function';
      else continue;
      rest = keyword ? objects.slice(keyword[0].length) : objects;
    }
    const refs = all ? [] : splitTopLevel(rest).map(objectRef).filter(Boolean);
    if (!all && refs.length === 0) continue;

    const privilegeText = m[2].trim();
    let privileges;
    if (/^ALL(\s+PRIVILEGES)?(\s*\(.*\))?$/is.test(privilegeText)) privileges = [...FULL_PRIVILEGES[kind]];
    else privileges = splitTopLevel(privilegeText).map((p) => p.replace(/\s*\(.*$/s, '').trim().toUpperCase());

    const grantees = m[4]
      .replace(/\b(?:CASCADE|RESTRICT|WITH\s+GRANT\s+OPTION|GRANTED\s+BY\s+\S+)\b/gi, '')
      .split(',')
      .map((g) => g.trim().replace(/^"|"$/g, '').toLowerCase())
      .filter(Boolean);
    out.push({
      action,
      kind,
      all,
      names: refs.map((r) => r.name),
      signatures: refs.map((r) => (kind === 'function' ? r.signature : null)),
      privileges,
      grantees,
      defaults,
      executes: statement.region.executes,
      dynamic: statement.region.kind === 'dynamic',
      context: statement.region.context || null,
    });
  }
  return out;
}

/**
 * Every object-privilege GRANT / REVOKE in the SQL (or its codeOnly), as
 * { action, kind: 'table'|'sequence'|'function', all, names, signatures, privileges, grantees,
 * defaults, executes, dynamic, context }. `all` is set for `ON ALL <kind>S IN SCHEMA public`
 * (and `defaults` for ALTER DEFAULT PRIVILEGES); names and grantees are in lint form and
 * limited to schema public; signatures are the normalised argument types of a function (null
 * without an argument list). Column lists (`UPDATE (role)`) count as the privilege itself: a
 * table-level grant supersedes a column-level revoke. Role-membership grants, schema
 * privileges and other schemas are skipped.
 */
function privilegeStatements(sql) {
  return analyse(sql).statements.flatMap(privilegeStatementsOf);
}

const describeTarget = (kind, name, signature) =>
  name === '*' ? `ALL ${kind.toUpperCase()}S IN SCHEMA public` : `${kind} public.${display(name)}${kind === 'function' ? sigText(signature) : ''}`;

/* --------------------------------------------------------------- created objects --- */

/** `CREATE [OR REPLACE] [UNLOGGED] <kind> [IF NOT EXISTS] [schema.]name` over codeOnly text. */
const CREATE_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(TABLE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;

const CREATE_KINDS = [['MATERIALIZED', 'VIEW'], ['FOREIGN', 'TABLE'], ['TABLE'], ['SEQUENCE'], ['VIEW']];

/** Views and foreign tables are granted with the TABLE keyword (or none). */
function grantKind(kind) {
  return /SEQUENCE/i.test(kind) ? 'SEQUENCE' : 'TABLE';
}

function describe(kind) {
  return kind.toLowerCase().replace(/\s+/g, ' ');
}

/** Every CREATE TABLE / SEQUENCE / VIEW / MATERIALIZED VIEW / FOREIGN TABLE, in statement order. */
function createdObjects(analysis) {
  const out = [];
  analysis.statements.forEach((statement, index) => {
    const tokens = statement.tokens;
    for (const i of findSequence(tokens, ['CREATE'])) {
      let j = i + 1;
      if (isWord(tokens[j], 'OR') && isWord(tokens[j + 1], 'REPLACE')) j += 2;
      let temp = false;
      while (isWordIn(tokens[j], ['TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'RECURSIVE'])) {
        if (isWordIn(tokens[j], ['TEMP', 'TEMPORARY'])) temp = true;
        j += 1;
      }
      const words = CREATE_KINDS.find((ws) => ws.every((w, o) => isWord(tokens[j + o], w)));
      if (!words) continue;
      j += words.length;
      if (isWord(tokens[j], 'IF') && isWord(tokens[j + 1], 'NOT') && isWord(tokens[j + 2], 'EXISTS')) j += 3;
      const ref = readName(tokens, j);
      if (!ref) continue;
      out.push({ kind: words.join(' '), temp, schema: ref.schema, name: ref.name, statement, index, after: ref.next });
    }
  });
  return out;
}

const publicCreated = (analysis) => createdObjects(analysis).filter((o) => !o.temp && isPublic(o.schema));

const SERIAL_RE = /^(?:small|big)?serial[248]?\b/i;
const IDENTITY_RE = /\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i;

/** Columns of a CREATE TABLE body whose type creates a sequence. */
function implicitSequenceColumns(tokens, from) {
  const group = parenGroup(tokens, from);
  if (!group) return [];
  const columns = [];
  for (const definition of splitTokens(group.inner)) {
    if (!identToken(definition[0]) || definition.length < 2) continue;
    if (isWordIn(definition[0], ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'EXCLUDE', 'LIKE'])) continue;
    const type = tokensText(definition.slice(1));
    if (SERIAL_RE.test(type) || IDENTITY_RE.test(type)) columns.push(nameOfToken(definition[0]));
  }
  return columns;
}

const executingPrivileges = (analysis) =>
  analysis.statements.filter((s) => s.region.executes).flatMap(privilegeStatementsOf).filter((p) => !p.defaults);

/**
 * Objects a migration creates in `public` without granting on them to an API role, as
 * [{ kind, name, problem }]. Empty when the file is fine.
 */
function findUngrantedObjects(sql) {
  const analysis = analyse(sql);
  const grants = executingPrivileges(analysis).filter((p) => p.action === 'GRANT');
  const covered = (kind, name) =>
    grants.some((g) => g.kind === kind && (g.all || g.names.includes(name)) && g.grantees.some((r) => API_ROLES.includes(r)));
  const problems = [];
  const seen = new Set();
  for (const object of publicCreated(analysis)) {
    const kind = grantKind(object.kind);
    const key = `${kind}:${object.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = display(object.name);
    if (!covered(kind.toLowerCase(), object.name)) {
      problems.push({
        kind: object.kind,
        name,
        problem: `${describe(object.kind)} public.${name} is created without a GRANT ... ON ${kind} public.${name} TO ${ROLES_HINT} in the same file`,
      });
    }
    if (object.kind === 'TABLE') {
      for (const column of implicitSequenceColumns(object.statement.tokens, object.after)) {
        const sequence = `${object.name}_${column}_seq`;
        if (covered('sequence', sequence)) continue;
        problems.push({
          kind: 'SEQUENCE',
          name: display(sequence),
          problem: `table public.${name} column ${display(column)} creates the sequence public.${display(sequence)} (serial/identity) and the file does not GRANT USAGE, SELECT ON SEQUENCE public.${display(sequence)} (or ON ALL SEQUENCES IN SCHEMA public) TO ${ROLES_HINT}`,
        });
      }
    }
  }
  return problems;
}

const ALTER_TABLE_HEAD = String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?([a-z_][a-z0-9_$]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?`;

/** Table names that the file turns row-level security ON for (ALTER TABLE ... ENABLE RLS). */
function rlsEnabledTables(analysis) {
  const names = new Set();
  const re = new RegExp(`${ALTER_TABLE_HEAD}[^;]*?\\bENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'gi');
  for (const statement of analysis.statements) {
    if (!statement.region.executes) continue;
    for (const m of statement.text.matchAll(re)) {
      if (m[1] && m[1].toLowerCase() !== 'public') continue;
      names.add(m[2].toLowerCase());
    }
  }
  return names;
}

/**
 * Tables a migration creates in `public` without enabling row-level security in the same file,
 * as [{ name, problem }]. RLS is the ONLY thing standing between the public key and a table's
 * rows (the grants above make the table reachable; without RLS + policies that reach is
 * unrestricted). Views/sequences/foreign tables are not row-secured and are not flagged.
 */
function findTablesWithoutRls(sql) {
  const analysis = analyse(sql);
  const enabled = rlsEnabledTables(analysis);
  const problems = [];
  const seen = new Set();
  for (const object of publicCreated(analysis)) {
    if (object.kind !== 'TABLE' || seen.has(object.name)) continue;
    seen.add(object.name);
    if (enabled.has(object.name)) continue;
    const name = display(object.name);
    problems.push({
      name,
      problem: `table public.${name} is created without ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY in the same file; a table reachable by the API roles with no RLS exposes every row to the public key`,
    });
  }
  return problems;
}

/** DISABLE / NO FORCE ROW LEVEL SECURITY on a public table: RLS off is every row to the API. */
function findRowSecurityProblems(sql) {
  const re = new RegExp(`${ALTER_TABLE_HEAD}[^;]*?\\b(DISABLE\\s+ROW\\s+LEVEL\\s+SECURITY|NO\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY)`, 'gi');
  const problems = [];
  for (const statement of analyse(sql).statements) {
    for (const m of statement.text.matchAll(re)) {
      if (m[1] && m[1].toLowerCase() !== 'public') continue;
      const action = m[3].toUpperCase().replace(/\s+/g, ' ');
      problems.push({
        name: display(m[2].toLowerCase()),
        problem: `${action} on public.${display(m[2].toLowerCase())}: the API roles reach every row of a public table without row-level security; keep it enabled and change the policies instead`,
      });
    }
  }
  return problems;
}

/* --------------------------------------------------------------------- functions --- */

/**
 * Every CREATE FUNCTION / PROCEDURE header and ALTER FUNCTION / PROCEDURE / ROUTINE, as
 * { action, schema, name, signature, definer, searchPath, trigger, statement }.
 */
function functionEvents(analysis) {
  const out = [];
  for (const statement of analysis.statements) {
    const tokens = statement.tokens;
    const header = statement.text;
    for (const i of findSequence(tokens, ['CREATE'])) {
      let j = i + 1;
      if (isWord(tokens[j], 'OR') && isWord(tokens[j + 1], 'REPLACE')) j += 2;
      if (!isWordIn(tokens[j], ['FUNCTION', 'PROCEDURE'])) continue;
      const ref = readName(tokens, j + 1);
      const group = ref && parenGroup(tokens, ref.next);
      if (!group) continue;
      out.push({
        action: 'create',
        schema: ref.schema,
        name: ref.name,
        signature: normalizeSignature(tokensText(group.inner)),
        definer: /\bSECURITY\s+DEFINER\b/i.test(header),
        searchPath: /\bSET\s+search_path\b/i.test(header),
        trigger: /\bRETURNS\s+"?trigger"?(?![a-z0-9_$])/i.test(header),
        statement,
      });
    }
    for (const i of findSequence(tokens, ['ALTER'])) {
      if (!isWordIn(tokens[i + 1], ['FUNCTION', 'PROCEDURE', 'ROUTINE'])) continue;
      const ref = readName(tokens, i + 2);
      if (!ref) continue;
      const group = parenGroup(tokens, ref.next);
      out.push({
        action: 'alter',
        schema: ref.schema,
        name: ref.name,
        signature: group ? normalizeSignature(tokensText(group.inner)) : null,
        definer: /\bSECURITY\s+DEFINER\b/i.test(header),
        searchPath: /\bSET\s+search_path\b/i.test(header),
        trigger: false,
        statement,
      });
    }
  }
  return out;
}

/**
 * Applied migrations that re-create a SECURITY DEFINER function in public without the
 * same-file revoke, from before this rule existed. Each was repaired by a later migration;
 * the names here are exempt in that one file only. Never add a new entry: fix the new file.
 */
const DEFINER_REVOKE_GRANDFATHERED = {
  // 02022 §3 replaced the trigger function; 02024 revokes its EXECUTE from the API roles again.
  '02022_security_hardening_writer_boundary_and_aal.sql': ['handle_new_user'],
};

/** Names of SECURITY DEFINER functions/procedures a migration creates or alters in public. */
function definerFunctionsInPublic(sql) {
  const found = new Set();
  for (const fn of functionEvents(analyse(sql))) if (fn.definer && isPublic(fn.schema)) found.add(fn.name);
  return [...found];
}

/** Definer functions in public, one per name + signature. */
function publicDefiners(analysis) {
  const seen = new Map();
  for (const fn of functionEvents(analysis)) {
    if (!fn.definer || !isPublic(fn.schema)) continue;
    const key = `${fn.name}(${fn.signature})`;
    if (!seen.has(key)) seen.set(key, fn);
  }
  return [...seen.values()];
}

const touchesFunction = (p, fn) =>
  p.kind === 'function' && p.privileges.includes('EXECUTE') && (p.all || p.names.some((n, i) => n === fn.name && sigMatch(p.signatures[i], fn.signature)));

/**
 * SECURITY DEFINER functions a migration creates (or turns into definer) in public without
 * revoking EXECUTE from PUBLIC, anon AND authenticated in the same file, or that the file
 * grants back to one of them. PostgreSQL grants EXECUTE to PUBLIC on every new function and
 * Supabase's default privileges grant it to anon and authenticated by name, so revoking from
 * PUBLIC alone still leaves the function callable over /rpc (Security Advisor lints
 * 0028/0029). A revoke counts only for the same argument types (or no argument list). The
 * house rule is stricter still: no definer function in public at all (put it in schema
 * `private` behind a SECURITY INVOKER wrapper, 02021). Returns [{ name, problem }].
 */
function findUnrevokedDefinerFunctions(sql, { file } = {}) {
  const analysis = analyse(sql);
  const statements = analysis.statements.flatMap(privilegeStatementsOf).filter((p) => !p.defaults);
  const exempt = new Set((file && DEFINER_REVOKE_GRANDFATHERED[file]) || []);
  const problems = [];
  for (const fn of publicDefiners(analysis)) {
    if (exempt.has(fn.name)) continue;
    const label = `public.${display(fn.name)}${sigText(fn.signature)}`;
    const revoked = new Set(
      statements.filter((s) => s.action === 'REVOKE' && s.executes && touchesFunction(s, fn)).flatMap((s) => s.grantees),
    );
    const missing = API_CALLERS.filter((role) => !revoked.has(role));
    if (missing.length > 0) {
      problems.push({
        name: fn.name,
        problem:
          `SECURITY DEFINER function ${label} is created without REVOKE EXECUTE (or ALL) ON FUNCTION ${label} ` +
          `FROM PUBLIC, anon, authenticated in the same file (missing: ${missing.join(', ')}); ` +
          'Postgres grants EXECUTE to PUBLIC and Supabase to anon/authenticated on every new function, so it is callable over /rpc. ' +
          'Prefer schema private + a SECURITY INVOKER wrapper in public (02021)',
      });
    }
    const regranted = statements
      .filter((s) => s.action === 'GRANT' && touchesFunction(s, fn))
      .flatMap((s) => s.grantees)
      .filter((role) => API_CALLERS.includes(role));
    if (regranted.length > 0) {
      problems.push({
        name: fn.name,
        problem: `SECURITY DEFINER function ${label} is granted EXECUTE to ${[...new Set(regranted)].join(', ')}; a definer function in public must stay service-role only`,
      });
    }
  }
  return problems;
}

/**
 * SECURITY DEFINER functions, in any schema, without SET search_path (on the CREATE, or an
 * ALTER of the same function in the file). A definer function resolves unqualified names
 * through the caller's search_path, so a caller who can create objects earlier on that path
 * runs their own code with the owner's rights.
 */
function findDefinerFunctionsWithoutSearchPath(sql) {
  const events = functionEvents(analyse(sql));
  const problems = [];
  const seen = new Set();
  for (const fn of events) {
    if (!fn.definer || fn.searchPath) continue;
    const same = (other) => other.name === fn.name && (other.schema || 'public') === (fn.schema || 'public') && sigMatch(other.signature, fn.signature);
    if (events.some((other) => other.searchPath && same(other))) continue;
    const label = `${display(fn.schema || 'public')}.${display(fn.name)}${sigText(fn.signature)}`;
    if (seen.has(label)) continue;
    seen.add(label);
    problems.push({
      name: fn.name,
      problem: `SECURITY DEFINER function ${label} does not SET search_path; a definer function resolves unqualified names through the caller's search_path (add SET search_path = '' and qualify every name)`,
    });
  }
  return problems;
}

/* ------------------------------------------------------ anon write grants --- */

const WRITE_PRIVILEGES = {
  table: ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'],
  sequence: ['USAGE', 'UPDATE'], // nextval / setval
};

/**
 * Write grants on a public table or sequence to anon (or PUBLIC, which anon inherits),
 * default privileges included. Since 02025 anon is read-only at the grant level: no RLS policy
 * lets anon write, every anonymous write path runs server-side with the service role, and a
 * write grant would leave RLS as the only barrier. Grant SELECT to anon for public-readable
 * tables and the writes to authenticated/service_role. Returns [{ name, problem }].
 */
function findAnonWriteGrants(sql) {
  const problems = [];
  for (const s of privilegeStatements(sql)) {
    if (s.action !== 'GRANT' || !WRITE_PRIVILEGES[s.kind]) continue;
    const roles = s.grantees.filter((g) => g === 'anon' || g === 'public');
    const writes = s.privileges.filter((p) => WRITE_PRIVILEGES[s.kind].includes(p));
    if (roles.length === 0 || writes.length === 0) continue;
    const object = s.defaults
      ? `every future ${s.kind} (ALTER DEFAULT PRIVILEGES)`
      : s.all
        ? `ALL ${s.kind.toUpperCase()}S IN SCHEMA public`
        : s.names.map((n) => `${s.kind === 'sequence' ? 'sequence ' : ''}public.${display(n)}`).join(', ');
    problems.push({
      name: s.all ? '*' : s.names.join(','),
      problem: `grants ${writes.join(', ')} on ${object} to ${roles.join(', ')}; anon is read-only at the grant level since 02025 (grant it SELECT only, and the writes to authenticated, service_role)`,
    });
  }
  return problems;
}

/* ------------------------------------------------------------------------- views --- */

const TRUTHY = /^(?:true|on|yes|1|t|y)$/i;
const FALSY = /^(?:false|off|no|0|f|n)$/i;

/** security_invoker in a reloption list: true, false, or undefined when absent. */
function securityInvoker(optionTokens) {
  for (const option of splitTokens(optionTokens)) {
    if (!identToken(option[0]) || nameOfToken(option[0]) !== 'security_invoker') continue;
    if (option.length === 1) return true;
    const value = option[option.length - 1];
    const text = value.type === 'string' ? value.value : value.text;
    if (TRUTHY.test(text)) return true;
    if (FALSY.test(text)) return false;
    return false;
  }
  return undefined;
}

/**
 * New public views without security_invoker, security_invoker turned off on one, and public
 * materialized views the file does not revoke from anon and authenticated. The post-apply
 * grant pass grants SELECT on ALL TABLES (views and materialized views included) to anon on
 * every deploy; a definer-rights view reads its tables as the owner, past RLS, and a
 * materialized view has no RLS at all.
 */
function findViewProblems(sql) {
  const analysis = analyse(sql);
  const problems = [];
  const invokerSet = new Set();
  for (const statement of analysis.statements) {
    const tokens = statement.tokens;
    for (const i of findSequence(tokens, ['ALTER'])) {
      const isView = isWord(tokens[i + 1], 'VIEW') || isWord(tokens[i + 1], 'TABLE');
      if (!isView) continue;
      let j = i + 2;
      if (isWord(tokens[j], 'IF') && isWord(tokens[j + 1], 'EXISTS')) j += 2;
      if (isWord(tokens[j], 'ONLY')) j += 1;
      const ref = readName(tokens, j);
      if (!ref || !isPublic(ref.schema)) continue;
      for (let k = ref.next; k < tokens.length; k += 1) {
        if (isWordIn(tokens[k], ['SET', 'RESET']) && isOp(tokens[k + 1], '(')) {
          const group = parenGroup(tokens, k + 1);
          if (!group) continue;
          if (isWord(tokens[k], 'RESET')) {
            if (group.inner.some((t) => identToken(t) && nameOfToken(t) === 'security_invoker')) {
              problems.push({
                name: display(ref.name),
                problem: `resets security_invoker on public.${display(ref.name)} (back to false): the view then reads its tables with its owner's rights, past RLS, and the grant pass gives anon SELECT on it`,
              });
            }
            continue;
          }
          const value = securityInvoker(group.inner);
          if (value === true && statement.region.executes) invokerSet.add(ref.name);
          if (value === false) {
            problems.push({
              name: display(ref.name),
              problem: `sets security_invoker = false on public.${display(ref.name)}: the view then reads its tables with its owner's rights, past RLS, and the grant pass gives anon SELECT on it`,
            });
          }
        }
      }
    }
  }
  const revokes = executingPrivileges(analysis).filter((p) => p.action === 'REVOKE' && p.kind === 'table');
  for (const object of publicCreated(analysis)) {
    const name = display(object.name);
    if (object.kind === 'VIEW') {
      const tokens = object.statement.tokens;
      let j = object.after;
      if (isOp(tokens[j], '(') && !isWord(tokens[j - 1], 'WITH')) j = parenGroup(tokens, j)?.next ?? j;
      const options = isWord(tokens[j], 'WITH') ? parenGroup(tokens, j + 1) : null;
      const value = options ? securityInvoker(options.inner) : undefined;
      if (value === false) {
        problems.push({
          name,
          problem: `creates view public.${name} WITH (security_invoker = false): the view reads its tables with its owner's rights, past RLS, and the grant pass gives anon SELECT on it`,
        });
      } else if (value === undefined && !invokerSet.has(object.name)) {
        problems.push({
          name,
          problem: `view public.${name} is created without WITH (security_invoker = true): a view runs with its owner's rights and reads its tables past RLS, and the post-apply grant pass grants SELECT on every view to anon`,
        });
      }
    } else if (object.kind === 'MATERIALIZED VIEW') {
      const revokedFrom = (role) =>
        revokes.some((p) => (p.all || p.names.includes(object.name)) && p.grantees.includes(role) && p.privileges.includes('SELECT'));
      const missing = ['anon', 'authenticated'].filter((role) => !revokedFrom(role));
      if (missing.length > 0) {
        problems.push({
          name,
          problem:
            `materialized view public.${name} is created without REVOKE ALL ON public.${name} FROM PUBLIC, anon, authenticated in the same file (missing: ${missing.join(', ')}): ` +
            `a materialized view has no RLS and the post-apply grant pass grants SELECT on it to anon on every deploy; revoke it here and add the revoke to ${REVOKE_LIST_HINT} (or put it outside public)`,
        });
      }
    }
  }
  return problems;
}

/* ---------------------------------------------------------------------- policies --- */

/**
 * Tables every visitor may read in full: site chrome and reference data with no draft state.
 * A forward migration may give them a constant SELECT policy for anon/authenticated. Catalog
 * tables (products, media, categories, variants, stock) are not here: their drafts and
 * children stay staff-only.
 */
const PUBLIC_READ_TABLES = new Map([
  ['languages', 'site languages, read by every page'],
  ['translations', 'UI copy, read by every page'],
  ['navigation_items', 'site navigation chrome'],
  ['logos', 'site branding'],
  ['site_themes', 'theme tokens the public site renders'],
  ['custom_block_definitions', 'block layouts the public renderer reads'],
  ['currencies', 'storefront currency list'],
  ['tax_rates', 'checkout tax reference data'],
  ['shipping_zones', 'checkout shipping reference data'],
  ['shipping_zone_locations', 'checkout shipping reference data'],
  ['shipping_zone_methods', 'checkout shipping reference data'],
  ['product_attributes', 'storefront attribute names'],
  ['product_attribute_terms', 'storefront attribute values'],
  ['freemius_plans', 'public pricing plans'],
  ['freemius_pricing', 'public plan prices'],
]);

const CONSTANT_WORDS = new Set(['TRUE', 'FALSE', 'NULL', 'AND', 'OR', 'NOT', 'IS', 'UNKNOWN']);

/** A predicate made only of literals and boolean operators: no column, function or subquery. */
function isConstantPredicate(tokens) {
  if (!tokens || tokens.length === 0) return false;
  const values = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'op') {
      if ('()=<>!:'.includes(t.text)) continue;
      return false;
    }
    if (t.type === 'number' || t.type === 'string') {
      values.push(t);
      continue;
    }
    if (t.type === 'word' && CONSTANT_WORDS.has(t.upper)) {
      values.push(t);
      continue;
    }
    if (identToken(t) && isOp(tokens[i - 1], ':') && isOp(tokens[i - 2], ':')) continue; // 't'::boolean
    return false;
  }
  if (values.length === 1 && isWordIn(values[0], ['FALSE', 'NULL'])) return false;
  return values.length > 0;
}

/**
 * Permissive policies (CREATE or ALTER) on a public table that apply to anon, authenticated,
 * PUBLIC or every role (no TO clause), with a constant USING or WITH CHECK: that publishes or
 * opens the table to the public key. A constant read of a PUBLIC_READ_TABLES table is fine.
 */
function findPolicyProblems(sql) {
  const problems = [];
  for (const statement of analyse(sql).statements) {
    const tokens = statement.tokens;
    const heads = [...findSequence(tokens, ['CREATE', 'POLICY']), ...findSequence(tokens, ['ALTER', 'POLICY'])].sort((a, b) => a - b);
    for (const i of heads) {
      const create = isWord(tokens[i], 'CREATE');
      const policy = identToken(tokens[i + 2]) ? display(nameOfToken(tokens[i + 2])) : '?';
      if (!isWord(tokens[i + 3], 'ON')) continue;
      const table = readName(tokens, i + 4);
      if (!table || !isPublic(table.schema)) continue;
      let restrictive = false;
      let command = 'ALL';
      let roles = null;
      let using = null;
      let check = null;
      let rename = false;
      let j = table.next;
      while (j < tokens.length && !(isWord(tokens[j], 'CREATE') || isWord(tokens[j], 'ALTER'))) {
        const t = tokens[j];
        if (isWord(t, 'AS') && identToken(tokens[j + 1])) {
          restrictive = isWord(tokens[j + 1], 'RESTRICTIVE');
          j += 2;
        } else if (isWord(t, 'FOR') && tokens[j + 1]) {
          command = String(tokens[j + 1].upper || tokens[j + 1].text).toUpperCase();
          j += 2;
        } else if (isWord(t, 'TO')) {
          roles = [];
          j += 1;
          while (identToken(tokens[j]) && !isWordIn(tokens[j], ['USING', 'WITH'])) {
            roles.push(nameOfToken(tokens[j]));
            j += 1;
            if (!isOp(tokens[j], ',')) break;
            j += 1;
          }
        } else if (isWord(t, 'RENAME')) {
          rename = true;
          break;
        } else if (isWord(t, 'USING')) {
          const group = parenGroup(tokens, j + 1);
          using = group ? group.inner : [];
          j = group ? group.next : j + 1;
        } else if (isWord(t, 'WITH') && isWord(tokens[j + 1], 'CHECK')) {
          const group = parenGroup(tokens, j + 2);
          check = group ? group.inner : [];
          j = group ? group.next : j + 2;
        } else j += 1;
      }
      if (rename || restrictive) continue;
      const exposed = roles === null ? ['every role (no TO clause), anon included'] : roles.filter((r) => API_CALLERS.includes(r));
      if (exposed.length === 0) continue;
      const constants = [];
      if (isConstantPredicate(using)) constants.push(`USING (${tokensText(using)})`);
      if (isConstantPredicate(check)) constants.push(`WITH CHECK (${tokensText(check)})`);
      if (constants.length === 0) continue;
      if (create && command === 'SELECT' && PUBLIC_READ_TABLES.has(table.name) && check === null) continue;
      problems.push({
        name: display(table.name),
        problem:
          `policy ${policy} on public.${display(table.name)} gives ${exposed.join(', ')} a constant ${constants.join(' and ')} for ${command}: ` +
          'that is every row to anyone holding the public key; name the roles (TO authenticated) and write the real predicate',
      });
    }
  }
  return problems;
}

/* ---------------------------------------- objects that reach public around the lint --- */

/**
 * Top-level SELECT ... INTO <table> (and the same inside an EXECUTE template) creates a table
 * the grant/RLS checks never see; SET SCHEMA public moves one in after them. In plpgsql
 * bodies SELECT ... INTO assigns variables and is fine.
 */
function findObjectsMovedIntoPublic(sql) {
  const problems = [];
  for (const statement of analyse(sql).statements) {
    const tokens = statement.tokens;
    if ((statement.region.kind === 'top' || statement.region.kind === 'dynamic') && isWordIn(tokens[0], ['SELECT', 'WITH'])) {
      let depth = 0;
      for (let i = 0; i < tokens.length; i += 1) {
        if (isOp(tokens[i], '(')) depth += 1;
        else if (isOp(tokens[i], ')')) depth -= 1;
        if (depth !== 0 || !isWord(tokens[i], 'INTO')) continue;
        let j = i + 1;
        let temp = false;
        while (isWordIn(tokens[j], ['TEMP', 'TEMPORARY', 'UNLOGGED', 'TABLE'])) {
          if (isWordIn(tokens[j], ['TEMP', 'TEMPORARY'])) temp = true;
          j += 1;
        }
        const ref = readName(tokens, j);
        if (temp || !ref || !isPublic(ref.schema)) break;
        problems.push({
          name: display(ref.name),
          problem: `SELECT ... INTO creates public.${display(ref.name)} with no grant, RLS or policy review; use CREATE TABLE ... AS (with its GRANT and ENABLE ROW LEVEL SECURITY) or a TEMP table`,
        });
        break;
      }
    }
    if (/\bALTER\b[^;]*\bSET\s+SCHEMA\s+(?:"public"|public)(?![a-z0-9_$])/i.test(statement.text)) {
      problems.push({
        name: '',
        problem: `${statement.text.trim().split(/\s+/).slice(0, 4).join(' ')} ... SET SCHEMA public moves an object into public past the grant, RLS and definer checks; create it in public instead`,
      });
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ role escalation --- */

const ROLE_OPTIONS_RE = /\bWITH\s+(?:ADMIN|INHERIT|SET)\s+(?:OPTION|TRUE|FALSE)\b|\bGRANTED\s+BY\s+\S+/gi;

/**
 * Role membership handed to an API role (GRANT role TO anon, CREATE ROLE x ROLE anon, ALTER
 * GROUP x ADD USER anon: anon then holds every privilege of x), BYPASSRLS or SUPERUSER on any
 * role, and CREATE on schema public for an API role.
 */
function findRoleEscalation(sql) {
  const problems = [];
  const apiIn = (list) => list.filter((r) => API_CALLERS.includes(r));
  const names = (text) =>
    text
      .replace(ROLE_OPTIONS_RE, '')
      .split(',')
      .map((g) => g.trim().replace(/^"|"$/g, '').toLowerCase())
      .filter(Boolean);
  for (const statement of analyse(sql).statements) {
    const text = statement.text;
    for (const m of text.matchAll(/\bGRANT\s+([^;]*?)\s+TO\s+([^;]*)/gi)) {
      if (/\bON\b/i.test(m[1])) continue; // an object privilege
      const granted = apiIn(names(m[2]));
      if (granted.length === 0) continue;
      problems.push({
        name: m[1].trim(),
        problem: `grants role ${m[1].trim()} to ${granted.join(', ')}: an API role then holds every privilege of that role; grant object privileges instead`,
      });
    }
    const tokens = statement.tokens;
    for (const i of findSequence(tokens, ['CREATE'])) {
      if (!isWordIn(tokens[i + 1], ['ROLE', 'USER', 'GROUP'])) continue;
      for (let j = i + 3; j < tokens.length; j += 1) {
        if (!isWordIn(tokens[j], ['ROLE', 'USER', 'ADMIN']) || isWord(tokens[j - 1], 'IN')) continue;
        const members = [];
        for (let k = j + 1; identToken(tokens[k]); k += 2) {
          members.push(nameOfToken(tokens[k]));
          if (!isOp(tokens[k + 1], ',')) break;
        }
        const granted = apiIn(members);
        if (granted.length > 0) {
          problems.push({ name: '', problem: `CREATE ROLE ... ${tokens[j].upper} ${granted.join(', ')} makes an API role a member of the new role` });
        }
      }
    }
    const group = /\bALTER\s+GROUP\s+\S+\s+ADD\s+USER\s+([^;]*)/i.exec(text);
    if (group && apiIn(names(group[1])).length > 0) {
      problems.push({ name: '', problem: `ALTER GROUP ... ADD USER ${apiIn(names(group[1])).join(', ')} makes an API role a member of another role` });
    }
    const attribute = /\b(?:CREATE|ALTER)\s+(?:ROLE|USER|GROUP)\b[^;]*?\b(BYPASSRLS|SUPERUSER)\b/i.exec(text);
    if (attribute) {
      problems.push({ name: '', problem: `${attribute[1].toUpperCase()} on a role: it reads and writes past every RLS policy; use the service role server-side instead` });
    }
    for (const m of text.matchAll(/\bGRANT\s+([^;]*?)\s+ON\s+SCHEMA\s+([^;]*?)\s+TO\s+([^;]*)/gi)) {
      const privileges = splitTopLevel(m[1]).map((p) => p.toUpperCase());
      if (!privileges.some((p) => p === 'CREATE' || /^ALL\b/.test(p))) continue;
      if (!splitTopLevel(m[2]).some((s) => s.replace(/"/g, '').toLowerCase() === 'public')) continue;
      const granted = apiIn(names(m[3]));
      if (granted.length === 0) continue;
      problems.push({
        name: 'public',
        problem: `grants CREATE on schema public to ${granted.join(', ')}: an API role could create tables, views and functions it owns, outside every grant and RLS rule`,
      });
    }
  }
  return problems;
}

/* --------------------------------------------------------------------- dynamic SQL --- */

const REVIEWED_MARKER_RE = /nb-lint:\s*dynamic-sql\s+reviewed\s*:\s*\S.{2,}/i;

/** EXECUTE of a statement the lint cannot read (a variable, a format() with a variable template). */
function findUnreadableDynamicSql(sql) {
  const problems = [];
  for (const statement of analyse(sql).statements) {
    if (!statement.opaqueExecute || statement.comments.some((c) => REVIEWED_MARKER_RE.test(c))) continue;
    problems.push({
      name: '',
      problem:
        `EXECUTE of a non-literal statement (${statement.text.trim().replace(/\s+/g, ' ').slice(0, 80)}): the lint cannot read it. ` +
        "Build it with format('<literal template>', ...) so the template is linted, or put " +
        '`-- nb-lint: dynamic-sql reviewed: <why it is safe>` on the line above it',
    });
  }
  return problems;
}

/* ----------------------------------- revokes the post-apply grant pass undoes --- */

/** The object a to_regclass / to_regprocedure guard names, as { relation, name, schema, signature }. */
function parseGuard(guard) {
  let tokens;
  try {
    tokens = lex(guard.literal).filter(isSignificant);
  } catch {
    return null;
  }
  const raw = (t) => Boolean(t) && (t.type === 'word' || t.type === 'qident');
  const rawName = (t) => (t.type === 'qident' ? encodeIdent(t.value) : t.text.toLowerCase());
  if (!raw(tokens[0])) return null;
  let schema = null;
  let name = rawName(tokens[0]);
  let i = 1;
  if (isOp(tokens[1], '.') && raw(tokens[2])) {
    schema = name;
    name = rawName(tokens[2]);
    i = 3;
  }
  let signature = null;
  if (isOp(tokens[i], '(')) {
    const close = guard.literal.lastIndexOf(')');
    signature = normalizeSignature(guard.literal.slice(guard.literal.indexOf('(') + 1, close));
  }
  return { relation: guard.fn === 'to_regclass', schema, name, signature };
}

function guardMatches(guard, p) {
  if (!guard) return true;
  if (!isPublic(guard.schema) || p.all) return false;
  if (guard.relation) return (p.kind === 'table' || p.kind === 'sequence') && p.names.every((n) => n === guard.name);
  return p.kind === 'function' && p.names.every((n, i) => n === guard.name && sigMatch(p.signatures[i], guard.signature));
}

/** Guarded statements of the grant pass that touch something else than their guard names. */
function checkGuards(analysis) {
  const problems = [];
  const bad = new Set();
  for (const statement of analysis.statements) {
    if (!statement.guard || !statement.region.executes) continue;
    const guard = parseGuard(statement.guard);
    for (const p of privilegeStatementsOf(statement)) {
      if (guardMatches(guard, p)) continue;
      bad.add(statement);
      const targets = p.all ? describeTarget(p.kind, '*') : p.names.map((n, i) => describeTarget(p.kind, n, p.signatures[i])).join(', ');
      problems.push(
        `guard ${statement.guard.fn}('${statement.guard.literal}') does not name ${targets}, which the ${p.action.toLowerCase()} inside it targets: ` +
          'on a database that has the object the statement touches but not the one the guard checks, it never runs',
      );
    }
  }
  return { problems, bad };
}

/** Problems with the to_regclass / to_regprocedure guards of a grant pass (GRANTS_SQL). */
function grantPassGuardProblems(grantPassSql) {
  return checkGuards(analyse(grantPassSql)).problems;
}

/** The pass's privilege statements that run as written (a mismatched guard runs nothing useful). */
function passPrivileges(grantPassSql) {
  const analysis = analyse(grantPassSql);
  const { problems, bad } = checkGuards(analysis);
  const statements = analysis.statements.filter((s) => s.region.executes && !bad.has(s)).flatMap(privilegeStatementsOf).filter((p) => !p.defaults);
  return { statements, guardProblems: problems };
}

/**
 * Whether pass statement `p` applies to `target` ({ all, name, signature, dynamic, context }).
 * A dynamic statement's object is unknown (%I, %s): it matches only the same statement in the
 * same block, the way 02024 repeats the pass's trigger-function loop.
 */
function passCovers(p, kind, target, role) {
  if (p.kind !== kind || !p.grantees.includes(role)) return false;
  if (p.all) return true;
  if (target.all) return false;
  return p.names.some((n, i) => {
    if (isWildName(n) || isWildName(target.name)) {
      return n === target.name && p.dynamic && target.dynamic && p.context === target.context;
    }
    return n === target.name && sigMatch(p.signatures[i], target.signature);
  });
}

function forwardAnalyses(files, readFile, problems) {
  const all = [];
  for (const file of files) {
    if (!parseMigrationName(file)) continue;
    try {
      all.push({ file, analysis: analyse(readFile(file)) });
    } catch (error) {
      if (!(error instanceof SqlSyncError)) throw error;
      problems.push({ file, problem: `${file}: could not tokenize: ${error.message}` });
    }
  }
  return all;
}

/**
 * What the post-apply grant pass (GRANTS_SQL in apps/nextblock/tools/lib/migrate-core.mjs and
 * lib/setup/schema-apply.ts) leaves in place of a revoke a forward migration makes. That pass
 * runs blanket GRANTs on every deploy and /setup apply, then its own revokes; a migration that
 * takes a privilege from anon/authenticated which the blanket GRANTs hand back, and which the
 * pass does not revoke again, is silently undone on the next deploy. That is how 02022's
 * service-role-only cortex_request_log was re-granted until 02025. Functions are matched by
 * argument types; a pass revoke behind a guard that names another object does not count (and
 * is reported). Returns [{ file, problem }].
 *
 * `files` is the full migration listing (the baseline is read for trigger-function names: the
 * pass revokes EXECUTE on every trigger function itself), `readFile(name)` returns the SQL,
 * and `grantPassSql` is GRANTS_SQL.
 */
function findRevokesUndoneByGrantPass(files, readFile, grantPassSql) {
  const { statements: pass, guardProblems } = passPrivileges(grantPassSql);
  const passRevokesTriggers = /\bt\.typname\s*=\s*'trigger'/.test(grantPassSql);
  const problems = guardProblems.map((problem) => ({ file: 'GRANTS_SQL', problem: `GRANTS_SQL: ${problem}` }));
  const triggerFunctions = new Set();
  const migrations = [];
  for (const { file, analysis } of forwardAnalyses(files, readFile, problems)) {
    for (const fn of functionEvents(analysis)) if (fn.action === 'create' && fn.trigger && isPublic(fn.schema)) triggerFunctions.add(fn.name);
    if (!isCatchupMigration(file) && !isBaselineMigration(file)) migrations.push({ file, analysis });
  }

  const privilegesOf = (action, kind, target, role) =>
    new Set(pass.filter((p) => p.action === action && passCovers(p, kind, target, role)).flatMap((p) => p.privileges));

  for (const { file, analysis } of migrations) {
    for (const s of executingPrivileges(analysis)) {
      if (s.action !== 'REVOKE') continue;
      for (const role of s.grantees.filter((g) => g === 'anon' || g === 'authenticated')) {
        const targets = s.all ? [{ all: true, name: '*', signature: null }] : s.names.map((name, i) => ({ all: false, name, signature: s.signatures[i] }));
        for (const target of targets) {
          Object.assign(target, { dynamic: s.dynamic, context: s.context });
          if (s.kind === 'function' && !target.all && !isWildName(target.name) && passRevokesTriggers && triggerFunctions.has(target.name)) continue;
          const handedBack = privilegesOf('GRANT', s.kind, target, role);
          const again = privilegesOf('REVOKE', s.kind, target, role);
          const lost = s.privileges.filter((p) => handedBack.has(p) && !again.has(p));
          if (lost.length === 0) continue;
          problems.push({
            file,
            problem:
              `${file}: revokes ${lost.join(', ')} on ${describeTarget(s.kind, target.name, target.signature)} from ${role}, but the post-apply grant pass grants it back on every deploy; ` +
              `add the revoke to ${REVOKE_LIST_HINT}`,
          });
        }
      }
    }
  }
  return problems;
}

/* ------------------------------- new objects the post-apply grant pass widens --- */

const RELATION_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const GRANT_PASS_ROLES = ['anon', 'authenticated'];

/** Apply table-kind GRANT/REVOKE statements on `name` to a { role: Set } privilege map. */
function applyTableStatements(state, statements, name) {
  for (const s of statements) {
    if (s.kind !== 'table' || !(s.all || s.names.includes(name))) continue;
    for (const role of s.grantees) {
      if (!(role in state)) continue;
      for (const p of s.privileges) {
        if (s.action === 'GRANT') state[role].add(p);
        else state[role].delete(p);
      }
    }
  }
}

/** What a role can do: its own grants plus PUBLIC's. */
function effective(state, role) {
  return new Set([...state[role], ...state.public]);
}

/**
 * Tables and views a forward migration creates with narrower grants than the post-apply grant
 * pass leaves them. That pass (GRANTS_SQL) runs `grant select on all tables ... to anon` and
 * `grant all on all tables ... to authenticated` on every deploy and /setup apply, then only
 * the revokes it lists; a table a migration grants to service_role alone, or a view it grants
 * to authenticated alone, comes out of the next deploy readable by anon and writable by
 * authenticated, with RLS as the only barrier. findRevokesUndoneByGrantPass() cannot see this:
 * nothing was revoked. The intended grants are the ones the creating file makes after its
 * CREATE plus every GRANT/REVOKE on the object in later forward migrations; compared on
 * SELECT/INSERT/UPDATE/DELETE (the pass revokes TRUNCATE, REFERENCES and TRIGGER itself).
 * Sequences are left out: the pass grants them to both roles by design. Returns
 * [{ file, problem }].
 */
function findGrantsWidenedByGrantPass(files, readFile, grantPassSql) {
  const problems = [];
  const { statements: pass } = passPrivileges(grantPassSql);
  const migrations = forwardAnalyses(files, readFile, problems).filter(
    ({ file }) => !isCatchupMigration(file) && !isBaselineMigration(file),
  );

  const seen = new Set();
  migrations.forEach(({ file, analysis }, index) => {
    for (const object of publicCreated(analysis)) {
      if (grantKind(object.kind) !== 'TABLE') continue;
      const name = object.name;
      if (seen.has(name)) continue;
      seen.add(name);

      const intended = { anon: new Set(), authenticated: new Set(), public: new Set() };
      const after = analysis.statements.slice(object.index).filter((s) => s.region.executes);
      applyTableStatements(intended, after.flatMap(privilegeStatementsOf).filter((p) => !p.defaults), name);
      for (const later of migrations.slice(index + 1)) {
        applyTableStatements(intended, executingPrivileges(later.analysis), name);
      }
      const deployed = {
        anon: new Set(intended.anon),
        authenticated: new Set(intended.authenticated),
        public: new Set(intended.public),
      };
      applyTableStatements(deployed, pass, name);

      for (const role of GRANT_PASS_ROLES) {
        const wanted = effective(intended, role);
        const extra = RELATION_PRIVILEGES.filter((p) => effective(deployed, role).has(p) && !wanted.has(p));
        if (extra.length === 0) continue;
        problems.push({
          file,
          problem:
            `${file}: creates ${describe(object.kind)} public.${display(name)} without granting ${extra.join(', ')} to ${role}, ` +
            `but the post-apply grant pass grants it on every deploy; add \`revoke ${extra.join(', ').toLowerCase()} on table public.${display(name)} from ${role}\` ` +
            'to API_ROLE_REVOKE_SQL in BOTH apps/nextblock/tools/lib/migrate-core.mjs and apps/nextblock/lib/setup/schema-apply.ts ' +
            '(or grant it in the migration if the role should have it)',
        });
      }
    }
  });
  return problems;
}

/* ------------------------------------------------------------------------- lint --- */

/**
 * Lint every forward migration (sequence >= 005) in a directory listing. The catch-up and
 * the baseline are the generation's own business. `readFile(name)` returns the SQL. A file
 * the tokenizer cannot read is one error and no other check.
 */
function validateMigrationGrants(files, readFile) {
  const errors = [];
  for (const file of files) {
    if (!parseMigrationName(file) || isCatchupMigration(file) || isBaselineMigration(file)) continue;
    const sql = readFile(file);
    try {
      analyse(sql);
    } catch (error) {
      if (!(error instanceof SqlSyncError)) throw error;
      errors.push(`${file}: could not tokenize: ${error.message}; the lint cannot read this file, so it refuses it`);
      continue;
    }
    const checks = [
      findUngrantedObjects,
      findTablesWithoutRls,
      findRowSecurityProblems,
      (s) => findUnrevokedDefinerFunctions(s, { file }),
      findDefinerFunctionsWithoutSearchPath,
      findAnonWriteGrants,
      findViewProblems,
      findPolicyProblems,
      findObjectsMovedIntoPublic,
      findRoleEscalation,
      findUnreadableDynamicSql,
    ];
    for (const check of checks) {
      for (const problem of check(sql)) errors.push(`${file}: ${problem.problem}`);
    }
  }
  return { errors };
}

module.exports = {
  CREATE_RE,
  PUBLIC_READ_TABLES,
  SqlSyncError,
  analyse,
  codeOnly,
  definerFunctionsInPublic,
  findAnonWriteGrants,
  findDefinerFunctionsWithoutSearchPath,
  findGrantsWidenedByGrantPass,
  findObjectsMovedIntoPublic,
  findPolicyProblems,
  findRevokesUndoneByGrantPass,
  findRoleEscalation,
  findRowSecurityProblems,
  findTablesWithoutRls,
  findUngrantedObjects,
  findUnreadableDynamicSql,
  findUnrevokedDefinerFunctions,
  findViewProblems,
  grantPassGuardProblems,
  normalizeSignature,
  privilegeStatements,
  validateMigrationGrants,
};
