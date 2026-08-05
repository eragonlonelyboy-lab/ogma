// The Ogham schema — constants and validators.
// Zero-LLM, zero-dependency. Everything OGMA writes is validated here,
// and the gate re-validates it before anything is called done.
'use strict';

const OGHAM_VERSION = 1;

const CLASSIFICATIONS = ['LIVE', 'DEAD', 'HALF-BUILT', 'UNCLEAR'];
const FACT_KINDS = ['behavior', 'rule', 'limit', 'state', 'integration'];
const LEDGER_STATUSES = ['open', 'answered', 'wont-fix'];
const GATE_CHECKS = ['coverage', 'receipts', 'leaklint', 'complete', 'ledger', 'orphans', 'readability'];

// Receipt line drift tolerance when re-verifying citations (±N lines).
const RECEIPT_DRIFT_WINDOW = 5;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateReceipt(r, errors, ctx) {
  if (!r || typeof r !== 'object') { errors.push(`${ctx}: receipt is not an object`); return; }
  if (!isNonEmptyString(r.file)) errors.push(`${ctx}: receipt.file missing`);
  if (!Number.isInteger(r.line) || r.line < 1) errors.push(`${ctx}: receipt.line must be a positive integer`);
  if (!isNonEmptyString(r.symbol)) errors.push(`${ctx}: receipt.symbol missing`);
}

function validateFact(f, errors) {
  const ctx = f && f.id ? f.id : 'fact(no id)';
  if (!isNonEmptyString(f.id)) errors.push(`${ctx}: id missing`);
  if (!isNonEmptyString(f.feature_id)) errors.push(`${ctx}: feature_id missing`);
  if (!FACT_KINDS.includes(f.kind)) errors.push(`${ctx}: kind must be one of ${FACT_KINDS.join('|')}`);
  if (!isNonEmptyString(f.statement)) errors.push(`${ctx}: statement missing`);
  if (!CLASSIFICATIONS.includes(f.classification)) errors.push(`${ctx}: classification must be one of ${CLASSIFICATIONS.join('|')}`);
  if (!Array.isArray(f.receipts) || f.receipts.length === 0) {
    errors.push(`${ctx}: a fact without a receipt does not enter the Ogham`);
  } else {
    f.receipts.forEach((r, i) => validateReceipt(r, errors, `${ctx}.receipts[${i}]`));
  }
  if ((f.classification === 'HALF-BUILT' || f.classification === 'UNCLEAR') &&
      (!Array.isArray(f.ledger_refs) || f.ledger_refs.length === 0)) {
    errors.push(`${ctx}: ${f.classification} facts must reference a ledger question`);
  }
}

function validateFeature(feat, errors) {
  const ctx = feat && feat.id ? feat.id : 'feature(no id)';
  if (!isNonEmptyString(feat.id)) errors.push(`${ctx}: id missing`);
  if (!isNonEmptyString(feat.name)) errors.push(`${ctx}: name missing`);
  if (!CLASSIFICATIONS.includes(feat.classification)) errors.push(`${ctx}: classification invalid`);
  for (const k of ['does', 'happens', 'sees']) {
    if (!isNonEmptyString(feat[k])) errors.push(`${ctx}: ${k} is empty — every feature carries does/happens/sees`);
  }
  if (!Array.isArray(feat.fact_ids) || feat.fact_ids.length === 0) errors.push(`${ctx}: a feature needs at least one fact`);
}

function validateLedgerEntry(q, errors) {
  const ctx = q && q.id ? q.id : 'question(no id)';
  if (!isNonEmptyString(q.id)) errors.push(`${ctx}: id missing`);
  if (!isNonEmptyString(q.question)) errors.push(`${ctx}: question text missing`);
  if (!LEDGER_STATUSES.includes(q.status)) errors.push(`${ctx}: status must be one of ${LEDGER_STATUSES.join('|')}`);
  if (!Array.isArray(q.receipts) || q.receipts.length === 0) {
    errors.push(`${ctx}: even a question carries receipts — cite the code that raised the doubt`);
  } else {
    q.receipts.forEach((r, i) => validateReceipt(r, errors, `${ctx}.receipts[${i}]`));
  }
}

function validateConfig(c, errors) {
  if (!c || typeof c !== 'object') { errors.push('config: not an object'); return; }
  if (c.version !== 1) errors.push('config: version must be 1');
  if (!isNonEmptyString(c.project)) errors.push('config: project name missing');
  if (!c.audiences || typeof c.audiences !== 'object') errors.push('config: audiences missing');
  if (!c.destination || typeof c.destination !== 'object') errors.push('config: destination block missing');
}

function defaultConfig(projectName) {
  return {
    version: 1,
    project: projectName,
    audiences: { prd: true, tech: true, guides: true },
    destination: { kind: null, asked: false },
    language: 'en',
    leaklint_extra: [],
    readability_max_grade: 10
  };
}

module.exports = {
  OGHAM_VERSION,
  CLASSIFICATIONS,
  FACT_KINDS,
  LEDGER_STATUSES,
  GATE_CHECKS,
  RECEIPT_DRIFT_WINDOW,
  validateReceipt,
  validateFact,
  validateFeature,
  validateLedgerEntry,
  validateConfig,
  defaultConfig
};
