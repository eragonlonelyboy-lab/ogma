#!/usr/bin/env node
// Schema bench — every validator must reject every planted violation class
// and accept the clean fixture. Zero-dependency runner; exit 1 on any failure.
'use strict';

const {
  validateReceipt, validateFact, validateFeature, validateLedgerEntry,
  validateModuleFile, validateConfig, defaultConfig, worstClassification
} = require('../lib/schema');

let pass = 0, fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL  ${name} — ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function errorsOf(validator, record) {
  const errors = [];
  validator(record, errors);
  return errors;
}

// ---- fixtures -------------------------------------------------------------

const cleanReceipt = { file: 'src/payments/service.ts', line: 88, symbol: 'validateDailyLimit' };

const cleanFact = {
  id: 'FACT-payments-001',
  feature_id: 'FEAT-payments-pay-bill',
  kind: 'rule',
  statement: 'A payment above the daily limit is rejected with a limit message.',
  classification: 'LIVE',
  receipts: [cleanReceipt],
  ledger_refs: []
};

const cleanFeature = {
  id: 'FEAT-payments-pay-bill',
  name: 'Pay a bill',
  classification: 'LIVE',
  does: 'User selects a saved bill, enters an amount, confirms.',
  happens: 'The amount is checked against the daily limit, then the payment is sent.',
  sees: 'A success screen with a reference number.',
  fact_ids: ['FACT-payments-001']
};

const cleanLedgerEntry = {
  id: 'Q-003',
  module: 'payments',
  question: 'Refund flow has a service but no route registers it. Unfinished?',
  receipts: [{ file: 'src/payments/refund.ts', line: 12, symbol: 'RefundService' }],
  status: 'open'
};

const cleanModule = {
  module: 'payments',
  features: [cleanFeature],
  facts: [cleanFact]
};

// ---- receipt --------------------------------------------------------------

console.log('receipt:');
check('clean receipt passes', () => {
  const e = []; validateReceipt(cleanReceipt, e, 't'); assert(e.length === 0, e.join('; '));
});
check('line 0 rejected', () => {
  const e = []; validateReceipt({ ...cleanReceipt, line: 0 }, e, 't'); assert(e.length > 0, 'accepted line 0');
});
check('missing symbol rejected', () => {
  const e = []; validateReceipt({ ...cleanReceipt, symbol: '' }, e, 't'); assert(e.length > 0, 'accepted empty symbol');
});
check('missing file rejected', () => {
  const e = []; validateReceipt({ line: 1, symbol: 'x' }, e, 't'); assert(e.length > 0, 'accepted missing file');
});

// ---- fact -----------------------------------------------------------------

console.log('fact:');
check('clean fact passes', () => {
  assert(errorsOf(validateFact, cleanFact).length === 0, errorsOf(validateFact, cleanFact).join('; '));
});
check('fact without receipts rejected (receipts law)', () => {
  const e = errorsOf(validateFact, { ...cleanFact, receipts: [] });
  assert(e.some(x => x.includes('receipt')), 'no receipt error raised');
});
check('bad classification rejected', () => {
  assert(errorsOf(validateFact, { ...cleanFact, classification: 'MAYBE' }).length > 0, 'accepted MAYBE');
});
check('bad kind rejected', () => {
  assert(errorsOf(validateFact, { ...cleanFact, kind: 'vibe' }).length > 0, 'accepted kind=vibe');
});
check('HALF-BUILT without ledger_refs rejected', () => {
  const e = errorsOf(validateFact, { ...cleanFact, classification: 'HALF-BUILT', ledger_refs: [] });
  assert(e.some(x => x.includes('ledger')), 'no ledger error raised');
});
check('UNCLEAR without ledger_refs rejected', () => {
  const e = errorsOf(validateFact, { ...cleanFact, classification: 'UNCLEAR', ledger_refs: [] });
  assert(e.some(x => x.includes('ledger')), 'no ledger error raised');
});

// ---- feature --------------------------------------------------------------

console.log('feature:');
check('clean feature passes', () => {
  assert(errorsOf(validateFeature, cleanFeature).length === 0, errorsOf(validateFeature, cleanFeature).join('; '));
});
for (const k of ['does', 'happens', 'sees']) {
  check(`empty ${k} rejected`, () => {
    const e = errorsOf(validateFeature, { ...cleanFeature, [k]: '' });
    assert(e.some(x => x.includes(k)), `accepted empty ${k}`);
  });
}
check('feature without facts rejected', () => {
  assert(errorsOf(validateFeature, { ...cleanFeature, fact_ids: [] }).length > 0, 'accepted factless feature');
});

// ---- ledger ---------------------------------------------------------------

console.log('ledger:');
check('clean entry passes', () => {
  assert(errorsOf(validateLedgerEntry, cleanLedgerEntry).length === 0, errorsOf(validateLedgerEntry, cleanLedgerEntry).join('; '));
});
check('entry without receipts rejected', () => {
  assert(errorsOf(validateLedgerEntry, { ...cleanLedgerEntry, receipts: [] }).length > 0, 'accepted unreceipted question');
});
check('bad status rejected', () => {
  assert(errorsOf(validateLedgerEntry, { ...cleanLedgerEntry, status: 'ignored' }).length > 0, 'accepted status=ignored');
});

// ---- module file (cross-record) -------------------------------------------

console.log('module file:');
check('clean module passes', () => {
  assert(errorsOf(validateModuleFile, cleanModule).length === 0, errorsOf(validateModuleFile, cleanModule).join('; '));
});
check('fact referencing unknown feature rejected', () => {
  const m = { ...cleanModule, facts: [{ ...cleanFact, feature_id: 'FEAT-ghost' }] };
  const e = errorsOf(validateModuleFile, m);
  assert(e.some(x => x.includes('FEAT-ghost')), 'accepted ghost feature ref');
});
check('feature referencing unknown fact rejected', () => {
  const m = { ...cleanModule, features: [{ ...cleanFeature, fact_ids: ['FACT-ghost'] }] };
  const e = errorsOf(validateModuleFile, m);
  assert(e.some(x => x.includes('FACT-ghost')), 'accepted ghost fact ref');
});
check('duplicate id rejected', () => {
  const m = { ...cleanModule, facts: [cleanFact, { ...cleanFact }] };
  const e = errorsOf(validateModuleFile, m);
  assert(e.some(x => x.includes('duplicate')), 'accepted duplicate id');
});
check('feature classification must be worst-of-facts', () => {
  const m = {
    module: 'payments',
    features: [cleanFeature], // claims LIVE
    facts: [{ ...cleanFact, classification: 'HALF-BUILT', ledger_refs: ['Q-003'] }]
  };
  const e = errorsOf(validateModuleFile, m);
  assert(e.some(x => x.includes('worst-of-facts')), 'accepted LIVE feature over HALF-BUILT fact');
});
check('worstClassification ordering', () => {
  assert(worstClassification(['LIVE', 'DEAD']) === 'DEAD', 'DEAD not worse than LIVE');
  assert(worstClassification(['DEAD', 'HALF-BUILT']) === 'HALF-BUILT', 'HALF-BUILT not worse than DEAD');
  assert(worstClassification(['HALF-BUILT', 'UNCLEAR']) === 'UNCLEAR', 'UNCLEAR not worst');
  assert(worstClassification(['LIVE']) === 'LIVE', 'LIVE alone should stay LIVE');
});

// ---- config ---------------------------------------------------------------

console.log('config:');
check('defaultConfig passes its own validator', () => {
  assert(errorsOf(validateConfig, defaultConfig('t')).length === 0, 'default config invalid');
});
check('wrong version rejected', () => {
  assert(errorsOf(validateConfig, { ...defaultConfig('t'), version: 2 }).length > 0, 'accepted version 2');
});
check('missing project rejected', () => {
  assert(errorsOf(validateConfig, { ...defaultConfig('t'), project: '' }).length > 0, 'accepted empty project');
});

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
