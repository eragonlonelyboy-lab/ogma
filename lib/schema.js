// The Ogham schema — constants and validators.
// Zero-LLM, zero-dependency. Everything OGMA writes is validated here,
// and the gate re-validates it before anything is called done.
// Validators REPORT, never throw: hostile-shaped input (null, wrong types,
// object-instead-of-array) must come back as errors, not exceptions.
'use strict';

const OGHAM_VERSION = 1;
const CONFIG_VERSION = 1; // independent of OGHAM_VERSION; both happen to be 1

const CLASSIFICATIONS = ['LIVE', 'DEAD', 'HALF-BUILT', 'UNCLEAR'];
const FACT_KINDS = ['behavior', 'rule', 'limit', 'state', 'integration'];
const LEDGER_STATUSES = ['open', 'answered', 'wont-fix'];
const WITNESS_VERDICTS = ['CONFIRMED', 'REFUTED', 'UNSUPPORTED'];
const GATE_CHECKS = [
  'coverage', 'receipts', 'witness', 'leaklint', 'complete',
  'ledger', 'orphans', 'readability', 'integrity'
];
const DESTINATION_KINDS = [null, 'markdown-only', 'confluence', 'notion', 'jira'];

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

// Path segment shape. Rejects leading "-" (option position), ":" (git pathspec
// magic like ":(exclude)"), spaces, and anything else non-portable.
const PATH_SEGMENT = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

// Citations may never point at version-control or OGMA's own state.
const FORBIDDEN_ROOTS = ['.git', '.ogma'];

// Cap on collected errors: a hostile module file can otherwise amplify a few MB
// of input into hundreds of thousands of attacker-text-bearing strings.
const MAX_ERRORS = 500;

// Fails CLOSED: an unknown classification is an error, never "least severe".
// Membership is tested against CLASSIFICATIONS, not `in SEVERITY` — `in` walks
// the prototype chain, so "toString"/"constructor" would resolve to a function
// and silently rank as LIVE, the one value that reaches business readers.
function worstClassification(classifications) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw new Error('worstClassification: empty or non-array input');
  }
  let worst = 'LIVE';
  for (const c of classifications) {
    if (!CLASSIFICATIONS.includes(c)) throw new Error(`worstClassification: unknown classification "${c}"`);
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
  if (p.startsWith('/') || p.startsWith('//')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segments = p.split('/');
  // Shape rejects "", option-position "-o", and git pathspec magic
  // like ":(exclude)". "." and ".." pass the shape (both begin with a
  // dot, which the pattern allows) so they are rejected explicitly.
  if (segments.some(s => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) return false;
  if (FORBIDDEN_ROOTS.includes(segments[0])) return false;      // never cite .git or .ogma
  return true;
}

function isCommitish(v) {
  return typeof v === 'string' && COMMITISH.test(v);
}

// Identifier-shaped symbol. Never compiled into a RegExp by the verifier —
// matching is literal word-boundary search (see docs) — but constrained here
// so a wildcard or backtracking-shaped string cannot pose as a symbol.
const SYMBOL_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$.:<>\- ]*$/;

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
  if (!isNonEmptyString(r.symbol, MAX_SYMBOL_LENGTH) || !SYMBOL_SHAPE.test(r.symbol)) {
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
  const ctx = isNonEmptyString(f.id) ? f.id : 'fact(no id)';
  if (!isNonEmptyString(f.id)) errors.push(`${ctx}: id missing`);
  if (!isNonEmptyString(f.feature_id)) errors.push(`${ctx}: feature_id missing`);
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
  if (f.classification === 'LIVE' && (f.kind === 'behavior' || f.kind === 'rule')) {
    validatePath(f.path, errors, ctx);
  }
  if (f.classification === 'HALF-BUILT' || f.classification === 'UNCLEAR') {
    if (!Array.isArray(f.ledger_refs) || f.ledger_refs.length === 0) {
      errors.push(`${ctx}: ${f.classification} facts must reference a ledger question`);
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
}

function validateFeature(feat, errors) {
  if (!isObject(feat)) { errors.push('feature: record is not an object'); return; }
  const ctx = isNonEmptyString(feat.id) ? feat.id : 'feature(no id)';
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

function validateLedgerEntry(q, errors) {
  if (!isObject(q)) { errors.push('ledger question: record is not an object'); return; }
  const ctx = isNonEmptyString(q.id) ? q.id : 'question(no id)';
  if (!isNonEmptyString(q.id)) errors.push(`${ctx}: id missing`);
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
      if (seen.has(rec.id)) errors.push(`${rec.id}: duplicate id in module file`);
      seen.add(rec.id);
    }
  }

  const factById = new Map(facts.filter(f => isNonEmptyString(f.id)).map(f => [f.id, f]));
  const featureIds = new Set(features.filter(f => isNonEmptyString(f.id)).map(f => f.id));

  for (const fact of facts) {
    if (isNonEmptyString(fact.feature_id) && !featureIds.has(fact.feature_id)) {
      errors.push(`${fact.id}: feature_id "${fact.feature_id}" not found in this module`);
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
      if (!fact) { errors.push(`${feat.id}: fact_id "${fid}" not found in this module`); continue; }
      if (fact.feature_id !== feat.id) {
        errors.push(`${feat.id}: lists fact "${fid}" but that fact belongs to "${fact.feature_id}" — the link must agree in both directions`);
        continue;
      }
      own.push(fact.classification);
    }
    for (const fact of factsByOwner.get(feat.id) || []) {
      if (!listed.has(fact.id)) {
        errors.push(`${feat.id}: fact "${fact.id}" points at this feature but is not in fact_ids`);
      }
    }
    if (own.length === 0) {
      errors.push(`${feat.id}: no facts actually belong to this feature — orphan feature`);
    } else if (own.every(c => CLASSIFICATIONS.includes(c))) {
      const worst = worstClassification(own);
      if (feat.classification !== worst) {
        errors.push(`${feat.id}: classification "${feat.classification}" must be worst-of-facts "${worst}"`);
      }
      // Narration policy: LIVE facts present -> narrate; none -> why_not_narrated.
      const hasLive = own.includes('LIVE');
      const narrated = ['does', 'happens', 'sees'].every(k => isNonEmptyString(feat[k]));
      if (hasLive && !narrated) {
        errors.push(`${feat.id}: has LIVE facts — does/happens/sees required (only its non-LIVE facts are excluded from render)`);
      }
      if (!hasLive && narrated) {
        errors.push(`${feat.id}: has no LIVE facts — narrating its user experience would be fabrication; use why_not_narrated`);
      }
    }
    if (rawErrors.length >= MAX_ERRORS) break;   // stop amplifying on a hostile file
  }
  finish();
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
  CLASSIFICATIONS,
  FACT_KINDS,
  LEDGER_STATUSES,
  WITNESS_VERDICTS,
  GATE_CHECKS,
  DESTINATION_KINDS,
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
  isSafeRepoPath,
  isCommitish,
  validateReceipt,
  validateWitness,
  validatePath,
  validateFact,
  validateFeature,
  validateLedgerEntry,
  validateModuleFile,
  validateConfig,
  defaultConfig
};
