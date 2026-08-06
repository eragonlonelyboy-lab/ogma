// The Ogham schema — constants and validators.
// Zero-LLM, zero-dependency. Everything OGMA writes is validated here,
// and the gate re-validates it before anything is called done.
// Validators REPORT, never throw: hostile-shaped input (null, wrong types,
// object-instead-of-array) must come back as errors, not exceptions.
'use strict';

const crypto = require('crypto');

const OGHAM_VERSION = 1;
const CONFIG_VERSION = 1; // independent of OGHAM_VERSION; both happen to be 1
const GRAPH_VERSION = 1;  // graph/index.json format; independent of both

const CLASSIFICATIONS = ['LIVE', 'DEAD', 'HALF-BUILT', 'UNCLEAR'];
const FACT_KINDS = ['behavior', 'rule', 'limit', 'state', 'integration'];
const LEDGER_STATUSES = ['open', 'answered', 'wont-fix'];
const WITNESS_VERDICTS = ['CONFIRMED', 'REFUTED', 'UNSUPPORTED'];
const GATE_CHECKS = [
  'coverage', 'receipts', 'witness', 'leaklint', 'complete',
  'ledger', 'orphans', 'readability', 'integrity'
];
const DESTINATION_KINDS = [null, 'markdown-only', 'confluence', 'notion', 'jira'];

// Surfaces. Only the interactive kinds get user guides; a worker or a service
// has no user to click anything, and the certificate records the exemption
// rather than counting it as missing coverage.
const SURFACE_KINDS = ['frontend', 'admin-web', 'worker', 'service'];
const INTERACTIVE_SURFACE_KINDS = ['frontend', 'admin-web'];

// The three audiences the Ogham renders for. Only `tech` sees doubtful facts.
const AUDIENCES = ['prd', 'tech', 'guides'];

// ID grammar for features, facts, questions, modules and surfaces.
const ID_GRAMMAR = /^[A-Za-z0-9-]+$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Rendered documents live under .ogma/out/ and are always markdown.
const OUT_DOC = /^[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)*\.md$/;

// Canonical-form tag for the witness input hash. Bump it if the canonical form
// ever changes, so old rulings fail the gate instead of silently matching.
// v2: v1 joined its components with a bare "--" separator line, which repo
// content could forge. v2 length-prefixes every component. The tag is inside
// the hashed input on purpose, so any ruling written under v1 fails loudly at
// the gate instead of matching by accident.
const WITNESS_HASH_VERSION = 'ogma-witness-v2';

// Receipt line drift tolerance when re-verifying citations (±N lines).
// Assumption, untested against real refactor diffs; tune when Batch 2 lands.
const RECEIPT_DRIFT_WINDOW = 5;

// Hard caps. Ogham files are machine-written; anything past these is not data,
// it is an accident or an attack.
const MAX_PATH_LENGTH = 4096;
const MAX_SYMBOL_LENGTH = 200;
const MAX_TEXT_LENGTH = 4000;
const MAX_LINE = 10000000;
const MAX_ARRAY = 10000;

// Base banned-vocabulary list for the leak lint: terms that must never reach
// business or guide output. config.leaklint_extra ADDS to this list.
// Matching: case-insensitive, word-boundary; inline code spans are exempt.
const LEAKLINT_BASE = [
  'endpoint', 'api', 'dto', 'schema', 'middleware', 'controller', 'service layer',
  'repository', 'database', 'sql', 'query', 'backend', 'frontend', 'payload',
  'json', 'http', 'request', 'response', 'callback', 'webhook', 'queue',
  'cache', 'token', 'jwt', 'oauth', 'cron', 'microservice', 'orm', 'entity',
  'migration', 'deployment', 'refactor', 'runtime', 'framework', 'dependency'
];

// Classification severity, least to most doubtful. A feature's classification
// is the worst (highest severity) among the facts it owns.
const SEVERITY = Object.assign(Object.create(null), { 'LIVE': 0, 'DEAD': 1, 'HALF-BUILT': 2, 'UNCLEAR': 3 });

// Commit-ish fields end up in git argv. Hex only: a value like "--output=x"
// would sit in an option position and let git create or truncate a file.
const COMMITISH = /^[0-9a-f]{7,64}$/;

// Path segments are checked by a DENY-list, and that choice is the whole point.
// An allow-list of "portable" characters reads safer and is worse: it makes
// entire ecosystems uncitable — app/[id]/page.tsx, src/routes/+page.svelte,
// app/(marketing)/layout.tsx, packages/@scope/pkg, any name carrying a space or
// a non-ASCII letter. A file OGMA cannot cite is a file OGMA silently fails to
// document while the certificate still reads PASS, which is the worst failure
// this product has. So the rule rejects only what is actually dangerous:
//   - control bytes and bidi overrides (terminal spoofing, path spoofing)
//   - characters git or win32 read as syntax rather than as a name
//   - backslash (win32 separator smuggled through a POSIX-shaped string)
// Deliberately NOT rejected: win32 reserved device names (CON, NUL, COM1).
// OGMA reads only through `git show <commit>:<path>` and never opens the
// working-tree file, so those are ordinary names here.
const SEGMENT_DENY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:\"|?*\\]/;

// Citations may never point at version control or OGMA's own state — at ANY
// depth (a vendored dependency carries its own .git) and in ANY case (win32 and
// macOS filesystems are case-insensitive, so ".GIT" reaches the same directory).
const FORBIDDEN_SEGMENTS = ['.git', '.ogma'];

// Attacker-controlled text (ids, classifications, verdicts) is echoed back in
// error strings that land on a terminal. Escaped as \xNN, never emitted raw:
// an ESC + erase-line + CR sequence inside an id can otherwise repaint the line
// and make a validator error read as a passing verdict. The banned bytes are
// written here as escape sequences so this rule can never match its own source.
function safe(v, max = 120) {
  // String(v) is not total: an object whose toString and valueOf are both
  // non-callable makes it throw, and JSON.parse can produce exactly that
  // ({"id":{"toString":1,"valueOf":2}}). This function is called from inside
  // validators whose contract is to report and never throw, so it must not be
  // the thing that throws.
  let s;
  if (typeof v === 'string') s = v;
  else {
    try { s = String(v); } catch { s = `[unstringifiable ${typeof v}]`; }
  }
  if (s.length > max) {
    s = s.slice(0, max);
    // Never cut a surrogate pair in half: a lone surrogate is not valid text
    // and corrupts whatever reads the error afterwards.
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    s += '...';
  }
  return s.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    ch => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
}

// Cap on collected errors: a hostile module file can otherwise amplify a few MB
// of input into hundreds of thousands of attacker-text-bearing strings.
const MAX_ERRORS = 500;

// Fails CLOSED: an unknown classification is an error, never "least severe".
// Two independent guards, because either one alone has a way to go wrong.
// First, membership is tested against CLASSIFICATIONS: a bare `in SEVERITY`
// would be a lookup, not a validation. Second, SEVERITY is built on a null
// prototype, so even if a lookup were ever used, a key like "toString" cannot
// resolve to an inherited function and rank as LIVE — the one value that
// reaches business readers.
function worstClassification(classifications) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw new Error('worstClassification: empty or non-array input');
  }
  let worst = 'LIVE';
  for (const c of classifications) {
    if (!CLASSIFICATIONS.includes(c)) throw new Error(`worstClassification: unknown classification "${safe(c, 40)}"`);
    if (SEVERITY[c] > SEVERITY[worst]) worst = c;
  }
  return worst;
}

function isNonEmptyString(v, max = MAX_TEXT_LENGTH) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Repo-relative POSIX path, contained. Rejects the traversal/absolute/UNC/
// drive-letter/NUL shapes that would let a citation walk out of the repo.
function isSafeRepoPath(p) {
  if (!isNonEmptyString(p, MAX_PATH_LENGTH)) return false;
  if (p.includes('\u0000') || p.includes('\\')) return false;
  if (p.startsWith('/')) return false;                    // absolute, and UNC "//server/share"
  if (/^[A-Za-z]:/.test(p)) return false;                 // drive letter
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return false; // empty (leading, trailing, "//") and traversal
    if (SEGMENT_DENY.test(s)) return false;
    if (s.startsWith('-')) return false;                   // argv option position
    if (/[. ]$/.test(s)) return false;                     // win32 strips these: two paths, one file
    if (FORBIDDEN_SEGMENTS.includes(s.toLowerCase())) return false;
  }
  return true;
}

// "." names the repo root itself. Surface and module roots accept it because
// a single-app repo IS its own surface: rejecting "." would force a fake
// subdirectory root on the most common repo shape there is. Receipt paths do
// NOT accept it — a citation names a file, and "." is never a file.
function isSafeRepoPathOrDot(p) {
  return p === '.' || isSafeRepoPath(p);
}

// One id rule for every id in the Ogham. It was enforced on terrain and raised
// ids and skipped on facts, features and ledger questions, which read as an
// oversight because it was one.
function isValidId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && ID_GRAMMAR.test(v);
}

function isCommitish(v) {
  return typeof v === 'string' && COMMITISH.test(v);
}

// Two commit-ish values naming the same commit. Git abbreviates, so one commit
// legitimately appears as a 7-char id in one field and a 40-char id in another;
// exact string equality would report false staleness on every such pair. Both
// sides must clear isCommitish first, so this never compares free text.
function sameCommit(a, b) {
  if (!isCommitish(a) || !isCommitish(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short);
}

// Is this Ogham describing the repo as it stands right now? Without this check
// a months-old Ogham certifies PASS: every fact is internally consistent, every
// receipt verifies against the commit it was written at, and nothing anywhere
// compares that commit to the repo's HEAD. The gate calls this and fails the
// `integrity` check when it returns false.
function oghamIsBound(cutoffCommit, headCommit) {
  return sameCommit(cutoffCommit, headCommit);
}

// Which facts an audience may see. One rule, in one place, executable. The
// prose used to say "non-LIVE is excluded" in one paragraph and "DEAD is
// excluded" in another, which describes two different products.
function rendersTo(fact, audience) {
  if (!isObject(fact) || !AUDIENCES.includes(audience)) return false;
  if (!CLASSIFICATIONS.includes(fact.classification)) return false;   // unknown never renders
  if (audience === 'tech') return true;                               // engineers see the doubt
  if (fact.classification !== 'LIVE') return false;                   // business and guides: LIVE only
  // ...and only while still fresh. Between a commit landing and watch
  // finishing, a LIVE fact can be marked stale: its receipts were invalidated
  // and nobody has re-read the code yet. Sending that to the two audiences
  // least able to evaluate it is the failure watch exists to prevent, and
  // classification alone cannot see it.
  return fact.status === 'fresh';
}

// The out/ contract: exactly which documents a run is expected to produce,
// derived from the enabled audiences and the terrain. Four of the nine gate
// checks read these documents, so "which files, named how" cannot stay
// implicit — an unspecified filename is a check that silently reads nothing.
// Paths are relative to .ogma/out/. Ids that fail the grammar are skipped
// rather than interpolated: a module id is attacker-reachable through a
// hand-edited terrain file, and it must never become a directory traversal.
function outDocuments(config, terrain) {
  const cfg = isObject(config) ? config : {};
  const aud = isObject(cfg.audiences) ? cfg.audiences : {};
  const t = isObject(terrain) ? terrain : {};
  const usableId = v => typeof v === 'string' && v.length <= 200 && ID_GRAMMAR.test(v);

  const modules = (Array.isArray(t.modules) ? t.modules : [])
    .map(m => (typeof m === 'string' ? m : (isObject(m) ? m.id : null)))
    .filter(usableId);
  const guideSurfaces = (Array.isArray(t.surfaces) ? t.surfaces : [])
    .filter(s => isObject(s) && INTERACTIVE_SURFACE_KINDS.includes(s.kind))
    .map(s => s.id)
    .filter(usableId);

  const docs = ['questions.md', 'map.md'];   // never audience-gated: the ledger and the dashboard
  if (aud.prd === true) docs.push('prd.md');
  if (aud.tech === true) for (const m of modules) docs.push(`tech/${m}.md`);
  if (aud.guides === true) for (const s of guideSurfaces) docs.push(`guides/${s}.md`);
  return [...new Set(docs)].sort();
}

function isSafeOutPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LENGTH && OUT_DOC.test(p);
}

// The exact bytes a witness ruling is bound to. Without a canonical form the
// input_hash is unbuildable — two honest runs hash differently and the
// anti-reuse check can never be implemented, which makes the hash decorative.
// Canonical form: a version tag, the trimmed statement, then one block per
// cited excerpt as "<file>:<line>-<end>" followed by its code, all sorted so
// excerpt order cannot change the digest, all newlines normalized to \n, joined
// by a "--" separator line, hashed as UTF-8. Refuses unusable input rather than
// hashing junk: a digest over garbage still looks like a valid digest.
function witnessInputHash(statement, excerpts) {
  if (typeof statement !== 'string') throw new Error('witnessInputHash: statement must be a string');
  const stmt = statement.replace(/\r\n?/g, '\n').trim();
  if (stmt.length === 0) throw new Error('witnessInputHash: statement is empty');
  if (!Array.isArray(excerpts) || excerpts.length === 0) {
    throw new Error('witnessInputHash: excerpts must be a non-empty array');
  }
  const blocks = excerpts.map(x => {
    if (!isObject(x)) throw new Error('witnessInputHash: excerpt must be an object {file, line, end_line, code}');
    if (!isSafeRepoPath(x.file)) throw new Error('witnessInputHash: excerpt.file is not a citable repo path');
    if (!Number.isInteger(x.line) || x.line < 1 || x.line > MAX_LINE) {
      throw new Error('witnessInputHash: excerpt.line must be a positive integer');
    }
    const end = x.end_line === undefined ? x.line : x.end_line;
    if (!Number.isInteger(end) || end < x.line || end > MAX_LINE) {
      throw new Error('witnessInputHash: excerpt.end_line must be an integer >= line');
    }
    if (typeof x.code !== 'string') throw new Error('witnessInputHash: excerpt.code must be a string');
    return `${x.file}:${x.line}-${end}\n${x.code.replace(/\r\n?/g, '\n')}`;
  }).sort();
  // LENGTH-PREFIXED, not separator-joined. A bare "--" separator line is
  // forgeable: source files are attacker-controlled content, so a repo can ship
  // a file containing the separator followed by a path:line-shaped line, and
  // one set of excerpts then hashes identically to a different set. That
  // defeats the field's whole purpose, which is that a ruling cannot be reused
  // after the statement or the code changed. Byte lengths make every component
  // unambiguous, so no content can forge a boundary.
  const parts = [WITNESS_HASH_VERSION, stmt, String(blocks.length), ...blocks];
  const canonical = parts
    .map(p => `${Buffer.byteLength(p, 'utf8')}:${p}`)
    .join('');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// Identifier-shaped symbol. Never compiled into a RegExp by the verifier —
// matching is literal word-boundary search (see docs) — but constrained here
// so a wildcard or backtracking-shaped string cannot pose as a symbol.
const SYMBOL_DENY = /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

// Identifier-shaped is a DENY-list for the same reason paths are. The old
// ASCII allow-list rejected admin?, save!, name= (Ruby), ~Destructor and
// operator== (C++), #privateField (JS/TS), and every non-ASCII identifier,
// which are legal in Python, JS, TS, Java, C# and Swift. Each rejection is a
// fact that cannot enter the Ogham at all, so the file goes undocumented
// while the certificate still reads PASS -- the exact failure the path rule
// was rewritten to avoid, left standing ten lines away.
// Denied: control bytes, C1, bidi controls, and leading/trailing whitespace.
// NOT denied: regex metacharacters. Matching is a literal word-boundary
// search and never a constructed RegExp, so a pattern-shaped symbol is inert
// -- it simply fails to match and the receipt verifier reports a broken
// citation, which is the correct outcome. Banning them would reject
// operator*, operator+, operator| and operator/, which are real C++ symbols.
function isSymbolShaped(s) {
  if (typeof s !== 'string') return false;
  if (s !== s.trim() || s.length === 0) return false;   // leading/trailing space is a typo, not a symbol
  return !SYMBOL_DENY.test(s);
}

function validateReceipt(r, errors, ctx = 'receipt') {
  if (!isObject(r)) { errors.push(`${ctx}: receipt is not an object`); return; }
  if (!isSafeRepoPath(r.file)) {
    errors.push(`${ctx}: receipt.file must be a contained repo-relative POSIX path (no .., no absolute, no backslash, no drive letter)`);
  }
  if (!Number.isInteger(r.line) || r.line < 1 || r.line > MAX_LINE) {
    errors.push(`${ctx}: receipt.line must be an integer in [1, ${MAX_LINE}]`);
  }
  if (r.end_line !== undefined && (!Number.isInteger(r.end_line) || r.end_line < r.line || r.end_line > MAX_LINE)) {
    errors.push(`${ctx}: receipt.end_line must be an integer >= line`);
  }
  if (!isNonEmptyString(r.symbol, MAX_SYMBOL_LENGTH) || !isSymbolShaped(r.symbol)) {
    errors.push(`${ctx}: receipt.symbol must be identifier-shaped, max ${MAX_SYMBOL_LENGTH} chars`);
  }
}

function validateWitness(w, errors, ctx) {
  if (!isObject(w)) { errors.push(`${ctx}: witness is not an object`); return; }
  if (!WITNESS_VERDICTS.includes(w.verdict)) {
    errors.push(`${ctx}: witness.verdict must be one of ${WITNESS_VERDICTS.join('|')}`);
  }
  if (!isCommitish(w.checked_at_commit)) {
    errors.push(`${ctx}: witness.checked_at_commit must be a hex commit id (7-64 chars) — it reaches git argv`);
  }
  if (!isNonEmptyString(w.checker, 200)) {
    errors.push(`${ctx}: witness.checker missing — record who/what judged`);
  }
  if (!/^[a-f0-9]{64}$/.test(w.input_hash || '')) {
    errors.push(`${ctx}: witness.input_hash must be sha256 hex of the statement + code shown to the checker`);
  }
}

function validateStringArray(arr, errors, ctx, fieldName) {
  if (!Array.isArray(arr)) { errors.push(`${ctx}: ${fieldName} must be an array`); return; }
  if (arr.length > MAX_ARRAY) { errors.push(`${ctx}: ${fieldName} exceeds ${MAX_ARRAY} entries`); return; }
  arr.forEach((v, i) => {
    if (!isNonEmptyString(v)) errors.push(`${ctx}: ${fieldName}[${i}] must be a non-empty string`);
  });
}

function validatePath(p, errors, ctx) {
  if (!isObject(p)) { errors.push(`${ctx}: path is required for LIVE behavior/rule facts and must be an object`); return; }
  if (!isNonEmptyString(p.entry)) errors.push(`${ctx}: path.entry missing`);
  if (!isNonEmptyString(p.exit)) errors.push(`${ctx}: path.exit missing`);
  if (!Array.isArray(p.chain) || p.chain.length === 0) {
    errors.push(`${ctx}: path.chain must be a non-empty array`);
  } else if (p.chain.length > MAX_ARRAY) {
    errors.push(`${ctx}: path.chain exceeds ${MAX_ARRAY} hops`);
  } else {
    p.chain.forEach((hop, i) => {
      if (!isObject(hop)) { errors.push(`${ctx}: path.chain[${i}] must be an object {hop, receipt}`); return; }
      if (!isNonEmptyString(hop.hop)) errors.push(`${ctx}: path.chain[${i}].hop missing`);
      validateReceipt(hop.receipt, errors, `${ctx}.chain[${i}]`);
    });
  }
}

function validateFact(f, errors) {
  if (!isObject(f)) { errors.push('fact: record is not an object'); return; }
  const ctx = isNonEmptyString(f.id) ? safe(f.id, 80) : 'fact(no id)';
  // The ID grammar is enforced HERE, not deferred to the gate. Fact ids are
  // embedded into rendered documents for traceability and are hand-editable,
  // so an id like "../../etc/passwd" or one carrying spaces is exactly the
  // attacker-reachable string outDocuments already refuses to interpolate.
  if (!isValidId(f.id)) errors.push(`${ctx}: id must match [A-Za-z0-9-]+`);
  if (!isValidId(f.feature_id)) errors.push(`${ctx}: feature_id must match [A-Za-z0-9-]+`);
  if (!FACT_KINDS.includes(f.kind)) errors.push(`${ctx}: kind must be one of ${FACT_KINDS.join('|')}`);
  if (!isNonEmptyString(f.statement)) errors.push(`${ctx}: statement missing or over ${MAX_TEXT_LENGTH} chars`);
  if (!CLASSIFICATIONS.includes(f.classification)) {
    errors.push(`${ctx}: classification must be one of ${CLASSIFICATIONS.join('|')}`);
  }
  if (!Array.isArray(f.receipts) || f.receipts.length === 0) {
    errors.push(`${ctx}: a fact without a receipt does not enter the Ogham`);
  } else if (f.receipts.length > MAX_ARRAY) {
    errors.push(`${ctx}: receipts exceeds ${MAX_ARRAY} entries`);
  } else {
    f.receipts.forEach((r, i) => validateReceipt(r, errors, `${ctx}.receipts[${i}]`));
  }
  // A path is REQUIRED on LIVE behavior/rule facts and OPTIONAL elsewhere — but
  // optional is not unchecked. The witness loop demotes facts and leaves their
  // paths in place, so "only validate the path on LIVE facts" means every hop
  // receipt on every demoted fact goes unverified forever.
  const pathRequired = f.classification === 'LIVE' && (f.kind === 'behavior' || f.kind === 'rule');
  if (pathRequired || f.path !== undefined) validatePath(f.path, errors, ctx);

  if (f.classification === 'HALF-BUILT' || f.classification === 'UNCLEAR') {
    if (!Array.isArray(f.ledger_refs) || f.ledger_refs.length === 0) {
      errors.push(`${ctx}: ${safe(f.classification, 40)} facts must reference a ledger question`);
    }
  }
  // A refuted or unsupported statement owes the ledger a question whatever its
  // classification. Tying the obligation to HALF-BUILT/UNCLEAR alone let a DEAD
  // fact carry a REFUTED ruling with no ledger reference: the refutation and
  // the open question both vanish, and the statement still renders to engineers
  // as a settled DEAD claim. That is the honesty ledger being bypassed by the
  // validator meant to enforce it.
  if (isObject(f.witness) && (f.witness.verdict === 'REFUTED' || f.witness.verdict === 'UNSUPPORTED')) {
    if (!Array.isArray(f.ledger_refs) || f.ledger_refs.length === 0) {
      errors.push(`${ctx}: a ${safe(f.witness.verdict, 20)} ruling must reference a ledger question — a refuted statement is an open question, not a settled one`);
    }
  }
  if (f.ledger_refs !== undefined) validateStringArray(f.ledger_refs, errors, ctx, 'ledger_refs');
  if (f.witness !== undefined) validateWitness(f.witness, errors, ctx);
  if (f.status !== undefined && f.status !== 'fresh' && f.status !== 'stale') {
    errors.push(`${ctx}: status must be fresh|stale`);
  }
  if (f.verified_at_commit !== undefined && !isCommitish(f.verified_at_commit)) {
    errors.push(`${ctx}: verified_at_commit must be a hex commit id (7-64 chars) — it reaches git argv`);
  }

  // Law 2, made mechanical instead of documented. A LIVE fact carries a
  // CONFIRMED ruling made at the same commit the fact was verified at. A
  // non-LIVE fact keeps whatever ruling demoted it: that is the documented end
  // state of the witness loop, not a violation.
  if (f.witness === undefined) {
    errors.push(`${ctx}: every fact carries a witness ruling — an unwitnessed statement never enters the Ogham`);
  }
  if (f.classification === 'LIVE') {
    if (isObject(f.witness) && f.witness.verdict !== 'CONFIRMED') {
      errors.push(`${ctx}: a LIVE fact must be CONFIRMED — a non-confirmed ruling demotes the fact, it does not sit on a LIVE one`);
    }
    if (f.verified_at_commit === undefined) {
      errors.push(`${ctx}: a LIVE fact carries verified_at_commit — freshness cannot be checked without it`);
    }
    // The doc has always said status is required on LIVE facts. It was not
    // enforced, and rendersTo now depends on it: an absent status must never
    // read as fresh by default.
    if (f.status !== 'fresh' && f.status !== 'stale') {
      errors.push(`${ctx}: a LIVE fact carries status fresh|stale — an absent status must not be read as fresh`);
    }
  }
  if (isObject(f.witness) && isCommitish(f.witness.checked_at_commit) && isCommitish(f.verified_at_commit)
      && !sameCommit(f.witness.checked_at_commit, f.verified_at_commit)) {
    errors.push(`${ctx}: witness.checked_at_commit and verified_at_commit name different commits — the ruling is not fresh for this fact`);
  }
}

function validateFeature(feat, errors) {
  if (!isObject(feat)) { errors.push('feature: record is not an object'); return; }
  const ctx = isNonEmptyString(feat.id) ? safe(feat.id, 80) : 'feature(no id)';
  if (!isNonEmptyString(feat.id)) errors.push(`${ctx}: id missing`);
  if (!isNonEmptyString(feat.name)) errors.push(`${ctx}: name missing`);
  if (!CLASSIFICATIONS.includes(feat.classification)) {
    errors.push(`${ctx}: classification must be one of ${CLASSIFICATIONS.join('|')}`);
  }
  // Narration policy is per owned-fact mix, so the module-file pass enforces
  // which one applies; record-level we require that at least one is present.
  const narrated = ['does', 'happens', 'sees'].every(k => isNonEmptyString(feat[k]));
  if (feat.classification === 'LIVE') {
    if (!narrated) errors.push(`${ctx}: every LIVE feature carries does/happens/sees`);
  } else if (!narrated && !isNonEmptyString(feat.why_not_narrated)) {
    errors.push(`${ctx}: a non-LIVE feature carries does/happens/sees (if it has LIVE facts) or why_not_narrated (if it has none)`);
  }
  if (!Array.isArray(feat.fact_ids) || feat.fact_ids.length === 0) {
    errors.push(`${ctx}: a feature needs at least one fact`);
  } else {
    validateStringArray(feat.fact_ids, errors, ctx, 'fact_ids');
  }
}

// The ledger DOCUMENT. validateLedgerEntry checks one question; nothing checked
// the file, so the doc's "one validator per Ogham file" claim was false here and
// a wrong-shaped ledger passed unnoticed.
function validateLedgerFile(doc, errors) {
  if (!isObject(doc)) { errors.push('ledger file: not an object'); return; }
  if (!Array.isArray(doc.questions)) { errors.push('ledger file: questions must be an array'); return; }
  if (doc.questions.length > MAX_ARRAY) {
    errors.push(`ledger file: questions exceeds ${MAX_ARRAY} entries`);
    return;
  }
  const seen = new Set();
  doc.questions.forEach((q, i) => {
    validateLedgerEntry(q, errors);
    if (isObject(q) && isValidId(q.id)) {
      if (seen.has(q.id)) errors.push(`ledger file: duplicate question id "${safe(q.id, 60)}" at questions[${i}]`);
      seen.add(q.id);
    }
  });
}

function validateLedgerEntry(q, errors) {
  if (!isObject(q)) { errors.push('ledger question: record is not an object'); return; }
  const ctx = isNonEmptyString(q.id) ? safe(q.id, 80) : 'question(no id)';
  if (!isValidId(q.id)) errors.push(`${ctx}: id must match [A-Za-z0-9-]+`);
  if (q.classification_context !== undefined && !CLASSIFICATIONS.includes(q.classification_context)) {
    errors.push(`${ctx}: classification_context must be one of ${CLASSIFICATIONS.join('|')} when present`);
  }
  if (!isNonEmptyString(q.question)) errors.push(`${ctx}: question text missing`);
  if (!LEDGER_STATUSES.includes(q.status)) errors.push(`${ctx}: status must be one of ${LEDGER_STATUSES.join('|')}`);
  if (!Array.isArray(q.receipts) || q.receipts.length === 0) {
    errors.push(`${ctx}: even a question carries receipts — cite the code that raised the doubt`);
  } else {
    q.receipts.forEach((r, i) => validateReceipt(r, errors, `${ctx}.receipts[${i}]`));
  }
}

// Cross-record checks for one facts/<module>.json document. The feature↔fact
// link must agree in BOTH directions: a feature's classification is computed
// from the facts it lists, and every fact must be listed by the feature it
// points at. Global (cross-file) ID uniqueness is the gate's `integrity` check.
function validateModuleFile(doc, rawErrors) {
  // Cap collection: a hostile file within the array caps can otherwise amplify
  // a few MB of input into hundreds of thousands of attacker-text strings.
  let suppressed = 0;
  const errors = {
    push(msg) {
      if (rawErrors.length < MAX_ERRORS) rawErrors.push(msg);
      else suppressed++;
    },
    get length() { return rawErrors.length; }
  };
  const finish = () => {
    if (suppressed > 0) rawErrors.push(`... ${suppressed} more errors suppressed (cap ${MAX_ERRORS})`);
  };

  if (!isObject(doc)) { errors.push('module file: not an object'); finish(); return; }
  if (!isNonEmptyString(doc.module)) errors.push('module file: module name missing');

  for (const key of ['features', 'facts']) {
    if (doc[key] === undefined) { errors.push(`module file: ${key} array missing`); continue; }
    if (!Array.isArray(doc[key])) errors.push(`module file: ${key} must be an array, got ${typeof doc[key]}`);
    else if (doc[key].length > MAX_ARRAY) errors.push(`module file: ${key} exceeds ${MAX_ARRAY} entries`);
  }
  const features = Array.isArray(doc.features) ? doc.features.filter(isObject) : [];
  const facts = Array.isArray(doc.facts) ? doc.facts.filter(isObject) : [];
  if (Array.isArray(doc.features) && features.length !== doc.features.length) {
    errors.push('module file: features contains non-object entries');
  }
  if (Array.isArray(doc.facts) && facts.length !== doc.facts.length) {
    errors.push('module file: facts contains non-object entries');
  }

  if (features.length === 0 && !isNonEmptyString(doc.empty_reason)) {
    errors.push('module file: a module with no features must carry empty_reason');
  }

  features.forEach(f => validateFeature(f, errors));
  facts.forEach(f => validateFact(f, errors));

  const seen = new Set();
  for (const rec of [...features, ...facts]) {
    if (isNonEmptyString(rec.id)) {
      if (seen.has(rec.id)) errors.push(`${safe(rec.id, 80)}: duplicate id in module file`);
      seen.add(rec.id);
    }
  }

  const factById = new Map(facts.filter(f => isNonEmptyString(f.id)).map(f => [f.id, f]));
  const featureIds = new Set(features.filter(f => isNonEmptyString(f.id)).map(f => f.id));

  for (const fact of facts) {
    if (isNonEmptyString(fact.feature_id) && !featureIds.has(fact.feature_id)) {
      errors.push(`${safe(fact.id, 80)}: feature_id "${safe(fact.feature_id, 80)}" not found in this module`);
    }
  }

  // O(features + facts): group facts by owner once, set-ify fact_ids once.
  const factsByOwner = new Map();
  for (const fact of facts) {
    if (!isNonEmptyString(fact.feature_id)) continue;
    if (!factsByOwner.has(fact.feature_id)) factsByOwner.set(fact.feature_id, []);
    factsByOwner.get(fact.feature_id).push(fact);
  }
  for (const feat of features) {
    if (!Array.isArray(feat.fact_ids)) continue;
    const listed = new Set(feat.fact_ids);
    const own = [];
    for (const fid of feat.fact_ids) {
      const fact = factById.get(fid);
      if (!fact) { errors.push(`${safe(feat.id, 80)}: fact_id "${safe(fid, 80)}" not found in this module`); continue; }
      if (fact.feature_id !== feat.id) {
        errors.push(`${safe(feat.id, 80)}: lists fact "${safe(fid, 80)}" but that fact belongs to "${safe(fact.feature_id, 80)}" — the link must agree in both directions`);
        continue;
      }
      own.push(fact.classification);
    }
    for (const fact of factsByOwner.get(feat.id) || []) {
      if (!listed.has(fact.id)) {
        errors.push(`${safe(feat.id, 80)}: fact "${safe(fact.id, 80)}" points at this feature but is not in fact_ids`);
      }
    }
    if (own.length === 0) {
      errors.push(`${safe(feat.id, 80)}: no facts actually belong to this feature — orphan feature`);
    } else if (own.every(c => CLASSIFICATIONS.includes(c))) {
      const worst = worstClassification(own);
      if (feat.classification !== worst) {
        errors.push(`${safe(feat.id, 80)}: classification "${safe(feat.classification, 40)}" must be worst-of-facts "${worst}"`);
      }
      // Narration policy: LIVE facts present -> narrate; none -> why_not_narrated.
      const hasLive = own.includes('LIVE');
      const narrated = ['does', 'happens', 'sees'].every(k => isNonEmptyString(feat[k]));
      if (hasLive && !narrated) {
        errors.push(`${safe(feat.id, 80)}: has LIVE facts — does/happens/sees required (only its non-LIVE facts are excluded from render)`);
      }
      if (!hasLive && narrated) {
        errors.push(`${safe(feat.id, 80)}: has no LIVE facts — narrating its user experience would be fabrication; use why_not_narrated`);
      }
    }
    if (rawErrors.length >= MAX_ERRORS) break;   // stop amplifying on a hostile file
  }
  finish();
}

function validatePathArray(arr, errors, ctx, fieldName, { required = true, allowDot = false } = {}) {
  if (!Array.isArray(arr)) { errors.push(`${ctx}: ${fieldName} must be an array`); return; }
  if (required && arr.length === 0) { errors.push(`${ctx}: ${fieldName} must not be empty`); return; }
  if (arr.length > MAX_ARRAY) { errors.push(`${ctx}: ${fieldName} exceeds ${MAX_ARRAY} entries`); return; }
  const ok = allowDot ? isSafeRepoPathOrDot : isSafeRepoPath;
  arr.forEach((p, i) => {
    if (!ok(p)) errors.push(`${ctx}: ${fieldName}[${i}] must be a contained repo-relative POSIX path${allowDot ? ' or "."' : ''}`);
  });
}

// manifest.json — the Ogham's identity and its binding to a commit.
function validateManifest(m, errors) {
  if (!isObject(m)) { errors.push('manifest: not an object'); return; }
  if (m.ogham_version !== OGHAM_VERSION) errors.push(`manifest: ogham_version must be ${OGHAM_VERSION}`);
  if (!isNonEmptyString(m.project, 200)) errors.push('manifest: project must be a non-empty string, max 200 chars');
  if (m.repo_root !== '.' && !isSafeRepoPath(m.repo_root)) {
    errors.push('manifest: repo_root must be "." or a contained repo-relative path');
  }
  if (!isCommitish(m.cutoff_commit)) {
    errors.push('manifest: cutoff_commit must be a hex commit id (7-64 chars) — it reaches git argv');
  }
  if (!isNonEmptyString(m.generated_at, 40) || !ISO_INSTANT.test(m.generated_at)) {
    errors.push('manifest: generated_at must be an ISO-8601 UTC instant (YYYY-MM-DDThh:mm:ssZ)');
  }
  if (!isObject(m.counts)) { errors.push('manifest: counts must be an object'); return; }
  for (const k of ['surfaces', 'modules', 'features', 'facts', 'ledger_open']) {
    if (!Number.isInteger(m.counts[k]) || m.counts[k] < 0) {
      errors.push(`manifest: counts.${k} must be a non-negative integer`);
    }
  }
}

// terrain.json — surfaces and modules, the shape every renderer walks.
function validateTerrain(t, errors) {
  if (!isObject(t)) { errors.push('terrain: not an object'); return; }
  const surfaceIds = new Set();

  if (!Array.isArray(t.surfaces) || t.surfaces.length === 0) {
    errors.push('terrain: surfaces must be a non-empty array');
  } else if (t.surfaces.length > MAX_ARRAY) {
    errors.push(`terrain: surfaces exceeds ${MAX_ARRAY} entries`);
  } else {
    t.surfaces.forEach((s, i) => {
      const ctx = `terrain.surfaces[${i}]`;
      if (!isObject(s)) { errors.push(`${ctx}: not an object`); return; }
      if (!isNonEmptyString(s.id, 200) || !ID_GRAMMAR.test(s.id)) {
        errors.push(`${ctx}: id must match [A-Za-z0-9-]+`);
      } else if (surfaceIds.has(s.id)) {
        errors.push(`${ctx}: duplicate surface id "${safe(s.id, 60)}"`);
      } else {
        surfaceIds.add(s.id);
      }
      if (!SURFACE_KINDS.includes(s.kind)) errors.push(`${ctx}: kind must be one of ${SURFACE_KINDS.join('|')}`);
      if (!isSafeRepoPathOrDot(s.root)) errors.push(`${ctx}: root must be "." or a contained repo-relative path`);
      validatePathArray(s.entry_points, errors, ctx, 'entry_points');
    });
  }

  if (!Array.isArray(t.modules)) {
    errors.push('terrain: modules must be an array');
  } else if (t.modules.length > MAX_ARRAY) {
    errors.push(`terrain: modules exceeds ${MAX_ARRAY} entries`);
  } else {
    const moduleIds = new Set();
    t.modules.forEach((m, i) => {
      const ctx = `terrain.modules[${i}]`;
      if (!isObject(m)) { errors.push(`${ctx}: not an object`); return; }
      if (!isNonEmptyString(m.id, 200) || !ID_GRAMMAR.test(m.id)) {
        errors.push(`${ctx}: id must match [A-Za-z0-9-]+`);
      } else if (moduleIds.has(m.id)) {
        errors.push(`${ctx}: duplicate module id "${safe(m.id, 60)}"`);
      } else {
        moduleIds.add(m.id);
      }
      if (!isNonEmptyString(m.name, 200)) errors.push(`${ctx}: name missing`);
      if (!isNonEmptyString(m.summary)) errors.push(`${ctx}: summary missing — a module a stakeholder cannot recognize is not a module`);
      validatePathArray(m.roots, errors, ctx, 'roots', { allowDot: true });
      if (!Array.isArray(m.surface_ids) || m.surface_ids.length === 0) {
        errors.push(`${ctx}: surface_ids must be a non-empty array`);
      } else {
        m.surface_ids.forEach((id, j) => {
          if (!surfaceIds.has(id)) errors.push(`${ctx}: surface_id[${j}] "${safe(id, 60)}" not found in surfaces`);
        });
      }
    });
  }

  if (t.languages !== undefined && !isObject(t.languages)) errors.push('terrain: languages must be an object');
}

// graph/index.json — the Nerves' symbol table + call sites. Machine-written by
// the indexer, machine-read by queries, the receipt verifier's neighbor and
// (from Batch 3) the classifier's reachability source. Symbol names are code-
// derived text: they get the same symbol-shape rule receipts use, and every
// path must be citable — a file the graph knows but the schema cannot cite
// would let a chain hop point at an uncitable location.
function validateGraphIndex(g, errors) {
  if (!isObject(g)) { errors.push('graph: not an object'); return; }
  if (g.graph_version !== GRAPH_VERSION) errors.push(`graph: graph_version must be ${GRAPH_VERSION}`);
  if (g.commit !== null && !isCommitish(g.commit)) {
    errors.push('graph: commit must be null or a hex commit id (7-64 chars)');
  }
  if (!isObject(g.skipped)) errors.push('graph: skipped counts missing');
  else for (const [k, v] of Object.entries(g.skipped)) {
    if (!Number.isInteger(v) || v < 0) errors.push(`graph: skipped.${safe(k, 40)} must be a non-negative integer`);
  }
  if (!Array.isArray(g.files)) { errors.push('graph: files must be an array'); return; }
  if (g.files.length > MAX_ARRAY) { errors.push(`graph: files exceeds ${MAX_ARRAY} entries`); return; }
  const seenPaths = new Set();
  g.files.forEach((f, i) => {
    const ctx = `graph.files[${i}]`;
    if (!isObject(f)) { errors.push(`${ctx}: not an object`); return; }
    if (!isSafeRepoPath(f.path)) errors.push(`${ctx}: path must be a citable repo path`);
    else if (seenPaths.has(f.path)) errors.push(`${ctx}: duplicate path "${safe(f.path, 120)}"`);
    else seenPaths.add(f.path);
    if (!isNonEmptyString(f.language, 20)) errors.push(`${ctx}: language missing`);
    for (const key of ['symbols', 'calls']) {
      if (!Array.isArray(f[key])) { errors.push(`${ctx}: ${key} must be an array`); continue; }
      if (f[key].length > MAX_ARRAY) { errors.push(`${ctx}: ${key} exceeds ${MAX_ARRAY} entries`); continue; }
      f[key].forEach((rec, j) => {
        const rctx = `${ctx}.${key}[${j}]`;
        if (!isObject(rec)) { errors.push(`${rctx}: not an object`); return; }
        if (!isNonEmptyString(rec.name, MAX_SYMBOL_LENGTH) || !isSymbolShaped(rec.name)) {
          errors.push(`${rctx}: name must be symbol-shaped, max ${MAX_SYMBOL_LENGTH} chars`);
        }
        if (!Number.isInteger(rec.line) || rec.line < 1 || rec.line > MAX_LINE) {
          errors.push(`${rctx}: line must be an integer in [1, ${MAX_LINE}]`);
        }
        if (key === 'symbols') {
          if (!isNonEmptyString(rec.kind, 40)) errors.push(`${rctx}: kind missing`);
          if (!Number.isInteger(rec.end_line) || rec.end_line < rec.line || rec.end_line > MAX_LINE) {
            errors.push(`${rctx}: end_line must be an integer >= line`);
          }
        } else if (rec.from !== null && rec.from !== undefined
            && (!isNonEmptyString(rec.from, MAX_SYMBOL_LENGTH) || !isSymbolShaped(rec.from))) {
          errors.push(`${rctx}: from must be null or symbol-shaped`);
        }
      });
    }
  });
}

// raised.json — question ids flagged during reading, before ledger authoring.
function validateRaised(r, errors) {
  if (!isObject(r)) { errors.push('raised: not an object'); return; }
  if (!Array.isArray(r.raised)) { errors.push('raised: raised must be an array'); return; }
  if (r.raised.length > MAX_ARRAY) { errors.push(`raised: exceeds ${MAX_ARRAY} entries`); return; }
  const seen = new Set();
  r.raised.forEach((id, i) => {
    if (!isNonEmptyString(id, 200) || !ID_GRAMMAR.test(id)) {
      errors.push(`raised[${i}]: "${safe(id, 60)}" is not a valid question id — must match [A-Za-z0-9-]+`);
      return;
    }
    if (seen.has(id)) errors.push(`raised[${i}]: duplicate raised id "${safe(id, 60)}"`);
    seen.add(id);
  });
}

function validateConfig(c, errors) {
  if (!isObject(c)) { errors.push('config: not an object'); return; }
  if (c.version !== CONFIG_VERSION) errors.push(`config: version must be ${CONFIG_VERSION}`);
  if (!isNonEmptyString(c.project, 200) || /[\u0000-\u001f\u007f-\u009f]/.test(c.project)) {
    errors.push('config: project must be a non-empty string, max 200 chars, no control characters');
  }
  if (!isObject(c.audiences)) errors.push('config: audiences must be an object');
  else for (const k of ['prd', 'tech', 'guides']) {
    if (typeof c.audiences[k] !== 'boolean') errors.push(`config: audiences.${k} must be boolean`);
  }
  if (!isObject(c.destination)) errors.push('config: destination must be an object');
  else {
    if (!DESTINATION_KINDS.includes(c.destination.kind)) {
      errors.push(`config: destination.kind must be one of ${DESTINATION_KINDS.map(String).join('|')}`);
    }
    if (typeof c.destination.asked !== 'boolean') errors.push('config: destination.asked must be boolean');
  }
  if (!isNonEmptyString(c.language, 20)) errors.push('config: language must be a non-empty string');
  validateStringArray(c.leaklint_extra, errors, 'config', 'leaklint_extra');
  if (!Number.isFinite(c.readability_max_grade) || c.readability_max_grade <= 0 || c.readability_max_grade > 20) {
    errors.push('config: readability_max_grade must be a number in (0, 20]');
  }
}

function defaultConfig(projectName) {
  const clean = String(projectName).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200) || 'project';
  return {
    version: CONFIG_VERSION,
    project: clean,
    audiences: { prd: true, tech: true, guides: true },
    destination: { kind: null, asked: false },
    language: 'en',
    leaklint_extra: [],
    readability_max_grade: 10
  };
}

module.exports = {
  OGHAM_VERSION,
  CONFIG_VERSION,
  GRAPH_VERSION,
  CLASSIFICATIONS,
  FACT_KINDS,
  LEDGER_STATUSES,
  WITNESS_VERDICTS,
  GATE_CHECKS,
  DESTINATION_KINDS,
  SURFACE_KINDS,
  INTERACTIVE_SURFACE_KINDS,
  AUDIENCES,
  WITNESS_HASH_VERSION,
  RECEIPT_DRIFT_WINDOW,
  LEAKLINT_BASE,
  SEVERITY,
  MAX_PATH_LENGTH,
  MAX_SYMBOL_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_LINE,
  MAX_ARRAY,
  MAX_ERRORS,
  worstClassification,
  safe,
  isSafeRepoPath,
  isSafeRepoPathOrDot,
  isSafeOutPath,
  isSymbolShaped,
  isValidId,
  isCommitish,
  sameCommit,
  oghamIsBound,
  rendersTo,
  outDocuments,
  witnessInputHash,
  validateReceipt,
  validateWitness,
  validatePath,
  validateFact,
  validateFeature,
  validateLedgerEntry,
  validateLedgerFile,
  validateModuleFile,
  validateManifest,
  validateTerrain,
  validateGraphIndex,
  validateRaised,
  validateConfig,
  defaultConfig
};
