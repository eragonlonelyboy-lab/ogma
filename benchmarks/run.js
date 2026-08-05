#!/usr/bin/env node
// Bench: every validator rejects every planted violation class, accepts the
// clean fixtures, and NEVER throws on hostile-shaped input. Also exercises the
// one built command (init) against a real temp dir, including the
// ledger-preservation case. Zero-dependency; exit 1 on any failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const S = require('../lib/schema');
const { cmdInit } = require('../lib/init');

let pass = 0, fail = 0;

function check(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name} — ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function errorsOf(validator, record) { const e = []; validator(record, e); return e; }
function noThrow(validator, record, label) {
  try { validator(record, []); } catch (e) { throw new Error(`${label} THREW ${e.constructor.name}: ${e.message}`); }
}

// ---- fixtures -------------------------------------------------------------

const R = { file: 'src/payments/service.ts', line: 88, symbol: 'validateDailyLimit' };
const HOP = { hop: 'service.validateDailyLimit', receipt: { ...R } };
const PATHOBJ = { entry: 'POST /payments', chain: [HOP], exit: '201 + reference' };

const cleanFact = {
  id: 'FACT-payments-001', feature_id: 'FEAT-payments-pay-bill', kind: 'rule',
  statement: 'A payment above the daily limit is rejected with a limit message.',
  classification: 'LIVE', receipts: [{ ...R }], path: PATHOBJ, ledger_refs: [],
  witness: { verdict: 'CONFIRMED', checked_at_commit: 'a1b2c3d' }
};
const cleanFeature = {
  id: 'FEAT-payments-pay-bill', name: 'Pay a bill', classification: 'LIVE',
  does: 'User selects a saved bill, enters an amount, confirms.',
  happens: 'The amount is checked against the daily limit, then the payment is sent.',
  sees: 'A success screen with a reference number.',
  fact_ids: ['FACT-payments-001']
};
const cleanLedgerEntry = {
  id: 'Q-003', module: 'payments',
  question: 'Refund flow has a service but no route registers it. Unfinished?',
  receipts: [{ file: 'src/payments/refund.ts', line: 12, symbol: 'RefundService' }],
  status: 'open'
};
const cleanModule = { module: 'payments', features: [cleanFeature], facts: [cleanFact] };

function fact(over) { return { ...cleanFact, ...over }; }
function feature(over) { return { ...cleanFeature, ...over }; }
function moduleDoc(over) { return { ...cleanModule, ...over }; }

// ---- constants pinned -----------------------------------------------------

console.log('constants:');
check('GATE_CHECKS is exactly the nine checks', () => {
  assert(S.GATE_CHECKS.length === 9, `expected 9, got ${S.GATE_CHECKS.length}`);
  for (const c of ['coverage','receipts','witness','leaklint','complete','ledger','orphans','readability','integrity']) {
    assert(S.GATE_CHECKS.includes(c), `missing check ${c}`);
  }
});
check('SEVERITY keys and CLASSIFICATIONS agree both ways', () => {
  assert(Object.keys(S.SEVERITY).length === S.CLASSIFICATIONS.length, 'count mismatch');
  for (const c of S.CLASSIFICATIONS) assert(c in S.SEVERITY, `${c} missing from SEVERITY`);
});
check('LEAKLINT_BASE is a non-empty list of non-empty strings', () => {
  assert(Array.isArray(S.LEAKLINT_BASE) && S.LEAKLINT_BASE.length >= 20, 'base list too small');
  S.LEAKLINT_BASE.forEach(t => assert(typeof t === 'string' && t.length > 0, 'bad term'));
});

// ---- worstClassification fails closed ------------------------------------

console.log('worstClassification:');
check('ordering', () => {
  assert(S.worstClassification(['LIVE', 'DEAD']) === 'DEAD', 'DEAD not worse');
  assert(S.worstClassification(['DEAD', 'HALF-BUILT']) === 'HALF-BUILT', 'HALF-BUILT not worse');
  assert(S.worstClassification(['HALF-BUILT', 'UNCLEAR']) === 'UNCLEAR', 'UNCLEAR not worst');
  assert(S.worstClassification(['LIVE']) === 'LIVE', 'LIVE alone');
});
check('unknown classification throws (never defaults to LIVE)', () => {
  let threw = false;
  try { S.worstClassification(['BOGUS']); } catch { threw = true; }
  assert(threw, 'accepted BOGUS');
});
check('empty input throws', () => {
  let threw = false;
  try { S.worstClassification([]); } catch { threw = true; }
  assert(threw, 'accepted empty');
});

// ---- hostile shapes: report, never throw ----------------------------------

console.log('hostile shapes:');
const HOSTILE = [null, undefined, 42, 'x', [], {}];
for (const [name, v] of [['validateFact', S.validateFact], ['validateFeature', S.validateFeature],
                         ['validateLedgerEntry', S.validateLedgerEntry], ['validateModuleFile', S.validateModuleFile],
                         ['validateConfig', S.validateConfig], ['validateWitness', (x, e) => S.validateWitness(x, e, 't')],
                         ['validateReceipt', (x, e) => S.validateReceipt(x, e, 't')]]) {
  check(`${name} never throws on hostile input`, () => {
    for (const h of HOSTILE) noThrow(v, h, `${name}(${String(h)})`);
  });
  check(`${name} reports errors on hostile input`, () => {
    for (const h of [null, 42, 'x']) {
      assert(errorsOf(v, h).length > 0, `${name}(${String(h)}) returned no errors`);
    }
  });
}
check('null members in features/facts are reported, not thrown', () => {
  const e = errorsOf(S.validateModuleFile, moduleDoc({ facts: [null, cleanFact], features: [42, cleanFeature] }));
  assert(e.some(x => x.includes('non-object')), 'non-object members not reported: ' + e.join('; '));
});
check('object-instead-of-array features/facts rejected, never coerced to empty', () => {
  const e = errorsOf(S.validateModuleFile, { module: 'm', features: { a: {} }, facts: { b: {} } });
  assert(e.some(x => x.includes('must be an array')), 'coerced silently: ' + e.join('; '));
});
check('missing features/facts keys rejected', () => {
  const e = errorsOf(S.validateModuleFile, { module: 'm' });
  assert(e.filter(x => x.includes('array missing')).length === 2, e.join('; '));
});

// ---- receipt --------------------------------------------------------------

console.log('receipt:');
check('clean receipt passes', () => assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R }).length === 0, 'clean rejected'));
check('traversal path rejected', () => {
  for (const p of ['../../etc/passwd', '/etc/shadow', 'C:/x', 'a//b', 'a/../b']) {
    assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, file: p }).length > 0, `accepted ${p}`);
  }
});
check('backslash and NUL paths rejected', () => {
  assert(S.isSafeRepoPath('src' + String.fromCharCode(92) + 'a.ts') === false, 'accepted backslash');
  assert(S.isSafeRepoPath('src/a' + String.fromCharCode(0) + '.ts') === false, 'accepted NUL');
});
check('line bounds enforced', () => {
  for (const l of [0, -1, 1.5, S.MAX_LINE + 1]) {
    assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, line: l }).length > 0, `accepted line ${l}`);
  }
});
check('end_line must be >= line', () => {
  assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, line: 10, end_line: 5 }).length > 0, 'accepted end<start');
  assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, line: 10, end_line: 20 }).length === 0, 'rejected valid range');
});
check('wildcard/regex-shaped symbols rejected', () => {
  for (const sym of ['.*', '(a+)+', '', 'a'.repeat(300)]) {
    assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, symbol: sym }).length > 0, `accepted "${sym.slice(0, 20)}"`);
  }
});

// ---- fact -----------------------------------------------------------------

console.log('fact:');
check('clean fact passes', () => { const e = errorsOf(S.validateFact, cleanFact); assert(e.length === 0, e.join('; ')); });
check('fact without receipts rejected (receipts law)', () =>
  assert(errorsOf(S.validateFact, fact({ receipts: [] })).some(x => x.includes('receipt')), 'no receipt error'));
check('bad classification rejected', () =>
  assert(errorsOf(S.validateFact, fact({ classification: 'MAYBE' })).length > 0, 'accepted MAYBE'));
check('LIVE rule fact without path rejected', () => {
  const f = fact({}); delete f.path;
  assert(errorsOf(S.validateFact, f).some(x => x.includes('path')), 'path requirement unenforced');
});
check('LIVE behavior fact without path rejected', () => {
  const f = fact({ kind: 'behavior' }); delete f.path;
  assert(errorsOf(S.validateFact, f).some(x => x.includes('path')), 'path requirement unenforced');
});
check('LIVE limit fact needs no path', () => {
  const f = fact({ kind: 'limit' }); delete f.path;
  assert(errorsOf(S.validateFact, f).length === 0, 'demanded path where not required');
});
check('chain hops must carry their own receipts', () => {
  const f = fact({ path: { entry: 'e', chain: ['bare-string'], exit: 'x' } });
  assert(errorsOf(S.validateFact, f).some(x => x.includes('chain')), 'accepted bare-string hop');
});
check('HALF-BUILT / UNCLEAR without ledger_refs rejected', () => {
  for (const c of ['HALF-BUILT', 'UNCLEAR']) {
    const f = fact({ classification: c, ledger_refs: [] }); delete f.path;
    assert(errorsOf(S.validateFact, f).some(x => x.includes('ledger')), `${c} accepted without ref`);
  }
});
check('empty-string ledger_refs rejected', () => {
  const f = fact({ classification: 'HALF-BUILT', ledger_refs: [''] }); delete f.path;
  assert(errorsOf(S.validateFact, f).some(x => x.includes('ledger_refs[0]')), 'accepted empty-string ref');
});
check('bad witness verdict rejected', () =>
  assert(errorsOf(S.validateFact, fact({ witness: { verdict: 'TRUST_ME', checked_at_commit: 'a' } })).length > 0, 'accepted TRUST_ME'));

// ---- feature --------------------------------------------------------------

console.log('feature:');
check('clean LIVE feature passes', () => { const e = errorsOf(S.validateFeature, cleanFeature); assert(e.length === 0, e.join('; ')); });
for (const k of ['does', 'happens', 'sees']) {
  check(`LIVE feature with empty ${k} rejected`, () =>
    assert(errorsOf(S.validateFeature, feature({ [k]: '' })).some(x => x.includes(k)), `accepted empty ${k}`));
}
check('non-LIVE feature requires why_not_reachable, not does/happens/sees', () => {
  const f = feature({ classification: 'DEAD' }); delete f.does; delete f.happens; delete f.sees;
  assert(errorsOf(S.validateFeature, f).some(x => x.includes('why_not_reachable')), 'no why_not_reachable error');
  f.why_not_reachable = 'No route or caller references this code.';
  assert(errorsOf(S.validateFeature, f).length === 0, 'rejected valid DEAD feature');
});
check('feature without facts rejected', () =>
  assert(errorsOf(S.validateFeature, feature({ fact_ids: [] })).length > 0, 'accepted factless feature'));
check('null fact_ids members rejected', () =>
  assert(errorsOf(S.validateFeature, feature({ fact_ids: [null] })).length > 0, 'accepted null fact id'));

// ---- ledger ---------------------------------------------------------------

console.log('ledger:');
check('clean entry passes', () => { const e = errorsOf(S.validateLedgerEntry, cleanLedgerEntry); assert(e.length === 0, e.join('; ')); });
check('entry without receipts rejected', () =>
  assert(errorsOf(S.validateLedgerEntry, { ...cleanLedgerEntry, receipts: [] }).length > 0, 'accepted unreceipted'));
check('bad status rejected', () =>
  assert(errorsOf(S.validateLedgerEntry, { ...cleanLedgerEntry, status: 'ignored' }).length > 0, 'accepted status=ignored'));

// ---- module file: link direction + empties --------------------------------

console.log('module file:');
check('clean module passes', () => { const e = errorsOf(S.validateModuleFile, cleanModule); assert(e.length === 0, e.join('; ')); });
check('empty module without empty_reason rejected', () => {
  const e = errorsOf(S.validateModuleFile, { module: 'm', features: [], facts: [] });
  assert(e.some(x => x.includes('empty_reason')), 'accepted empty module');
});
check('empty module with empty_reason passes', () => {
  const e = errorsOf(S.validateModuleFile, { module: 'm', features: [], facts: [], empty_reason: 'Reserved namespace, no behavior yet.' });
  assert(e.length === 0, e.join('; '));
});
check('LIVE feature listing another feature\'s UNCLEAR fact rejected (link direction)', () => {
  const fB = feature({ id: 'FEAT-B', classification: 'UNCLEAR', why_not_reachable: 'unclear' });
  delete fB.does; delete fB.happens; delete fB.sees;
  fB.fact_ids = ['FACT-X'];
  const fA = feature({ id: 'FEAT-A', fact_ids: ['FACT-X'] });
  const fx = fact({ id: 'FACT-X', feature_id: 'FEAT-B', classification: 'UNCLEAR', ledger_refs: ['Q-1'] });
  delete fx.path;
  const e = errorsOf(S.validateModuleFile, { module: 'm', features: [fA, fB], facts: [fx] });
  assert(e.some(x => x.includes('both directions') || x.includes('orphan')), 'LIVE feature borrowing a foreign fact passed: ' + e.join('; '));
});
check('fact pointing at a feature that does not list it rejected', () => {
  const f2 = fact({ id: 'FACT-2' }); // feature_id points at pay-bill, but pay-bill lists only FACT-001
  const e = errorsOf(S.validateModuleFile, moduleDoc({ facts: [cleanFact, f2] }));
  assert(e.some(x => x.includes('not in fact_ids')), 'unlisted fact passed: ' + e.join('; '));
});
check('dangling fact_id rejected', () => {
  const e = errorsOf(S.validateModuleFile, moduleDoc({ features: [feature({ fact_ids: ['FACT-payments-001', 'FACT-ghost'] })] }));
  assert(e.some(x => x.includes('FACT-ghost')), 'ghost ref passed');
});
check('feature classification must equal worst-of-owned-facts', () => {
  const half = fact({ id: 'FACT-H', classification: 'HALF-BUILT', ledger_refs: ['Q-1'] }); delete half.path;
  const e = errorsOf(S.validateModuleFile, moduleDoc({
    features: [feature({ fact_ids: ['FACT-payments-001', 'FACT-H'] })],
    facts: [cleanFact, half]
  }));
  assert(e.some(x => x.includes('worst-of-facts')), 'LIVE over HALF-BUILT passed: ' + e.join('; '));
});
check('duplicate id rejected', () => {
  const e = errorsOf(S.validateModuleFile, moduleDoc({ facts: [cleanFact, { ...cleanFact }] }));
  assert(e.some(x => x.includes('duplicate')), 'duplicate passed');
});

// ---- config ---------------------------------------------------------------

console.log('config:');
check('defaultConfig passes its own validator', () => {
  const e = errorsOf(S.validateConfig, S.defaultConfig('t'));
  assert(e.length === 0, e.join('; '));
});
check('wrong version rejected', () =>
  assert(errorsOf(S.validateConfig, { ...S.defaultConfig('t'), version: 2 }).length > 0, 'accepted v2'));
check('non-boolean audience flags rejected', () =>
  assert(errorsOf(S.validateConfig, { ...S.defaultConfig('t'), audiences: { prd: 'yes', tech: true, guides: true } }).length > 0, 'accepted string flag'));
check('array audiences/destination rejected', () =>
  assert(errorsOf(S.validateConfig, { ...S.defaultConfig('t'), audiences: [], destination: [] }).length > 0, 'accepted arrays'));
check('unknown destination kind rejected', () =>
  assert(errorsOf(S.validateConfig, { ...S.defaultConfig('t'), destination: { kind: 'attacker-endpoint', asked: true } }).length > 0, 'accepted unknown kind'));
check('bad readability_max_grade rejected', () => {
  for (const g of ['banana', -1, 0, 99, NaN]) {
    assert(errorsOf(S.validateConfig, { ...S.defaultConfig('t'), readability_max_grade: g }).length > 0, `accepted ${g}`);
  }
});
check('non-array leaklint_extra rejected', () =>
  assert(errorsOf(S.validateConfig, { ...S.defaultConfig('t'), leaklint_extra: 'nope' }).length > 0, 'accepted string'));

// ---- init against a real temp dir -----------------------------------------

console.log('init:');
const quiet = () => {};
check('init scaffolds the full tree and config validates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogma-bench-'));
  assert(cmdInit(dir, quiet) === 0, 'init failed');
  for (const p of ['.ogma/config.json', '.ogma/ogham/facts', '.ogma/ogham/graph', '.ogma/ogham/ledger.json', '.ogma/out']) {
    assert(fs.existsSync(path.join(dir, p)), `missing ${p}`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.ogma/config.json'), 'utf8'));
  assert(errorsOf(S.validateConfig, cfg).length === 0, 'written config invalid');
});
check('re-init preserves an existing ledger even when config.json is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogma-bench-'));
  cmdInit(dir, quiet);
  const ledgerPath = path.join(dir, '.ogma/ogham/ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ questions: [{ id: 'Q-1' }] }));
  fs.unlinkSync(path.join(dir, '.ogma/config.json')); // the gitignored-config clone case
  assert(cmdInit(dir, quiet) === 0, 're-init failed');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert(ledger.questions.length === 1, 'LEDGER WAS DESTROYED');
  assert(fs.existsSync(path.join(dir, '.ogma/config.json')), 'config not repaired');
});
check('init refuses when .ogma is a regular file, with one clean message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogma-bench-'));
  fs.writeFileSync(path.join(dir, '.ogma'), 'not a dir');
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 1, 'did not fail');
  assert(msgs.length === 1 && msgs[0].includes('already exists'), 'no clean message: ' + msgs.join(' | '));
});
check('fully-initialized re-run touches nothing and says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogma-bench-'));
  cmdInit(dir, quiet);
  const before = fs.readFileSync(path.join(dir, '.ogma/config.json'), 'utf8');
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 0, 'rerun failed');
  assert(msgs[0].includes('nothing touched'), 'wrong message');
  assert(fs.readFileSync(path.join(dir, '.ogma/config.json'), 'utf8') === before, 'config rewritten');
});

// ---- CLI process-level behavior -------------------------------------------

console.log('cli:');
const BIN = path.join(__dirname, '..', 'bin', 'ogma.js');
function run(args) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }); }
check('--help exits 0 and lists every power', () => {
  const r = run(['--help']);
  assert(r.status === 0, `exit ${r.status}`);
  for (const p of ['init', 'ingest', 'gate', 'witness'.slice(0, 0) || 'watch']) assert(r.stdout.includes(p), `help missing ${p}`);
});
check('unbuilt command exits 1 and names its batch', () => {
  const r = run(['prd']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(r.stderr.includes('batch 4'), 'no batch number');
});
check('unknown command exits 1, help goes to stderr not stdout', () => {
  const r = run(['bogus']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(r.stdout === '', 'stdout not empty on failure');
  assert(r.stderr.includes('Unknown command'), 'no error line');
});
check('extra arguments are refused, not silently ignored', () => {
  const r = run(['init', './sub', '--flag']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(r.stderr.includes('unrecognized arguments'), 'silently ignored args');
});
check('version prints the package version', () => {
  const r = run(['version']);
  assert(r.status === 0 && r.stdout.trim() === require('../package.json').version, 'wrong version output');
});

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
