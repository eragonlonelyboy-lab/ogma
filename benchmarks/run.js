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
const { cmdTerrain, analyzeTree, mergeTerrain, MIN_MODULE_FILES } = require('../lib/terrain');
const V = require('../lib/verify');
const G = require('../lib/graph');
const W = require('../lib/witness');
const { cmdIngest } = require('../lib/ingest');

let pass = 0, fail = 0;

// Every temp dir the bench makes is registered here and removed at the end.
// A test harness that litters the machine is a defect in the harness.
const TEMPS = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ogma-bench-'));
  TEMPS.push(d);
  return d;
}

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
  witness: { verdict: 'CONFIRMED', checked_at_commit: 'a1b2c3d', checker: 'blind-witness-v1', input_hash: 'a'.repeat(64) },
  verified_at_commit: 'a1b2c3d', status: 'fresh'
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
check('GATE_CHECKS is exactly the ten checks', () => {
  assert(S.GATE_CHECKS.length === 10, `expected 10, got ${S.GATE_CHECKS.length}`);
  for (const c of ['coverage','receipts','witness','leaklint','complete','ledger','orphans','readability','integrity','freshness']) {
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
check('validators never throw on values whose String() throws', () => {
  // JSON.parse produces this directly: {"id":{"toString":1,"valueOf":2}} has no
  // callable primitive conversion, so String(v) throws a TypeError. Anything
  // that interpolates untrusted values into an error string must survive it.
  const unstringifiable = { toString: 1, valueOf: 2 };
  const cases = [
    ['fact.id', S.validateFact, fact({ id: unstringifiable })],
    ['fact.feature_id', S.validateFact, fact({ feature_id: unstringifiable })],
    ['fact.classification', S.validateFact, fact({ classification: unstringifiable })],
    ['feature.id', S.validateFeature, feature({ id: unstringifiable })],
    ['feature.classification', S.validateFeature, feature({ classification: unstringifiable })],
    ['module fact_ids', S.validateModuleFile, moduleDoc({ features: [feature({ fact_ids: [unstringifiable] })] })],
    ['module facts', S.validateModuleFile, moduleDoc({ facts: [fact({ id: unstringifiable })] })],
    ['ledger.id', S.validateLedgerEntry, { ...cleanLedgerEntry, id: unstringifiable }],
    ['terrain surface_ids', S.validateTerrain, {
      surfaces: [{ id: 'app', kind: 'frontend', root: 'src', entry_points: ['src/main.ts'] }],
      modules: [{ id: 'm', name: 'M', summary: 'S', roots: ['src/m'], surface_ids: [unstringifiable] }]
    }],
    ['raised id', S.validateRaised, { raised: [unstringifiable] }]
  ];
  for (const [label, v, record] of cases) {
    try { v(record, []); }
    catch (e) { throw new Error(`${label} THREW ${e.constructor.name}: ${e.message}`); }
    assert(errorsOf(v, record).length > 0, `${label} reported nothing`);
  }
});
check('safe() never emits a lone surrogate when it truncates', () => {
  const out = S.safe('x'.repeat(118) + '\u{1F4A5}', 120);
  assert(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out), `lone surrogate in output: ${JSON.stringify(out)}`);
});
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
check('dot segments rejected (path-identity ambiguity)', () => {
  assert(S.isSafeRepoPath('./src/a.ts') === false, 'accepted ./x');
  assert(S.isSafeRepoPath('.') === false, 'accepted .');
});
check('git-argv and pathspec shapes rejected in receipt paths', () => {
  for (const p of ['-o', '-o/x.ts', ':(exclude)src', ':x', 'src/-rf.ts']) {
    assert(S.isSafeRepoPath(p) === false, `accepted ${p}`);
  }
});
check('citations into .git and .ogma rejected at ANY depth, any case', () => {
  for (const p of ['.git/config', '.ogma/config.json', '.GIT/config', '.Ogma/x.json',
                   'vendor/sub/.git/config', 'a/.OGMA/certificate.json']) {
    assert(S.isSafeRepoPath(p) === false, `accepted ${p}`);
  }
  assert(S.isSafeRepoPath('src/.gitkeep') === true, 'rejected legitimate dotfile');
  assert(S.isSafeRepoPath('src/gitignore.ts') === true, 'rejected legitimate name containing git');
});
check('real framework paths are citable (deny-list, not allow-list)', () => {
  const REAL = [
    'app/[id]/page.tsx',                    // Next.js dynamic route
    'app/[...slug]/route.ts',               // Next.js catch-all
    'app/(marketing)/layout.tsx',           // Next.js route group
    'src/routes/+page.svelte',              // SvelteKit
    'src/routes/[slug=int]/+page.server.ts',
    'packages/@acme/core/src/index.ts',     // scoped monorepo package
    'src/My Documents/report.ts',           // space in a directory name
    'src/café/naïve.ts',                    // non-ASCII latin
    'src/文档/入口.ts',                      // non-ASCII CJK
    'apps/web/src/components/Button.test.tsx',
    'Makefile',
    'src/a~b.ts', 'src/a,b.ts', 'src/a=b.ts', 'src/a!b.ts', 'src/a@b.ts', 'src/a+b.ts',
    'src/a&b.ts', 'src/a%b.ts', 'src/a#b.ts', "src/a'b.ts", 'src/a{b}.ts', 'src/a^b.ts'
  ];
  for (const p of REAL) {
    assert(S.isSafeRepoPath(p) === true, `REJECTED a real citable path: ${p}`);
  }
});
check('dangerous shapes still rejected under the deny-list', () => {
  const BAD = [
    '', 'a/', '/a', 'a//b', 'a/./b', 'a/../b', '../x', 'C:/x', '//server/share/x',
    'src/a\u0000.ts', 'src/a\u0001b.ts', 'src/a\u007f.ts',
    'src/a\u202eb.ts',                       // right-to-left override: path spoofing
    'src/a<b.ts', 'src/a>b.ts', 'src/a|b.ts', 'src/a?b.ts', 'src/a*b.ts', 'src/a"b.ts',
    'src/a:b.ts',                            // win32-illegal + git pathspec magic
    'src/trailing. /x.ts', 'src/trailing./x.ts', 'src/trailing /x.ts'
  ];
  for (const p of BAD) {
    assert(S.isSafeRepoPath(p) === false, `ACCEPTED a dangerous path: ${JSON.stringify(p)}`);
  }
});
check('commit-ish fields must be hex (git argv injection)', () => {
  assert(S.isCommitish('a1b2c3d') === true, 'rejected valid short sha');
  for (const c of ['--output=/tmp/pwn', 'HEAD', 'a1b2c3d --output=x', '', 'zzzzzzz']) {
    assert(S.isCommitish(c) === false, `accepted ${c}`);
  }
  assert(errorsOf(S.validateFact, fact({ witness: { ...cleanFact.witness, checked_at_commit: '--output=/tmp/pwn' } })).length > 0,
    'validator accepted option-shaped commit');
  assert(errorsOf(S.validateFact, fact({ verified_at_commit: '--output=/tmp/pwn' })).length > 0,
    'validator accepted option-shaped verified_at_commit');
});
check('worstClassification fails closed on prototype keys', () => {
  for (const k of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
    let threw = false;
    try { S.worstClassification([k]); } catch { threw = true; }
    assert(threw, `"${k}" ranked as a classification instead of throwing`);
  }
});
check('hostile module file caps error output instead of amplifying', () => {
  const features = [], facts = [];
  for (let i = 0; i < 400; i++) {
    features.push(feature({ id: `FEAT-${i}`, fact_ids: Array.from({ length: 50 }, (_, j) => `GHOST-${i}-${j}`) }));
  }
  const e = [];
  S.validateModuleFile({ module: 'm', features, facts }, e);
  assert(e.length <= S.MAX_ERRORS + 1, `collected ${e.length} errors, cap is ${S.MAX_ERRORS}`);
  assert(e[e.length - 1].includes('suppressed'), 'no suppression notice');
});
check('hyphenated project names survive defaultConfig and validate', () => {
  const cfg = S.defaultConfig('my-app');
  assert(cfg.project === 'my-app', `hyphen mangled: ${cfg.project}`);
  assert(errorsOf(S.validateConfig, cfg).length === 0, 'rejected hyphenated project');
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
check('real symbols from mainstream languages are citable (deny-list, not allow-list)', () => {
  const REAL = [
    'admin?', 'save!', 'name=',          // Ruby predicate, bang and setter methods
    '~Destructor', 'operator==', 'operator*', 'operator+', 'operator|', 'operator/',
    '#privateField',                      // JS/TS private class field
    'café', '数据', 'Данные',              // legal identifiers in Python, JS, TS, Java, C#, Swift
    'validateDailyLimit', 'Foo.Bar', 'List<int>', 'std::vector', '$scope'
  ];
  for (const sym of REAL) {
    const e = errorsOf((r, x) => S.validateReceipt(r, x, 't'), { ...R, symbol: sym });
    assert(e.length === 0, `REJECTED a real symbol: ${sym} — ${e.join('; ')}`);
  }
});
check('unusable symbols rejected, and pattern-shaped ones are inert not banned', () => {
  for (const sym of ['', '   ', 'a'.repeat(201), 'Valid   ', '  lead',
                     'a' + String.fromCharCode(27) + 'b', String.fromCharCode(0x202e) + 'x']) {
    assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, symbol: sym }).length > 0,
      `accepted ${JSON.stringify(sym.slice(0, 20))}`);
  }
  // Matching is a literal word-boundary search, never a compiled RegExp, so a
  // pattern-shaped symbol is harmless: it fails to match and the receipt
  // verifier reports a broken citation. Banning these would reject operator*.
  for (const sym of ['.*', '(a+)+']) {
    assert(errorsOf((r, e) => S.validateReceipt(r, e, 't'), { ...R, symbol: sym }).length === 0,
      `banned an inert pattern-shaped symbol: ${sym}`);
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
  assert(errorsOf(S.validateFact, fact({ witness: { ...cleanFact.witness, verdict: 'TRUST_ME' } })).length > 0, 'accepted TRUST_ME'));
check('witness without checker or input_hash rejected', () => {
  assert(errorsOf(S.validateFact, fact({ witness: { verdict: 'CONFIRMED', checked_at_commit: 'a' } })).length > 0, 'accepted provenance-free ruling');
});
check('bad status / verified_at_commit rejected', () => {
  assert(errorsOf(S.validateFact, fact({ status: 'banana' })).some(x => x.includes('status')), 'accepted status=banana');
  assert(errorsOf(S.validateFact, fact({ verified_at_commit: 12345 })).some(x => x.includes('verified_at_commit')), 'accepted numeric commit');
});

// ---- feature --------------------------------------------------------------

console.log('feature:');
check('clean LIVE feature passes', () => { const e = errorsOf(S.validateFeature, cleanFeature); assert(e.length === 0, e.join('; ')); });
for (const k of ['does', 'happens', 'sees']) {
  check(`LIVE feature with empty ${k} rejected`, () =>
    assert(errorsOf(S.validateFeature, feature({ [k]: '' })).some(x => x.includes(k)), `accepted empty ${k}`));
}
check('non-LIVE unnarrated feature requires why_not_narrated', () => {
  const f = feature({ classification: 'DEAD' }); delete f.does; delete f.happens; delete f.sees;
  assert(errorsOf(S.validateFeature, f).some(x => x.includes('why_not_narrated')), 'no why_not_narrated error');
  f.why_not_narrated = 'No route or caller references this code.';
  assert(errorsOf(S.validateFeature, f).length === 0, 'rejected valid DEAD feature');
});
check('narration policy: LIVE facts present -> must narrate; none -> must not', () => {
  const half = fact({ id: 'FACT-H', classification: 'HALF-BUILT', ledger_refs: ['Q-1'] }); delete half.path;
  half.feature_id = 'FEAT-payments-pay-bill';
  // Mixed feature (LIVE + HALF-BUILT): keeps narration, rollup drops to HALF-BUILT
  const mixed = feature({ classification: 'HALF-BUILT', fact_ids: ['FACT-payments-001', 'FACT-H'] });
  const e1 = errorsOf(S.validateModuleFile, { module: 'm', features: [mixed], facts: [cleanFact, half] });
  assert(e1.length === 0, 'rejected narrated mixed feature: ' + e1.join('; '));
  // Zero LIVE facts but narrated: fabrication, rejected
  const soloHalf = fact({ id: 'FACT-H2', feature_id: 'FEAT-X', classification: 'HALF-BUILT', ledger_refs: ['Q-1'] });
  delete soloHalf.path;
  const fab = feature({ id: 'FEAT-X', classification: 'HALF-BUILT', fact_ids: ['FACT-H2'] });
  const e2 = errorsOf(S.validateModuleFile, { module: 'm', features: [fab], facts: [soloHalf] });
  assert(e2.some(x => x.includes('fabrication')), 'accepted narration with zero LIVE facts: ' + e2.join('; '));
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
  const fB = feature({ id: 'FEAT-B', classification: 'UNCLEAR', why_not_narrated: 'unclear ownership' });
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

// ---- commit identity: freshness and head binding --------------------------

console.log('commit identity:');
check('sameCommit accepts prefix forms of one commit, rejects different ones', () => {
  const long = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert(S.sameCommit('a1b2c3d', long) === true, 'short prefix of the same commit rejected');
  assert(S.sameCommit(long, 'a1b2c3d') === true, 'argument order matters');
  assert(S.sameCommit(long, long) === true, 'identical rejected');
  assert(S.sameCommit('a1b2c3d', 'a1b2c3e') === false, 'different commits accepted');
  assert(S.sameCommit('a1b2c3', 'a1b2c3d') === false, 'accepted an under-length id');
  assert(S.sameCommit('HEAD', 'a1b2c3d') === false, 'accepted a non-hex ref');
  assert(S.sameCommit(null, undefined) === false, 'accepted nullish');
});
check('witness freshness is ENFORCED, not just documented', () => {
  const stale = fact({
    verified_at_commit: 'a1b2c3d',
    witness: { ...cleanFact.witness, checked_at_commit: 'f9e8d7c' }
  });
  assert(errorsOf(S.validateFact, stale).some(x => /fresh|checked_at_commit/.test(x)),
    'a ruling made at a different commit than the fact was verified at passed');
  const okLong = fact({
    verified_at_commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    witness: { ...cleanFact.witness, checked_at_commit: 'a1b2c3d' }
  });
  assert(errorsOf(S.validateFact, okLong).length === 0, 'rejected a valid prefix-form pair');
});
check('a LIVE fact must carry a CONFIRMED ruling (law 2, made mechanical)', () => {
  const noWitness = fact({}); delete noWitness.witness;
  assert(errorsOf(S.validateFact, noWitness).some(x => x.includes('witness')),
    'LIVE fact with no witness ruling passed');
  const refuted = fact({ witness: { ...cleanFact.witness, verdict: 'REFUTED' } });
  assert(errorsOf(S.validateFact, refuted).some(x => /CONFIRMED/.test(x)),
    'LIVE fact carrying a REFUTED ruling passed');
  const noCommit = fact({}); delete noCommit.verified_at_commit;
  assert(errorsOf(S.validateFact, noCommit).some(x => x.includes('verified_at_commit')),
    'LIVE fact with no verified_at_commit passed');
});
check('every fact carries a ruling, LIVE or not', () => {
  const unwitnessed = fact({ classification: 'DEAD' });
  delete unwitnessed.witness;
  delete unwitnessed.path;
  assert(errorsOf(S.validateFact, unwitnessed).some(x => x.includes('witness')),
    'a fact with no ruling at all entered the Ogham');
});
check('non-LIVE facts keep their last ruling without needing CONFIRMED', () => {
  const demoted = fact({
    classification: 'UNCLEAR', ledger_refs: ['Q-1'],
    witness: { ...cleanFact.witness, verdict: 'UNSUPPORTED' }
  });
  delete demoted.path;
  const e = errorsOf(S.validateFact, demoted);
  assert(e.length === 0, 'the documented demotion end state was rejected: ' + e.join('; '));
});
check('oghamIsBound refuses to certify an Ogham that is not at repo HEAD', () => {
  assert(S.oghamIsBound('a1b2c3d', 'a1b2c3d4e5f6') === true, 'same commit reported unbound');
  assert(S.oghamIsBound('a1b2c3d', 'f9e8d7c') === false, 'a stale Ogham reported bound');
  assert(S.oghamIsBound(undefined, 'a1b2c3d') === false, 'missing cutoff reported bound');
});

// ---- path receipts on every fact, not only LIVE ---------------------------

console.log('path validation scope:');
check('a malformed path is caught on non-LIVE facts too', () => {
  const bad = fact({
    classification: 'DEAD',
    path: { entry: 'e', exit: 'x', chain: [{ hop: 'h', receipt: { file: '../../etc/passwd', line: 1, symbol: 'x' } }] },
    witness: { ...cleanFact.witness, verdict: 'REFUTED' }
  });
  const e = errorsOf(S.validateFact, bad);
  assert(e.some(x => x.includes('chain[0]')), 'unreceipted hop on a DEAD fact passed: ' + e.join('; '));
});
check('a path present but structurally broken is caught on a LIVE limit fact', () => {
  const bad = fact({ kind: 'limit', path: { entry: '', exit: '', chain: [] } });
  assert(errorsOf(S.validateFact, bad).length > 0, 'broken optional path passed unvalidated');
});

// ---- render filtering: one rule, executable -------------------------------

console.log('render filtering:');
check('rendersTo excludes every non-LIVE fact from business and guide output', () => {
  for (const c of ['DEAD', 'HALF-BUILT', 'UNCLEAR']) {
    assert(S.rendersTo({ classification: c, status: 'fresh' }, 'prd') === false, `${c} reached prd`);
    assert(S.rendersTo({ classification: c, status: 'fresh' }, 'guides') === false, `${c} reached guides`);
    assert(S.rendersTo({ classification: c, status: 'fresh' }, 'tech') === true, `${c} hidden from tech output`);
  }
  assert(S.rendersTo({ classification: 'LIVE', status: 'fresh' }, 'prd') === true, 'LIVE excluded from prd');
  assert(S.rendersTo({ classification: 'BOGUS', status: 'fresh' }, 'tech') === false, 'unknown classification rendered');
  assert(S.rendersTo({ classification: 'LIVE', status: 'fresh' }, 'nonsense') === false, 'unknown audience rendered');
  assert(S.rendersTo(null, 'prd') === false, 'null fact rendered');
});
check('a stale LIVE fact does not reach business or guide readers', () => {
  const stale = { classification: 'LIVE', status: 'stale' };
  assert(S.rendersTo(stale, 'prd') === false, 'a fact the tool marked stale still reached the PRD');
  assert(S.rendersTo(stale, 'guides') === false, 'a fact the tool marked stale still reached a user guide');
  assert(S.rendersTo(stale, 'tech') === true, 'engineers should still see it, marked stale');
  // An absent status must never be read as fresh by default.
  assert(S.rendersTo({ classification: 'LIVE' }, 'prd') === false, 'a status-less fact defaulted to fresh');
});
check('a LIVE fact must declare its freshness', () => {
  const noStatus = fact({}); delete noStatus.status;
  assert(errorsOf(S.validateFact, noStatus).some(x => x.includes('status')),
    'a LIVE fact with no status passed — rendersTo depends on this field');
});

// ---- the out/ file contract -----------------------------------------------

console.log('out contract:');
const TERRAIN_SHAPE = { modules: ['payments', 'accounts'], surfaces: [
  { id: 'user-app', kind: 'frontend' }, { id: 'ops', kind: 'admin-web' }, { id: 'settler', kind: 'worker' }
] };
check('outDocuments names every expected document for the enabled audiences', () => {
  const docs = S.outDocuments(S.defaultConfig('t'), TERRAIN_SHAPE);
  for (const d of ['prd.md', 'tech/payments.md', 'tech/accounts.md',
                   'guides/user-app.md', 'guides/ops.md', 'questions.md', 'map.md']) {
    assert(docs.includes(d), `missing ${d} from: ${docs.join(', ')}`);
  }
  assert(!docs.includes('guides/settler.md'), 'wrote a user guide for a non-interactive surface');
  assert(docs.every(d => S.isSafeOutPath(d)), 'produced a document path its own rule rejects');
  assert(docs.join() === [...docs].sort().join(), 'document list is not deterministically ordered');
});
check('a disabled audience produces no documents', () => {
  const cfg = { ...S.defaultConfig('t'), audiences: { prd: false, tech: true, guides: false } };
  const docs = S.outDocuments(cfg, TERRAIN_SHAPE);
  assert(!docs.some(d => d === 'prd.md' || d.startsWith('guides/')), 'disabled audiences still wrote: ' + docs.join(', '));
  assert(docs.some(d => d.startsWith('tech/')), 'enabled audience produced nothing');
});
check('outDocuments never throws on hostile terrain and skips unusable ids', () => {
  for (const t of [null, 42, {}, { modules: 'x', surfaces: 'y' }, { modules: [null, '../x'], surfaces: [null, { id: '../e', kind: 'frontend' }] }]) {
    let docs;
    try { docs = S.outDocuments(S.defaultConfig('t'), t); }
    catch (e) { throw new Error(`threw on ${JSON.stringify(t)}: ${e.message}`); }
    assert(Array.isArray(docs), 'did not return an array');
    assert(docs.every(d => S.isSafeOutPath(d)), 'a hostile id escaped into a document path: ' + docs.join(', '));
  }
});
check('isSafeOutPath refuses traversal and absolute destinations', () => {
  for (const p of ['../x.md', '/etc/x.md', 'tech/../../x.md', 'x.md ', 'tech/x.txt', '', 'x.md' + String.fromCharCode(0)]) {
    assert(S.isSafeOutPath(p) === false, `accepted out path ${JSON.stringify(p)}`);
  }
});

// ---- witness input hash: buildable, canonical -----------------------------

console.log('witness input hash:');
const EX_A = { file: 'src/a.ts', line: 10, end_line: 12, code: 'function a() {\n  return 1;\n}' };
const EX_B = { file: 'src/b.ts', line: 3, end_line: 3, code: 'const b = 2;' };
check('witnessInputHash is a sha256 hex digest and is deterministic', () => {
  const h1 = S.witnessInputHash('A statement.', [EX_A, EX_B]);
  const h2 = S.witnessInputHash('A statement.', [EX_A, EX_B]);
  assert(/^[a-f0-9]{64}$/.test(h1), `not a sha256 hex digest: ${h1}`);
  assert(h1 === h2, 'not deterministic');
});
check('excerpt order does not change the hash, but content does', () => {
  assert(S.witnessInputHash('S', [EX_A, EX_B]) === S.witnessInputHash('S', [EX_B, EX_A]),
    'hash depends on excerpt order');
  assert(S.witnessInputHash('S', [EX_A]) !== S.witnessInputHash('S.', [EX_A]),
    'a changed statement kept its hash');
  assert(S.witnessInputHash('S', [EX_A]) !== S.witnessInputHash('S', [{ ...EX_A, code: EX_A.code + ' ' }]),
    'changed code kept its hash');
  assert(S.witnessInputHash('S', [EX_A]) !== S.witnessInputHash('S', [{ ...EX_A, line: 11 }]),
    'a changed citation range kept its hash');
});
check('line endings and surrounding whitespace are canonicalized away', () => {
  const crlf = { ...EX_A, code: EX_A.code.replace(/\n/g, '\r\n') };
  assert(S.witnessInputHash('S', [EX_A]) === S.witnessInputHash('S', [crlf]), 'CRLF changed the hash');
  assert(S.witnessInputHash('S', [EX_A]) === S.witnessInputHash('  S \n', [EX_A]), 'statement padding changed the hash');
});
check('witnessInputHash is INJECTIVE — no two different inputs share a digest', () => {
  // The separator-forging attack: repo source content is attacker-controlled,
  // so if components are joined by a bare separator with no length prefix, a
  // planted file can make one evidence set hash identically to another.
  const A = { file: 'src/a.ts', line: 1, end_line: 1, code: 'const a = 1;' };
  const Bx = { file: 'src/b.ts', line: 3, end_line: 3, code: 'const b = 2;' };
  const forged = { ...A, code: A.code + '\n--\nsrc/b.ts:3-3\nconst b = 2;' };
  assert(S.witnessInputHash('S', [A, Bx]) !== S.witnessInputHash('S', [forged]),
    'two different excerpt sets collide — a ruling validates against evidence it was never bound to');
  // Statement side: a statement must not be able to absorb an excerpt block.
  assert(S.witnessInputHash('S', [A, Bx]) !== S.witnessInputHash('S\n--\nsrc/a.ts:1-1\nconst a = 1;', [Bx]),
    'a statement absorbed an excerpt block and kept the digest');
  // Count must matter too: one block cannot pose as two.
  assert(S.witnessInputHash('S', [A]) !== S.witnessInputHash('S', [A, { ...A, file: 'src/c.ts' }]),
    'excerpt count does not affect the digest');
});
check('the witness hash version tag is inside the digest', () => {
  assert(S.WITNESS_HASH_VERSION === 'ogma-witness-v2',
    `version tag not bumped after the canonical form changed: ${S.WITNESS_HASH_VERSION}`);
});
check('witnessInputHash refuses unusable input instead of hashing junk', () => {
  for (const bad of [[null, [EX_A]], ['S', []], ['S', null], ['S', [{ file: 'x', line: 0, code: 'c' }]], ['', [EX_A]]]) {
    let threw = false;
    try { S.witnessInputHash(bad[0], bad[1]); } catch { threw = true; }
    assert(threw, `hashed junk input ${JSON.stringify(bad[0])}`);
  }
});

// ---- manifest / terrain / raised validators --------------------------------

console.log('manifest, terrain, raised:');
const cleanManifest = {
  ogham_version: 1, project: 'acme', repo_root: '.', cutoff_commit: 'a1b2c3d',
  generated_at: '2026-08-05T12:00:00Z',
  counts: { surfaces: 2, modules: 14, features: 63, facts: 212, ledger_open: 7 }
};
const cleanTerrain = {
  surfaces: [{ id: 'user-app', kind: 'frontend', root: 'apps/mobile', entry_points: ['apps/mobile/src/main.tsx'] }],
  modules: [{ id: 'payments', name: 'Payments', surface_ids: ['user-app'], roots: ['apps/mobile/src/payments'], summary: 'Paying bills' }],
  languages: { ts: 61234 }
};
for (const [name, v] of [['validateManifest', S.validateManifest], ['validateTerrain', S.validateTerrain],
                         ['validateRaised', S.validateRaised]]) {
  check(`${name} exists, never throws, and reports on hostile input`, () => {
    assert(typeof v === 'function', `${name} is not exported — the schema doc claims it exists`);
    for (const h of HOSTILE) noThrow(v, h, `${name}(${String(h)})`);
    for (const h of [null, 42, 'x']) assert(errorsOf(v, h).length > 0, `${name}(${String(h)}) reported nothing`);
  });
}
check('clean manifest/terrain/raised pass their validators', () => {
  assert(errorsOf(S.validateManifest, cleanManifest).length === 0, errorsOf(S.validateManifest, cleanManifest).join('; '));
  assert(errorsOf(S.validateTerrain, cleanTerrain).length === 0, errorsOf(S.validateTerrain, cleanTerrain).join('; '));
  assert(errorsOf(S.validateRaised, { raised: ['Q-001', 'Q-002'] }).length === 0, 'clean raised rejected');
});
check('manifest rejects an option-shaped cutoff_commit and a bad version', () => {
  assert(errorsOf(S.validateManifest, { ...cleanManifest, cutoff_commit: '--output=/tmp/pwn' }).length > 0, 'accepted git argv injection');
  assert(errorsOf(S.validateManifest, { ...cleanManifest, ogham_version: 99 }).length > 0, 'accepted a future schema version');
  assert(errorsOf(S.validateManifest, { ...cleanManifest, counts: { surfaces: -1 } }).length > 0, 'accepted negative counts');
});
check('terrain rejects unsafe roots, unknown surface kinds, and dangling surface_ids', () => {
  assert(errorsOf(S.validateTerrain, { ...cleanTerrain, surfaces: [{ ...cleanTerrain.surfaces[0], root: '../..' }] }).length > 0, 'accepted an escaping root');
  assert(errorsOf(S.validateTerrain, { ...cleanTerrain, surfaces: [{ ...cleanTerrain.surfaces[0], kind: 'mainframe' }] }).length > 0, 'accepted an unknown surface kind');
  assert(errorsOf(S.validateTerrain, { ...cleanTerrain, modules: [{ ...cleanTerrain.modules[0], surface_ids: ['ghost'] }] }).some(x => x.includes('ghost')), 'accepted a dangling surface_id');
});
check('raised rejects ids outside the ID grammar', () => {
  assert(errorsOf(S.validateRaised, { raised: ['Q-001', '../../etc'] }).length > 0, 'accepted a path-shaped question id');
  assert(errorsOf(S.validateRaised, { raised: ['Q-1', 'Q-1'] }).some(x => x.includes('duplicate')), 'accepted duplicate raised ids');
});

// ---- attacker text never reaches the terminal raw --------------------------

console.log('error string safety:');
check('control characters in attacker-controlled fields are escaped in errors', () => {
  // ESC + erase-line + CR: on a terminal this rewrites the line it printed on,
  // so a validator error can be made to read as a passing verdict. Both the
  // probe and the detector are built from char codes, so this file never
  // contains a literal control byte and cannot trip its own rule.
  const hasControl = s => {
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c < 9 || (c > 10 && c < 32) || c === 127) return true;
      if (c >= 128 && c <= 159) return true;
      if (c >= 0x202a && c <= 0x202e) return true;
    }
    return false;
  };
  const spoof = String.fromCharCode(27) + "[2K" + String.fromCharCode(13) + "ok    all ten checks PASS";
  const runs = [
    () => errorsOf(S.validateFact, fact({ classification: spoof })),
    () => errorsOf(S.validateFact, fact({ kind: spoof })),
    () => errorsOf(S.validateFact, fact({ id: spoof })),
    () => errorsOf(S.validateFeature, feature({ id: spoof })),
    () => errorsOf(S.validateLedgerEntry, { ...cleanLedgerEntry, status: spoof }),
    () => errorsOf(S.validateModuleFile, moduleDoc({ features: [feature({ id: spoof, fact_ids: ['ghost'] })] })),
    () => errorsOf((w, e) => S.validateWitness(w, e, 't'), { verdict: spoof }),
    () => errorsOf(S.validateConfig, { ...S.defaultConfig('t'), destination: { kind: spoof, asked: true } })
  ];
  for (const run of runs) {
    for (const msg of run()) {
      assert(!hasControl(msg), `raw control byte reached an error string: ${JSON.stringify(msg)}`);
    }
  }
});

// ---- init against a real temp dir -----------------------------------------

console.log('init:');
const quiet = () => {};
check('init scaffolds the full tree and config validates', () => {
  const dir = tmpdir();
  assert(cmdInit(dir, quiet) === 0, 'init failed');
  for (const p of ['.ogma/config.json', '.ogma/ogham/facts', '.ogma/ogham/graph', '.ogma/ogham/ledger.json', '.ogma/out']) {
    assert(fs.existsSync(path.join(dir, p)), `missing ${p}`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.ogma/config.json'), 'utf8'));
  assert(errorsOf(S.validateConfig, cfg).length === 0, 'written config invalid');
});
check('re-init preserves an existing ledger even when config.json is missing', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  const ledgerPath = path.join(dir, '.ogma/ogham/ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ questions: [cleanLedgerEntry] }));
  fs.unlinkSync(path.join(dir, '.ogma/config.json')); // the gitignored-config clone case
  assert(cmdInit(dir, quiet) === 0, 're-init failed');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert(ledger.questions.length === 1, 'LEDGER WAS DESTROYED');
  assert(fs.existsSync(path.join(dir, '.ogma/config.json')), 'config not repaired');
});
check('init refuses when .ogma is a regular file, with one clean message', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.ogma'), 'not a dir');
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 1, 'did not fail');
  assert(msgs.length === 1 && msgs[0].includes('already exists'), 'no clean message: ' + msgs.join(' | '));
});
check('fully-initialized re-run touches nothing and says so', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  const before = fs.readFileSync(path.join(dir, '.ogma/config.json'), 'utf8');
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 0, 'rerun failed');
  assert(msgs[0].includes('nothing touched'), 'wrong message');
  assert(fs.readFileSync(path.join(dir, '.ogma/config.json'), 'utf8') === before, 'config rewritten');
});
check('init refuses a symlinked .ogma instead of writing through it', () => {
  const dir = tmpdir();
  const target = tmpdir();
  const link = path.join(dir, '.ogma');
  let made = false;
  for (const type of ['junction', 'dir']) {
    try { fs.symlinkSync(target, link, type); made = true; break; } catch { /* try next */ }
  }
  // Not a silent skip: if the platform refuses both link types, say so loudly.
  assert(made, 'PLATFORM CANNOT CREATE A LINK — symlink refusal is UNTESTED on this machine');
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 1, 'init wrote through a symlink');
  assert(msgs.join(' ').includes('symlink'), 'refused without naming the reason: ' + msgs.join(' | '));
  assert(fs.readdirSync(target).length === 0, 'the link target was written into');
});
check('init refuses a symlinked ledger.json instead of writing through it', () => {
  const dir = tmpdir();
  const outside = path.join(tmpdir(), 'stolen.json');
  cmdInit(dir, quiet);
  const ledger = path.join(dir, '.ogma/ogham/ledger.json');
  fs.unlinkSync(ledger);
  let made = false;
  try { fs.symlinkSync(outside, ledger, 'file'); made = true; } catch { /* privilege */ }
  if (made) {
    const msgs = [];
    assert(cmdInit(dir, m => msgs.push(m)) === 1, 'init wrote through a symlinked ledger');
    assert(!fs.existsSync(outside), 'created a file outside the project through the link');
    return;
  }
  // File symlinks need privilege on some platforms. That is NOT license to
  // skip-and-pass (the round-4 mutation run proved this exact check was
  // decoration here): drive the same code path by making lstat itself report
  // the ledger as a symlink, so the refusal logic is verified on every machine.
  const realLstat = fs.lstatSync;
  fs.lstatSync = (p, ...rest) => {
    const st = realLstat.call(fs, p, ...rest);
    if (path.resolve(String(p)) === path.resolve(ledger)) st.isSymbolicLink = () => true;
    return st;
  };
  try {
    fs.writeFileSync(ledger, JSON.stringify({ questions: [] }));
    const msgs = [];
    assert(cmdInit(dir, m => msgs.push(m)) === 1, 'init wrote through a (simulated) symlinked ledger');
    assert(msgs.join(' ').includes('symlink'), 'refused without naming the reason: ' + msgs.join(' | '));
  } finally {
    fs.lstatSync = realLstat;
  }
});
check('init refuses a hostile existing config.json instead of adopting it', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  fs.writeFileSync(path.join(dir, '.ogma/config.json'),
    JSON.stringify({ version: 1, project: 'p', audiences: { prd: true, tech: true, guides: true },
                     destination: { kind: 'attacker-endpoint', asked: true }, language: 'en',
                     leaklint_extra: [], readability_max_grade: 10 }));
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 1, 'adopted an attacker-chosen destination and reported success');
  assert(msgs.join(' ').includes('config.json'), 'refused without naming the file: ' + msgs.join(' | '));
});
check('init refuses an oversized config.json without reading it into memory', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  const p = path.join(dir, '.ogma/config.json');
  fs.writeFileSync(p, '{"version":1,"pad":"' + 'a'.repeat(70 * 1024) + '"}');
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 1, 'accepted an oversized settings file');
  assert(msgs.join(' ').includes('limit'), 'refused without naming the limit: ' + msgs.join(' | '));
});
check('init refuses a repo-supplied config that grants its own delivery consent', () => {
  // The realistic attack uses an ALLOWLISTED kind and sets asked:true, the flag
  // meaning a human already answered. A test using an invalid kind proves the
  // allowlist works, not that the threat is stopped.
  for (const dest of [{ kind: 'confluence', asked: true }, { kind: 'markdown-only', asked: false },
                      { kind: null, asked: true }]) {
    const dir = tmpdir();
    cmdInit(dir, quiet);
    fs.writeFileSync(path.join(dir, '.ogma/config.json'),
      JSON.stringify({ ...S.defaultConfig('p'), destination: dest }));
    const msgs = [];
    assert(cmdInit(dir, m => msgs.push(m)) === 1,
      `adopted a repo-supplied destination ${JSON.stringify(dest)} and reported success`);
    assert(msgs.join(' ').includes('destination'), 'refused without naming the reason: ' + msgs.join(' | '));
  }
});
check('init still accepts a config whose destination has not been chosen', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  assert(cmdInit(dir, quiet) === 0, 'refused the config it wrote itself');
});
check('init refuses a corrupt or wrong-shaped ledger instead of reporting it healthy', () => {
  // None of these need an attacker: an interrupted write, a disk-full, an
  // unresolved merge conflict, an editor crash.
  for (const [label, body] of [['empty', ''], ['truncated', '{"questions":['],
                               ['merge conflict', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x'],
                               ['wrong shape', '[]'], ['questions not an array', '{"questions":{}}'],
                               ['invalid entry', '{"questions":[{"id":"Q 1"}]}']]) {
    const dir = tmpdir();
    cmdInit(dir, quiet);
    fs.writeFileSync(path.join(dir, '.ogma/ogham/ledger.json'), body);
    const msgs = [];
    assert(cmdInit(dir, m => msgs.push(m)) === 1, `reported a ${label} ledger as healthy`);
    assert(msgs.join(' ').includes('ledger'), `refused a ${label} ledger without naming it: ` + msgs.join(' | '));
  }
});
check('init refuses an unparseable config.json rather than reporting initialized', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  fs.writeFileSync(path.join(dir, '.ogma/config.json'), '{ not json');
  assert(cmdInit(dir, quiet) === 1, 'reported success over unparseable settings');
});
check('init keeps a valid hand-edited config unchanged', () => {
  const dir = tmpdir();
  cmdInit(dir, quiet);
  const p = path.join(dir, '.ogma/config.json');
  const edited = { ...S.defaultConfig(path.basename(dir)), readability_max_grade: 8,
                   audiences: { prd: true, tech: false, guides: true } };
  fs.writeFileSync(p, JSON.stringify(edited, null, 2) + '\n');
  const before = fs.readFileSync(p, 'utf8');
  assert(cmdInit(dir, quiet) === 0, 'rejected a valid hand-edited config');
  assert(fs.readFileSync(p, 'utf8') === before, 'overwrote a valid hand-edited config');
});

// ---- terrain: the Eyes ----------------------------------------------------

console.log('terrain:');

// Synthetic monorepo. Sizes are arbitrary but distinct so language sums are
// checkable. The [id] segment is there on purpose: the deny-list made bracket
// paths citable, so the scan must carry them through to module roots intact.
const MONO_FILES = {
  'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*', 'services/*'] }),
  'apps/web/package.json': JSON.stringify({ name: 'web', main: 'src/main.tsx', dependencies: { react: '18' } }),
  'apps/web/index.html': '<html>',
  'apps/web/src/main.tsx': 'boot',
  'apps/web/src/payments/Pay.tsx': 'pay',
  'apps/web/src/payments/History.tsx': 'hist',
  'apps/web/src/profile/Profile.tsx': 'prof',
  'apps/web/src/profile/Avatar.tsx': 'av',
  'apps/web/src/promo/[id]/Page.tsx': 'promo1',
  'apps/web/src/promo/Promo.tsx': 'promo2',
  'apps/admin/package.json': JSON.stringify({ name: 'admin-console', dependencies: { react: '18' } }),
  'apps/admin/src/index.tsx': 'boot',
  'apps/admin/src/users/List.tsx': 'list',
  'apps/admin/src/users/Edit.tsx': 'edit',
  'services/api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
  'services/api/Program.cs': 'main',
  'services/api/Payments/PaymentsController.cs': 'ctl',
  'services/api/Payments/PaymentsService.cs': 'svc',
  'services/api/Users/UsersController.cs': 'only-one-file',
  'services/worker/package.json': JSON.stringify({ name: 'queue-worker' }),
  'services/worker/src/index.js': 'boot',
  'services/worker/src/jobs/a.js': 'a',
  'services/worker/src/jobs/b.js': 'b',
  'node_modules/react/package.json': JSON.stringify({ name: 'react' }),
  'node_modules/react/index.js': 'vendored'
};
function treeOf(filesObj) {
  const entries = Object.entries(filesObj).map(([p, body]) => ({ path: p, size: Buffer.byteLength(body) }));
  const readText = (p) => Object.prototype.hasOwnProperty.call(filesObj, p) ? filesObj[p] : null;
  return { entries, readText };
}
const MONO = analyzeTree({ ...treeOf(MONO_FILES), projectName: 'mono' });

check('monorepo: four surfaces with correct kinds, workspace root skipped', () => {
  const byId = Object.fromEntries(MONO.terrain.surfaces.map(s => [s.id, s]));
  assert(MONO.terrain.surfaces.length === 4, `expected 4 surfaces, got ${MONO.terrain.surfaces.map(s => s.root).join(', ')}`);
  assert(byId.web && byId.web.kind === 'frontend', 'web not frontend');
  assert(byId.admin && byId.admin.kind === 'admin-web', 'admin not admin-web');
  assert(byId.api && byId.api.kind === 'service', 'api not service');
  assert(byId.worker && byId.worker.kind === 'worker', 'worker not worker');
  assert(MONO.notes.some(n => n.includes('workspace root')), 'workspace-root skip not noted');
});
check('monorepo: module inventory is exactly the expected set', () => {
  const ids = MONO.terrain.modules.map(m => m.id).sort();
  // api's Payments dir slugs to "payments", already taken by web -> surface-prefixed.
  assert(JSON.stringify(ids) === JSON.stringify(['api-payments', 'jobs', 'payments', 'profile', 'promo', 'users']),
    `module inventory: ${ids.join(', ')}`);
});
check('monorepo: sub-threshold directory is excluded and counted, not silently dropped', () => {
  assert(MIN_MODULE_FILES === 2, 'threshold changed — update docs/ogham-schema.md in the same commit');
  assert(!MONO.terrain.modules.some(m => m.roots.some(r => r.includes('Users'))), 'one-file dir became a module');
  assert(MONO.notes.some(n => n.includes('outside every module candidate')), 'unassigned files not reported');
});
check('monorepo: bracket path survives into module roots verbatim', () => {
  const promo = MONO.terrain.modules.find(m => m.id === 'promo');
  assert(promo && promo.roots[0] === 'apps/web/src/promo', 'promo module missing');
  assert(S.isSafeRepoPath('apps/web/src/promo/[id]/Page.tsx'), 'bracket path not citable');
});
check('monorepo: vendored directories are invisible to surfaces and languages', () => {
  assert(!MONO.terrain.surfaces.some(s => s.root.includes('node_modules')), 'node_modules became a surface');
  const vendoredBytes = Buffer.byteLength(MONO_FILES['node_modules/react/index.js']);
  const jsBytes = Buffer.byteLength(MONO_FILES['services/worker/src/index.js'])
    + Buffer.byteLength(MONO_FILES['services/worker/src/jobs/a.js'])
    + Buffer.byteLength(MONO_FILES['services/worker/src/jobs/b.js']);
  assert(MONO.terrain.languages.js === jsBytes, `js bytes ${MONO.terrain.languages.js} != ${jsBytes} (vendored ${vendoredBytes} must not count)`);
});
check('monorepo: entry points come from the manifest first, then well-known names', () => {
  const byId = Object.fromEntries(MONO.terrain.surfaces.map(s => [s.id, s]));
  assert(byId.web.entry_points[0] === 'apps/web/src/main.tsx', `web entry: ${byId.web.entry_points[0]}`);
  assert(byId.api.entry_points.includes('services/api/Program.cs'), `api entries: ${byId.api.entry_points.join(', ')}`);
  assert(byId.worker.entry_points.includes('services/worker/src/index.js'), `worker entries: ${byId.worker.entry_points.join(', ')}`);
});
check('monorepo: scan output passes validateTerrain with zero errors', () => {
  const e = errorsOf(S.validateTerrain, MONO.terrain);
  assert(e.length === 0, 'scan wrote an invalid terrain: ' + e.slice(0, 3).join('; '));
});

check('hostile manifests: broken JSON, traversal/absolute/argv-shaped bins — noted, never thrown, never followed', () => {
  // "-weird.js" is a real TRACKED file, so tree-membership alone cannot save
  // us — only the path gate can. That is the layer this check pins.
  // Both hostile shapes are REAL TRACKED FILES (git tracks argv-shaped and
  // backslash names happily), so only the intake citability rule stands
  // between them and the terrain. This check pins that rule.
  const files = {
    'a/package.json': '{ not json',
    'b/package.json': JSON.stringify({ name: 'b', main: '/abs/path.js',
      bin: { evil: '../../etc/evil', weird: '-weird.js' } }),
    'b/-weird.js': 'argv-shaped tracked file',
    'b/back\\slash.js': 'backslash tracked file',
    'b/src/x.js': 'x', 'b/src/y.js': 'y',
    'a/src/p.js': 'p', 'a/src/q.js': 'q'
  };
  let out;
  try { out = analyzeTree({ ...treeOf(files), projectName: 'h' }); }
  catch (e) { throw new Error('analyzeTree THREW on hostile manifests: ' + e.message); }
  assert(out.notes.some(n => n.includes('unparseable')), 'broken JSON not noted');
  assert(out.notes.some(n => n.includes('non-citable')), 'uncitable tracked files skipped silently');
  for (const s of out.terrain.surfaces) {
    for (const ep of s.entry_points) {
      assert(S.isSafeRepoPath(ep), `unsafe entry point escaped the gate: ${ep}`);
    }
  }
  assert(errorsOf(S.validateTerrain, out.terrain).length === 0, 'hostile tree produced invalid terrain');
});
check('analyzeTree never throws on hostile top-level shapes', () => {
  try { analyzeTree(); } catch (e) { throw new Error('THREW on no arguments: ' + e.message); }
  for (const bad of [null, undefined, 42, 'x', {}, { entries: null }, { entries: [null, 7, { path: 9 }] }]) {
    try { analyzeTree(bad === null || typeof bad !== 'object' ? { entries: bad } : bad); }
    catch (e) { throw new Error(`THREW on ${JSON.stringify(bad)}: ${e.message}`); }
  }
});
check('flat repo with no manifest: one root surface at ".", fallback module, validates', () => {
  const files = { 'main.py': 'x', 'util.py': 'y', 'helpers.py': 'z' };
  const out = analyzeTree({ ...treeOf(files), projectName: 'tool' });
  assert(out.terrain.surfaces.length === 1 && out.terrain.surfaces[0].root === '.', 'no root surface');
  assert(out.terrain.surfaces[0].entry_points.includes('main.py'), 'main.py not an entry');
  assert(out.terrain.modules.length === 1, 'no fallback module');
  const e = errorsOf(S.validateTerrain, out.terrain);
  assert(e.length === 0, 'dot-rooted terrain rejected: ' + e.slice(0, 3).join('; '));
});

check('schema: "." allowed for surface/module roots, still banned in receipts', () => {
  assert(S.isSafeRepoPathOrDot('.'), '"." rejected as a root');
  assert(!S.isSafeRepoPathOrDot('..') && !S.isSafeRepoPathOrDot(''), 'traversal/empty accepted');
  const e = [];
  S.validateReceipt({ file: '.', line: 1, symbol: 'x' }, e, 't');
  assert(e.length > 0, 'a receipt citing "." was accepted — a citation names a file');
});

check('merge: refinements win, new candidates append, languages refresh', () => {
  const existing = {
    surfaces: [{ id: 'web', kind: 'frontend', root: 'apps/web', entry_points: ['apps/web/src/main.tsx'] }],
    modules: [{ id: 'payments', name: 'Payments & Billing', surface_ids: ['web'],
                roots: ['apps/web/src/payments'], summary: 'Hand-written stakeholder summary.' }],
    languages: { ts: 1 }
  };
  const { terrain: merged, added } = mergeTerrain(existing, MONO.terrain);
  const pay = merged.modules.find(m => m.id === 'payments');
  assert(pay.name === 'Payments & Billing' && pay.summary === 'Hand-written stakeholder summary.',
    'refined module was clobbered by the scan');
  const web = merged.surfaces.find(s => s.root === 'apps/web');
  assert(web.id === 'web', 'refined surface replaced');
  assert(merged.surfaces.length === 4, `merged surfaces: ${merged.surfaces.map(s => s.root).join(', ')}`);
  assert(merged.modules.some(m => m.id === 'users'), 'new candidate not appended');
  assert(!added.some(a => a.includes('apps/web/src/payments')), 'covered module re-added');
  assert(merged.languages.ts === MONO.terrain.languages.ts, 'languages not refreshed from scan');
  const e = errorsOf(S.validateTerrain, merged);
  assert(e.length === 0, 'merge produced invalid terrain: ' + e.slice(0, 3).join('; '));
});

// End-to-end against a real git repo: the Batch 1 done-check.
function gitIn(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
function makeFixtureRepo(filesObj) {
  const dir = tmpdir();
  for (const [p, body] of Object.entries(filesObj)) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  gitIn(dir, ['init', '-q']);
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'fixture']);
  return dir;
}
check('e2e: terrain scans a real git repo at HEAD and writes a valid terrain.json', () => {
  const dir = makeFixtureRepo(MONO_FILES);
  cmdInit(dir, quiet);
  const msgs = [];
  assert(cmdTerrain(dir, m => msgs.push(m)) === 0, 'terrain failed: ' + msgs.join(' | '));
  const t = JSON.parse(fs.readFileSync(path.join(dir, '.ogma/ogham/terrain.json'), 'utf8'));
  assert(errorsOf(S.validateTerrain, t).length === 0, 'written terrain invalid');
  const ids = t.modules.map(m => m.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(['api-payments', 'jobs', 'payments', 'profile', 'promo', 'users']),
    `e2e module inventory: ${ids.join(', ')}`);
  assert(msgs.some(m => m.includes('Wrote .ogma/ogham/terrain.json')), 'no write confirmation');
});
check('e2e: scan reads HEAD, not the working tree', () => {
  const dir = makeFixtureRepo(MONO_FILES);
  cmdInit(dir, quiet);
  // Untracked surface: must NOT appear.
  fs.mkdirSync(path.join(dir, 'apps/untracked'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/untracked/package.json'), JSON.stringify({ name: 'ghost' }));
  fs.writeFileSync(path.join(dir, 'apps/untracked/a.js'), 'x');
  assert(cmdTerrain(dir, quiet) === 0, 'terrain failed');
  const t = JSON.parse(fs.readFileSync(path.join(dir, '.ogma/ogham/terrain.json'), 'utf8'));
  assert(!t.surfaces.some(s => s.root.includes('untracked')), 'scan read the working tree');
});
check('e2e: re-scan preserves a hand-refined terrain and reports nothing new', () => {
  const dir = makeFixtureRepo(MONO_FILES);
  cmdInit(dir, quiet);
  assert(cmdTerrain(dir, quiet) === 0, 'first scan failed');
  const tp = path.join(dir, '.ogma/ogham/terrain.json');
  const t = JSON.parse(fs.readFileSync(tp, 'utf8'));
  t.modules.find(m => m.id === 'payments').summary = 'Paying bills and sending money.';
  fs.writeFileSync(tp, JSON.stringify(t, null, 2));
  const msgs = [];
  assert(cmdTerrain(dir, m => msgs.push(m)) === 0, 're-scan failed');
  const t2 = JSON.parse(fs.readFileSync(tp, 'utf8'));
  assert(t2.modules.find(m => m.id === 'payments').summary === 'Paying bills and sending money.',
    'RE-SCAN CLOBBERED A REFINED SUMMARY');
  assert(msgs.some(m => m.includes('nothing new to add')), 'merge not reported: ' + msgs.join(' | '));
});
check('e2e: terrain refuses an invalid existing terrain.json rather than merging into it', () => {
  const dir = makeFixtureRepo(MONO_FILES);
  cmdInit(dir, quiet);
  fs.writeFileSync(path.join(dir, '.ogma/ogham/terrain.json'), '{ not json');
  const msgs = [];
  assert(cmdTerrain(dir, m => msgs.push(m)) === 1, 'merged into garbage');
  assert(msgs.join(' ').includes('terrain.json'), 'refused without naming the file');
});
check('e2e: terrain before init refuses and says to init', () => {
  const dir = makeFixtureRepo({ 'a.js': 'x' });
  const msgs = [];
  assert(cmdTerrain(dir, m => msgs.push(m)) === 1, 'ran without .ogma');
  assert(msgs.join(' ').includes('ogma init'), 'did not point at init');
});
check('e2e: not a git repo / no commits — honest refusal, no crash', () => {
  const bare = tmpdir();
  cmdInit(bare, quiet);
  const msgs = [];
  assert(cmdTerrain(bare, m => msgs.push(m)) === 1, 'scanned a non-repo');
  const empty = tmpdir();
  cmdInit(empty, quiet);
  gitIn(empty, ['init', '-q']);
  const msgs2 = [];
  assert(cmdTerrain(empty, m => msgs2.push(m)) === 1, 'scanned a repo with no commits');
});

// ---- receipt verifier: the deterministic Nerves ---------------------------

console.log('verify:');

const SRC = [
  'import { limits } from "./limits";',          // 1
  '',                                            // 2
  'export function validateDailyLimit(x) {',     // 3
  '  return x < limits.daily;',                  // 4
  '}',                                           // 5
  '',                                            // 6
  'export class PaymentsService {',              // 7
  '  pay(amount) { return validateDailyLimit(amount); }', // 8
  '}'                                            // 9
].join('\n');
const readFixture = (p) => p === 'src/payments/service.ts' ? SRC : null;
const rc = (over) => ({ file: 'src/payments/service.ts', line: 3, symbol: 'validateDailyLimit', ...over });

check('clean receipt verifies', () => {
  const v = V.verifyReceipt(rc(), readFixture);
  assert(v.ok === true, `rejected a true citation: ${v.reason} ${v.detail}`);
});
check('planted fakes are rejected, each with its named reason', () => {
  const cases = [
    [rc({ file: 'src/payments/ghost.ts' }), 'missing-file'],
    [rc({ line: 40 }), 'bad-line'],
    [rc({ symbol: 'validateMonthlyLimit' }), 'symbol-not-found'],
    [rc({ file: '../etc/passwd' }), 'invalid-receipt'],
    [rc({ line: 0 }), 'invalid-receipt']
  ];
  for (const [receipt, reason] of cases) {
    const v = V.verifyReceipt(receipt, readFixture);
    assert(v.ok === false && v.reason === reason, `expected ${reason}, got ${v.ok ? 'PASS' : v.reason}`);
  }
});
check('a substring is not the symbol — whole-word only', () => {
  const v = V.verifyReceipt(rc({ symbol: 'Limit' }), readFixture);
  assert(v.ok === false && v.reason === 'symbol-not-found', 'verified "Limit" against "validateDailyLimit"');
  const v2 = V.verifyReceipt(rc({ symbol: 'validate' }), readFixture);
  assert(v2.ok === false, 'verified "validate" as a prefix substring');
});
check('drift window: within ±5 verifies, one past it does not', () => {
  // PaymentsService appears exactly ONCE (line 7) — the drift probe needs a
  // symbol with a single occurrence, or a second occurrence inside the window
  // silently rescues the out-of-drift case (which is how this check first
  // shipped wrong).
  assert(V.verifyReceipt(rc({ line: 2, symbol: 'PaymentsService' }), readFixture).ok === true,
    'line 2 (drift +5 reaches 7) rejected');
  assert(V.verifyReceipt(rc({ line: 1, symbol: 'PaymentsService' }), readFixture).ok === false,
    'line 1 (drift +5 reaches only 6) accepted');
  // ...and the FLOOR side, with 'import' (single occurrence, line 1): a
  // mutant that unclamps `lo` floats every window back to the file start and
  // both hi-side probes above still pass — this pair is what catches it.
  assert(V.verifyReceipt(rc({ line: 6, symbol: 'import' }), readFixture).ok === true,
    'line 6 (drift -5 reaches 1) rejected');
  assert(V.verifyReceipt(rc({ line: 7, symbol: 'import' }), readFixture).ok === false,
    'line 7 (drift -5 reaches only 2) accepted — the window floor is not being enforced');
  assert(S.RECEIPT_DRIFT_WINDOW === 5, 'drift window changed — update this check and the docs');
});
check('CRLF and LF content verify identically', () => {
  const crlf = (p) => p === 'src/payments/service.ts' ? SRC.replace(/\n/g, '\r\n') : null;
  assert(V.verifyReceipt(rc(), crlf).ok === true, 'CRLF blob rejected');
  assert(V.verifyReceipt(rc({ line: 40 }), crlf).ok === false, 'CRLF line count drifted');
});
check('real-world symbol shapes verify: operator==, #private, non-ASCII', () => {
  const files = {
    'a.cpp': 'bool operator==(const T& a, const T& b) { return a.v == b.v; }',
    'b.js': 'class W { #balance = 0; get balance() { return this.#balance; } }',
    'c.py': 'def プロフィール(user):\n    return user'
  };
  const read = (p) => files[p] || null;
  assert(V.verifyReceipt({ file: 'a.cpp', line: 1, symbol: 'operator==' }, read).ok, 'operator== rejected');
  assert(V.verifyReceipt({ file: 'b.js', line: 1, symbol: '#balance' }, read).ok, '#private rejected');
  assert(V.verifyReceipt({ file: 'c.py', line: 1, symbol: 'プロフィール' }, read).ok, 'non-ASCII rejected');
  assert(V.verifyReceipt({ file: 'c.py', line: 1, symbol: 'プロフィ' }, read).ok === false, 'non-ASCII substring verified');
});
check('oversized file fails with its own reason, never an unbounded read', () => {
  const read = () => ({ toolarge: true });
  const v = V.verifyReceipt(rc(), read);
  assert(v.ok === false && v.reason === 'file-too-large', `got ${v.reason}`);
});
check('batch: counts, caching, hostile shapes', () => {
  let reads = 0;
  const counting = (p) => { reads++; return readFixture(p); };
  const batch = V.verifyReceipts([rc(), rc({ line: 4, symbol: 'limits' }), rc({ symbol: 'nope' })], counting);
  assert(batch.total === 3 && batch.failed === 1 && batch.ok === false, `total ${batch.total} failed ${batch.failed}`);
  assert(reads === 1, `file read ${reads} times for 3 receipts in one file`);
  const hostile = V.verifyReceipts(null, readFixture);
  assert(hostile.total === 0 && hostile.ok === false, 'null batch reported as verified');
  const empty = V.verifyReceipts([], readFixture);
  assert(empty.total === 0 && empty.failed === 0, 'empty batch miscounted');
});
check('e2e: git reader verifies at the PINNED commit, not at HEAD', () => {
  const dir = makeFixtureRepo({ 'src/service.js': 'function validateDailyLimit(x) { return x < 500; }\n' });
  const c1 = gitIn(dir, ['rev-parse', 'HEAD']).trim();
  // The function is renamed at HEAD; the receipt was written at c1.
  fs.writeFileSync(path.join(dir, 'src/service.js'), 'function checkLimit(x) { return x < 500; }\n');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'rename']);
  const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
  const receipt = { file: 'src/service.js', line: 1, symbol: 'validateDailyLimit' };
  assert(V.verifyReceipt(receipt, V.makeGitReader(dir, c1)).ok === true, 'true citation rejected at its own commit');
  const atHead = V.verifyReceipt(receipt, V.makeGitReader(dir, head));
  assert(atHead.ok === false && atHead.reason === 'symbol-not-found', 'stale citation still verified at HEAD — invalidation is blind');
  const ghost = V.verifyReceipt({ file: 'src/ghost.js', line: 1, symbol: 'x' }, V.makeGitReader(dir, c1));
  assert(ghost.ok === false && ghost.reason === 'missing-file', 'missing file not named');
});
check('git reader refuses a non-commitish before it reaches argv', () => {
  let threw = false;
  try { V.makeGitReader('.', '--output=evil'); } catch { threw = true; }
  assert(threw, 'option-shaped commit accepted into git argv');
});

// ---- graph: the structural Nerves -----------------------------------------

const GRAPH_FILES = {
  'src/routes.ts': 'import { payHandler } from "./handlers";\napp.post("/payments", payHandler);\n',
  'src/handlers.ts': 'export function payHandler(req) {\n  return checkLimits(req.amount);\n}\nconst helper = (x) => transform(x);\n',
  'src/rules.ts': 'export function checkLimits(x) {\n  return validateDailyLimit(x);\n}\nexport function validateDailyLimit(x) {\n  return x < 500;\n}\nexport function unusedRule(x) { return x; }\n',
  'src/svc.py': 'class Wallet:\n    def balance(self):\n        return fetch_balance()\n\ndef fetch_balance():\n    return 0\n',
  'src/Api.cs': 'public class PaymentsController {\n  public void Pay() { Validate(); }\n  private void Validate() {}\n}\n',
  'README.md': 'not code',
  'src/huge.js': 'x'
};

async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name} — ${e.message}`); }
}

async function graphChecks() {
  console.log('graph:');
  const entries = Object.entries(GRAPH_FILES).map(([p, body]) =>
    ({ path: p, size: p === 'src/huge.js' ? G.MAX_PARSE_BYTES + 1 : Buffer.byteLength(body) }));
  const readText = (p) => Object.prototype.hasOwnProperty.call(GRAPH_FILES, p) ? GRAPH_FILES[p] : null;
  const { index } = await G.indexTree({ entries, readText, commit: 'abc1234' });
  const fileOf = (p) => index.files.find(f => f.path === p);

  await checkAsync('multi-language extraction: kinds, lines, containers exact', () => {
    const cs = fileOf('src/Api.cs');
    assert(JSON.stringify(cs.symbols.map(s => [s.kind, s.name, s.line, s.container || null])) ===
      JSON.stringify([['class', 'PaymentsController', 1, null], ['method', 'Pay', 2, 'PaymentsController'], ['method', 'Validate', 3, 'PaymentsController']]),
      'C# symbols: ' + JSON.stringify(cs.symbols));
    const py = fileOf('src/svc.py');
    assert(py.symbols.some(s => s.name === 'balance' && s.container === 'Wallet'), 'python method container lost');
    assert(py.calls.some(c => c.name === 'fetch_balance' && c.from === 'balance'), 'python call edge lost');
    const ts = fileOf('src/handlers.ts');
    assert(ts.symbols.some(s => s.name === 'helper' && s.kind === 'function'), 'arrow binding not indexed');
  });
  await checkAsync('route -> handler -> rule traces end to end with hop locations', () => {
    const t = G.trace(index, '(top)', 'validateDailyLimit');
    assert(t !== null, 'no chain found');
    assert(JSON.stringify(t.map(h => h.symbol)) === JSON.stringify(['(top)', 'payHandler', 'checkLimits', 'validateDailyLimit']),
      'chain: ' + t.map(h => h.symbol).join(' -> '));
    assert(t[1].file === 'src/routes.ts' && t[1].line === 2, 'handler hop lost its registration site');
    assert(t[3].file === 'src/rules.ts' && t[3].line === 2, 'rule hop lost its call site');
  });
  await checkAsync('a chain that does not exist traces to null, not to a guess', () => {
    assert(G.trace(index, '(top)', 'ghostRule') === null, 'traced to a symbol that does not exist');
    assert(G.trace(index, 'unusedRule', 'payHandler') === null, 'traced backwards through a forward edge');
  });
  await checkAsync('reachability: dead code is unreached, wired code is reached', () => {
    const reach = G.reachableFrom(index, ['(top)']);
    assert(reach.has('validateDailyLimit'), 'live rule unreached');
    assert(!reach.has('unusedRule'), 'dead rule reported reachable — the LIVE/DEAD signal is broken');
  });
  await checkAsync('impact is transitive: changing the rule reaches the route, not just its caller', () => {
    const impact = G.impactOf(index, 'validateDailyLimit');
    assert(impact.has('checkLimits'), 'direct caller missing from impact');
    assert(impact.has('payHandler') && impact.has('(top)'), 'transitive impact stopped at the direct caller');
    assert(!impact.has('validateDailyLimit'), 'a symbol impacts itself');
    assert(!impact.has('unusedRule'), 'an unrelated symbol appears in the impact set');
  });
  await checkAsync('skipped files are counted by reason, never silently absent', () => {
    assert(index.skipped.unsupported >= 1, 'README not counted as unsupported');
    assert(index.skipped.too_large === 1, 'oversized file not counted');
    assert(!fileOf('src/huge.js'), 'oversized file was parsed anyway');
  });
  await checkAsync('indexing is deterministic: same inputs, byte-identical JSON', async () => {
    const second = await G.indexTree({ entries: [...entries].reverse(), readText, commit: 'abc1234' });
    assert(JSON.stringify(index) === JSON.stringify(second.index), 'two runs disagree');
  });
  await checkAsync('graph validator: clean index passes, planted violations rejected, hostile never throws', () => {
    assert(errorsOf(S.validateGraphIndex, index).length === 0, 'clean index rejected');
    for (const bad of [null, 42, {}, { graph_version: 1, commit: null, skipped: {}, files: {} }]) {
      noThrow(S.validateGraphIndex, bad, 'validateGraphIndex');
      assert(errorsOf(S.validateGraphIndex, bad).length > 0, `accepted hostile ${JSON.stringify(bad)}`);
    }
    const dup = JSON.parse(JSON.stringify(index));
    dup.files.push(dup.files[0]);
    assert(errorsOf(S.validateGraphIndex, dup).some(e => e.includes('duplicate')), 'duplicate path accepted');
    const evil = JSON.parse(JSON.stringify(index));
    evil.files[0].symbols[0].name = 'bad' + String.fromCharCode(27) + 'name';
    assert(errorsOf(S.validateGraphIndex, evil).length > 0, 'control-char symbol name accepted');
  });
  await checkAsync('e2e: ogma graph indexes a real git repo at HEAD into a valid index.json', async () => {
    const dir = makeFixtureRepo(GRAPH_FILES);
    cmdInit(dir, quiet);
    const msgs = [];
    assert(await G.cmdGraph(dir, m => msgs.push(m)) === 0, 'graph failed: ' + msgs.join(' | '));
    const idx = JSON.parse(fs.readFileSync(path.join(dir, '.ogma/ogham/graph/index.json'), 'utf8'));
    assert(errorsOf(S.validateGraphIndex, idx).length === 0, 'written index invalid');
    const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    assert(idx.commit === head, `index commit ${idx.commit} != HEAD ${head}`);
    assert(G.trace(idx, '(top)', 'validateDailyLimit') !== null, 'chain lost through git round-trip');
  });
  await checkAsync('symbol-table-backed verification: tightens on mentions, never loosens on ignorance', async () => {
    // Line 2 MENTIONS validateDailyLimit in a comment; the real definition is
    // far below, outside the drift window. Text-backed verification passes
    // (documented limit); graph-backed must reject.
    const body = '// TODO: validateDailyLimit is called here\n'.repeat(1)
      + 'const cfg = 1;\n'.repeat(20)
      + 'export function validateDailyLimit(x) { return x < 500; }\n';
    const files = { 'src/deep.ts': body };
    const read = (p) => files[p] || null;
    const { index: gidx } = await G.indexTree({
      entries: [{ path: 'src/deep.ts', size: Buffer.byteLength(body) }],
      readText: read, commit: 'abc1234'
    });
    const mention = { file: 'src/deep.ts', line: 1, symbol: 'validateDailyLimit' };
    assert(V.verifyReceipt(mention, read).ok === true, 'text-backed baseline changed — update this check');
    const refined = V.verifyReceipt(mention, read, gidx);
    assert(refined.ok === false && refined.reason === 'symbol-not-found',
      'graph-backed verification accepted a comment mention as the code');
    const real = V.verifyReceipt({ file: 'src/deep.ts', line: 22, symbol: 'validateDailyLimit' }, read, gidx);
    assert(real.ok === true && real.via === 'graph', 'true citation rejected under the graph');
    // Symbols the graph cannot know (a variable) still verify by text.
    const variable = V.verifyReceipt({ file: 'src/deep.ts', line: 2, symbol: 'cfg' }, read, gidx);
    assert(variable.ok === true, "graph ignorance rejected a legitimate receipt — the rule must only tighten");
  });
  await checkAsync('e2e: graph before init refuses', async () => {
    const dir = makeFixtureRepo({ 'a.js': 'x' });
    const msgs = [];
    assert(await G.cmdGraph(dir, m => msgs.push(m)) === 1, 'ran without .ogma');
    assert(msgs.join(' ').includes('ogma init'), 'did not point at init');
  });
}

// ---- ingest: the deterministic bookend ------------------------------------

// A complete, VALID mini-Ogham on a real git repo. Every planted violation
// below clones this base and breaks exactly one thing; the forged-hash and
// mutation cases keep this self-authored fixture honest.
async function buildWholeOgham(extraFiles = {}) {
  const dir = makeFixtureRepo({ ...GRAPH_FILES, ...extraFiles });
  cmdInit(dir, quiet);
  const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(dir, '.ogma/ogham/terrain.json'), JSON.stringify({
    surfaces: [{ id: 'app', kind: 'frontend', root: '.', entry_points: ['src/routes.ts'] },
               { id: 'sync', kind: 'worker', root: 'src', entry_points: ['src/svc.py'] }],
    modules: [{ id: 'payments', name: 'Payments', surface_ids: ['app'], roots: ['src'], summary: 'Paying and limits.' }],
    languages: { ts: 1 }
  }, null, 2));
  assert(await G.cmdGraph(dir, quiet) === 0, 'fixture graph failed');
  const reader = V.makeGitReader(dir, head);

  const r1 = [{ file: 'src/rules.ts', line: 4, end_line: 6, symbol: 'validateDailyLimit' }];
  const s1 = 'Payments over the daily limit are rejected.';
  const h1 = W.factInputHash(s1, r1, reader);
  assert(h1.hash, 'fixture hash 1 failed: ' + h1.error);
  const r2 = [{ file: 'src/rules.ts', line: 7, symbol: 'unusedRule' }];
  const s2 = 'A spare rule exists with no caller.';
  const h2 = W.factInputHash(s2, r2, reader);
  assert(h2.hash, 'fixture hash 2 failed: ' + h2.error);

  const factsDoc = {
    module: 'payments',
    features: [{
      id: 'FEAT-payments-pay', name: 'Pay within the daily limit', classification: 'UNCLEAR',
      does: 'User submits a payment.', happens: 'The amount is checked against the daily limit.',
      sees: 'A rejection when over the limit.', fact_ids: ['FACT-payments-001', 'FACT-payments-002']
    }],
    facts: [
      { id: 'FACT-payments-001', feature_id: 'FEAT-payments-pay', kind: 'rule',
        statement: s1, classification: 'LIVE', receipts: r1, status: 'fresh', verified_at_commit: head,
        path: { entry: 'POST /payments', exit: '4xx rejection', chain: [
          { hop: 'payHandler', receipt: { file: 'src/handlers.ts', line: 1, symbol: 'payHandler' } },
          { hop: 'checkLimits', receipt: { file: 'src/rules.ts', line: 1, symbol: 'checkLimits' } },
          { hop: 'validateDailyLimit', receipt: { file: 'src/rules.ts', line: 4, symbol: 'validateDailyLimit' } }
        ] },
        witness: { verdict: 'CONFIRMED', checked_at_commit: head, checker: 'bench-blind-1', input_hash: h1.hash } },
      { id: 'FACT-payments-002', feature_id: 'FEAT-payments-pay', kind: 'state',
        statement: s2, classification: 'UNCLEAR', receipts: r2, ledger_refs: ['Q-001'],
        witness: { verdict: 'UNSUPPORTED', checked_at_commit: head, checker: 'bench-blind-1', input_hash: h2.hash } }
    ]
  };
  fs.mkdirSync(path.join(dir, '.ogma/ogham/facts'), { recursive: true });
  const factsPath = path.join(dir, '.ogma/ogham/facts/payments.json');
  fs.writeFileSync(factsPath, JSON.stringify(factsDoc, null, 2));
  fs.writeFileSync(path.join(dir, '.ogma/ogham/ledger.json'), JSON.stringify({ questions: [
    { id: 'Q-001', question: 'Is unusedRule meant to be wired to a route?', status: 'open',
      classification_context: 'UNCLEAR', receipts: r2 }
  ] }, null, 2));
  fs.writeFileSync(path.join(dir, '.ogma/ogham/raised.json'), JSON.stringify({ raised: ['Q-001'] }, null, 2));
  return { dir, head, factsPath, factsDoc };
}

async function ingestChecks() {
  console.log('ingest:');
  const base = await buildWholeOgham();

  await checkAsync('a whole Ogham ingests: exit 0, valid manifest, honest counts', async () => {
    const msgs = [];
    assert(cmdIngest(base.dir, m => msgs.push(m)) === 0, 'whole Ogham rejected: ' + msgs.join(' | '));
    const m = JSON.parse(fs.readFileSync(path.join(base.dir, '.ogma/ogham/manifest.json'), 'utf8'));
    assert(errorsOf(S.validateManifest, m).length === 0, 'manifest invalid');
    assert(m.counts.facts === 2 && m.counts.features === 1 && m.counts.ledger_open === 1 && m.counts.modules === 1,
      'counts wrong: ' + JSON.stringify(m.counts));
    assert(S.sameCommit(m.cutoff_commit, base.head), 'manifest not bound to HEAD');
  });
  await checkAsync('a forged witness hash is named, and nothing is written', async () => {
    const { dir, factsPath, factsDoc } = await buildWholeOgham();
    const doc = JSON.parse(JSON.stringify(factsDoc));
    doc.facts[0].witness.input_hash = 'a'.repeat(64);
    fs.writeFileSync(factsPath, JSON.stringify(doc, null, 2));
    fs.rmSync(path.join(dir, '.ogma/ogham/manifest.json'), { force: true });
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 1, 'forged hash ingested');
    assert(msgs.join(' ').includes('forged or stale'), 'forgery not named: ' + msgs.join(' | ').slice(0, 300));
    assert(!fs.existsSync(path.join(dir, '.ogma/ogham/manifest.json')), 'manifest written despite findings');
  });
  await checkAsync('editing a statement after its ruling breaks the binding', async () => {
    const { dir, factsPath, factsDoc } = await buildWholeOgham();
    const doc = JSON.parse(JSON.stringify(factsDoc));
    doc.facts[0].statement = 'Payments of any size are accepted.';   // hash left untouched
    fs.writeFileSync(factsPath, JSON.stringify(doc, null, 2));
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 1, 'a reworded statement kept its old ruling');
    assert(msgs.join(' ').includes('forged or stale'), 'stale binding not named');
    // ...and the other reuse direction: same statement, same hash, DIFFERENT
    // cited code. A ruling must not survive being pointed at other evidence.
    const two = await buildWholeOgham();
    const doc2 = JSON.parse(JSON.stringify(two.factsDoc));
    doc2.facts[0].receipts = [{ file: 'src/rules.ts', line: 1, end_line: 3, symbol: 'checkLimits' }];
    fs.writeFileSync(two.factsPath, JSON.stringify(doc2, null, 2));
    const msgs2 = [];
    assert(cmdIngest(two.dir, m => msgs2.push(m)) === 1, 'a ruling survived a receipt swap');
    assert(msgs2.join(' ').includes('forged or stale'), 'receipt-swap reuse not named');
  });
  await checkAsync('a fake citation fails ingest with the verifier reason', async () => {
    const { dir, factsPath, factsDoc } = await buildWholeOgham();
    const doc = JSON.parse(JSON.stringify(factsDoc));
    doc.facts[1].receipts = [{ file: 'src/rules.ts', line: 7, symbol: 'ghostFunction' }];
    fs.writeFileSync(factsPath, JSON.stringify(doc, null, 2));
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 1, 'fake citation ingested');
    assert(msgs.join(' ').includes('symbol-not-found'), 'verifier reason missing: ' + msgs.join(' | ').slice(0, 300));
  });
  await checkAsync('facts <-> terrain reconcile in both directions', async () => {
    const { dir } = await buildWholeOgham();
    fs.writeFileSync(path.join(dir, '.ogma/ogham/facts/ghost.json'), JSON.stringify({
      module: 'ghost', features: [], facts: [], empty_reason: 'planted orphan'
    }, null, 2));
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 1, 'orphan facts file ingested');
    assert(msgs.join(' ').includes('terrain does not know'), 'orphan direction not named');
    const two = await buildWholeOgham();
    fs.rmSync(two.factsPath);
    const msgs2 = [];
    assert(cmdIngest(two.dir, m => msgs2.push(m)) === 1, 'missing facts file ingested');
    assert(msgs2.join(' ').includes('no facts file'), 'missing direction not named');
  });
  await checkAsync('dangling ledger_refs and raised ids are findings', async () => {
    const { dir, factsPath, factsDoc } = await buildWholeOgham();
    const doc = JSON.parse(JSON.stringify(factsDoc));
    doc.facts[1].ledger_refs = ['Q-999'];
    fs.writeFileSync(factsPath, JSON.stringify(doc, null, 2));
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 1, 'dangling ledger_ref ingested');
    assert(msgs.join(' ').includes('resolves to no ledger question'), 'dangling ref not named');
  });
  await checkAsync('a stale graph refuses ingest and says how to fix it', async () => {
    const { dir } = await buildWholeOgham();
    fs.writeFileSync(path.join(dir, 'newfile.js'), 'function later() {}\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'move HEAD']);
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 1, 'stale graph ingested');
    assert(msgs.join(' ').includes('re-run `ogma graph`'), 'fix not pointed at');
  });
  await checkAsync('after HEAD moves: re-graph, and old-commit facts still verify at their own commit', async () => {
    const { dir, head } = await buildWholeOgham();
    fs.writeFileSync(path.join(dir, 'newfile.js'), 'function later() {}\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'move HEAD']);
    assert(await G.cmdGraph(dir, quiet) === 0, 're-graph failed');
    const msgs = [];
    assert(cmdIngest(dir, m => msgs.push(m)) === 0, 'pinned-commit facts rejected after HEAD moved: ' + msgs.join(' | ').slice(0, 300));
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.ogma/ogham/manifest.json'), 'utf8'));
    assert(!S.sameCommit(m.cutoff_commit, head), 'manifest still bound to the old commit');
  });
}

// ---- render: the Voices ---------------------------------------------------

async function renderChecks() {
  console.log('render:');
  const base = await buildWholeOgham();
  assert(cmdIngest(base.dir, quiet) === 0, 'render fixture failed ingest');
  const R = require('../lib/render');
  const read = (rel) => fs.readFileSync(path.join(base.dir, '.ogma/out', rel), 'utf8');

  await checkAsync('one fact renders three ways, each carrying its annotation', () => {
    assert(R.cmdPrd(base.dir, quiet) === 0, 'prd failed');
    assert(R.cmdExplain(base.dir, quiet) === 0, 'explain failed');
    assert(R.cmdGuides(base.dir, quiet) === 0, 'guides failed');
    for (const doc of ['prd.md', 'tech/payments.md', 'guides/app.md']) {
      const anns = R.parseAnnotations(read(doc));
      assert(anns.some(a => a.kind === 'fact' && a.id === 'FACT-payments-001'),
        `${doc} does not carry fact:FACT-payments-001`);
    }
    assert(read('prd.md').includes('What you do:'), 'prd narration missing');
    assert(read('guides/app.md').includes('Good to know:'), 'guide rule missing');
    assert(read('tech/payments.md').includes('witness CONFIRMED'), 'tech witness badge missing');
  });
  await checkAsync('doubt never reaches business or guide readers, and always reaches engineers', () => {
    for (const doc of ['prd.md', 'guides/app.md']) {
      assert(!read(doc).includes('FACT-payments-002'), `${doc} leaked a non-LIVE fact`);
      assert(!read(doc).includes('spare rule'), `${doc} leaked non-LIVE prose`);
    }
    const tech = read('tech/payments.md');
    assert(tech.includes('FACT-payments-002') && tech.includes('UNSUPPORTED') && tech.includes('Q-001'),
      'tech notes hide the doubt');
  });
  await checkAsync('a stale LIVE fact drops from prd/guides and is marked in tech', async () => {
    const two = await buildWholeOgham();
    assert(cmdIngest(two.dir, quiet) === 0, 'clone ingest failed');
    const doc = JSON.parse(JSON.stringify(two.factsDoc));
    doc.facts[0].status = 'stale';
    fs.writeFileSync(two.factsPath, JSON.stringify(doc, null, 2));
    const r2 = (rel) => fs.readFileSync(path.join(two.dir, '.ogma/out', rel), 'utf8');
    assert(R.cmdPrd(two.dir, quiet) === 0 && R.cmdGuides(two.dir, quiet) === 0 && R.cmdExplain(two.dir, quiet) === 0, 'render failed');
    assert(!r2('prd.md').includes('FACT-payments-001'), 'stale fact still in the PRD');
    assert(r2('guides/app.md').includes('Nothing is live'), 'stale feature still narrated in guides');
    assert(r2('tech/payments.md').includes('[STALE'), 'tech does not mark staleness');
  });
  await checkAsync('non-interactive surfaces get no guide, and the exemption is visible in output', () => {
    assert(!fs.existsSync(path.join(base.dir, '.ogma/out/guides/sync.md')), 'a worker surface got a user guide');
    assert(fs.existsSync(path.join(base.dir, '.ogma/out/guides/app.md')), 'the interactive surface got none');
  });
  await checkAsync('questions.md carries id, status, and the citing receipt', () => {
    assert(R.cmdQuestions(base.dir, quiet) === 0, 'questions failed');
    const q = read('questions.md');
    assert(q.includes('Q-001') && q.includes('[open]') && q.includes('src/rules.ts:7'), 'ledger render incomplete: ' + q.slice(0, 200));
  });
  await checkAsync('annotations strip cleanly for the lint and readability passes', () => {
    const stripped = R.stripAnnotations(read('prd.md'));
    assert(!stripped.includes('<!--'), 'stripAnnotations left a comment behind');
    assert(stripped.includes('What you do:'), 'stripping removed real prose');
  });
  await checkAsync('renderers refuse an Ogham that never passed ingest', async () => {
    const three = await buildWholeOgham();   // no ingest run -> no manifest
    for (const [name, fn] of [['prd', R.cmdPrd], ['explain', R.cmdExplain], ['guides', R.cmdGuides], ['questions', R.cmdQuestions]]) {
      const msgs = [];
      assert(fn(three.dir, m => msgs.push(m)) === 1, `${name} rendered without a manifest`);
      assert(msgs.join(' ').includes('ogma ingest'), `${name} did not point at ingest`);
    }
  });
  await checkAsync('a disabled audience refuses instead of rendering', () => {
    const cfgPath = path.join(base.dir, '.ogma/config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.audiences.prd = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    assert(R.cmdPrd(base.dir, quiet) === 1, 'rendered a disabled audience');
    cfg.audiences.prd = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  });
  await checkAsync('renderers read only the Ogham: no repo access in the source', () => {
    // Matches the require form only — the file's own header comment states
    // the prohibition in prose, and a check that fires on its own rule's
    // statement is the CHI-R001 self-match defect.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'render.js'), 'utf8');
    assert(!src.includes("require('child_process')") && !src.includes('spawnSync('), 'render.js reaches for the repo');
  });
}

// ---- gate: ten checks and the certificate ---------------------------------

async function gateChecks() {
  console.log('gate:');
  const GATE = require('../lib/gate');

  // Full pipeline to a certifiable state. map.md is written by the bench as a
  // placeholder for the Batch 6 slot — the gate checks document EXISTENCE
  // here (content checks for the map arrive with the map); the without-map
  // case below pins that the requirement is real, not bypassed.
  async function certifiable() {
    const b = await buildWholeOgham();
    const R = require('../lib/render');
    assert(cmdIngest(b.dir, quiet) === 0, 'gate fixture: ingest failed');
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'gate fixture: render failed');
    assert(require('../lib/map').cmdMap(b.dir, quiet) === 0, 'gate fixture: map failed');
    return b;
  }
  const certOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.ogma/certificate.json'), 'utf8'));
  const failing = (cert, name) => cert.checks.find(c => c.check === name && c.pass === false);

  await checkAsync('a whole, rendered, bound Ogham certifies: PASS, 10/10, certificate validates', async () => {
    const b = await certifiable();
    const msgs = [];
    assert(GATE.cmdGate(b.dir, m => msgs.push(m)) === 0, 'gate failed a certifiable Ogham: ' + msgs.join(' | '));
    const cert = certOf(b.dir);
    assert(errorsOf(S.validateCertificate, cert).length === 0, 'certificate invalid');
    assert(cert.pass === true && cert.checks.length === 10 && cert.checks.every(c => c.pass), 'not 10/10');
    assert(Array.isArray(cert.documents) && cert.documents.length > 0
      && cert.documents.every(d => /^[0-9a-f]{64}$/.test(d.sha256)), 'certificate does not bind document bytes');
    assert(!cert.documents.some(d => /^map\./.test(d.path)), 'map views must not be listed as certified bytes');
    assert(msgs.some(m => m.includes('PASS')), 'no badge line');
  });
  await checkAsync('a missing expected document fails coverage — and the certificate says FAIL', async () => {
    const b = await certifiable();
    fs.rmSync(path.join(b.dir, '.ogma/out/map.md'));
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'gate passed with a missing document');
    const cert = certOf(b.dir);
    assert(cert.pass === false && failing(cert, 'coverage'), 'coverage did not fail');
    assert(failing(cert, 'coverage').detail.includes('map.md'), 'missing doc not named');
  });
  await checkAsync('leaklint: technical vocabulary in the PRD fails; the same word in a code span is exempt', async () => {
    // The code-span exemption is pinned at the unit level: schema-level prose
    // rules now keep backticks out of every authored field, so a code span
    // can no longer be smuggled INTO a business document — but receipts and
    // hand-written extras must stay exempt wherever the lint runs.
    assert(GATE.leakHits('See the `endpoint` label on screen.', []).length === 0, 'a code-span term was counted as a leak');
    assert(GATE.leakHits('Our API endpoint returns a JSON payload.', []).length > 0, 'a plain technical term passed the unit lint');
    // The gate-level path: a term the config bans that genuinely renders in
    // the PRD (out documents are Ogham-derived now — hand-appending to
    // out/prd.md fails freshness, so the leak must arrive through content).
    const b = await certifiable();
    const cfgPath = path.join(b.dir, '.ogma/config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.leaklint_extra = ['payment'];   // present in the fixture fact statement
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'a banned term rendered in the PRD passed the lint');
    const det = failing(certOf(b.dir), 'leaklint').detail;
    assert(det.includes('payment') && det.includes('prd.md'), 'leak not named with its file: ' + det);
  });
  await checkAsync('readability is measured per document against config', async () => {
    const b = await certifiable();
    const cfgPath = path.join(b.dir, '.ogma/config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.readability_max_grade = 0.1;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'an impossible grade ceiling still passed');
    assert(failing(certOf(b.dir), 'readability').detail.includes('grade'), 'grade not reported');
  });
  await checkAsync('an annotation that resolves to nothing fails integrity', async () => {
    const b = await certifiable();
    fs.appendFileSync(path.join(b.dir, '.ogma/out/prd.md'), '\nGhost claim. <!-- fact:FACT-ghost -->\n');
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'an orphan annotation certified');
    assert(failing(certOf(b.dir), 'integrity').detail.includes('FACT-ghost'), 'orphan annotation not named');
  });
  await checkAsync('an Ogham not bound to HEAD fails integrity', async () => {
    const b = await certifiable();
    fs.writeFileSync(path.join(b.dir, 'later.js'), 'x\n');
    gitIn(b.dir, ['add', '-A']);
    gitIn(b.dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'drift']);
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'a stale Ogham certified');
    assert(failing(certOf(b.dir), 'integrity').detail.includes('HEAD'), 'binding failure not named');
  });
  await checkAsync('post-ingest tampering is re-caught at the boundary: receipts and witness', async () => {
    const b = await certifiable();
    const doc = JSON.parse(JSON.stringify(b.factsDoc));
    doc.facts[1].receipts = [{ file: 'src/rules.ts', line: 7, symbol: 'ghostFunction' }];
    fs.writeFileSync(b.factsPath, JSON.stringify(doc, null, 2));
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'tampered receipts certified');
    assert(failing(certOf(b.dir), 'receipts'), 'receipts check did not fail');
    const c = await certifiable();
    const doc2 = JSON.parse(JSON.stringify(c.factsDoc));
    doc2.facts[0].statement = 'Everything is permitted.';
    fs.writeFileSync(c.factsPath, JSON.stringify(doc2, null, 2));
    assert(GATE.cmdGate(c.dir, quiet) === 1, 'tampered statement certified');
    assert(failing(certOf(c.dir), 'witness'), 'witness check did not fail');
  });
  await checkAsync('the certificate schema refuses dishonest shapes', async () => {
    const b = await certifiable();
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'setup gate failed');
    const cert = certOf(b.dir);
    const lie = JSON.parse(JSON.stringify(cert));
    lie.checks[0].pass = false;                       // row fails, topline still true
    assert(errorsOf(S.validateCertificate, lie).some(e => e.includes('contradicts')), 'topline/row contradiction accepted');
    const dropped = JSON.parse(JSON.stringify(cert));
    dropped.checks.pop();                             // quietly one check short
    assert(errorsOf(S.validateCertificate, dropped).some(e => e.includes('expected all')), 'a dropped check read as clean');
  });
  await checkAsync('FK grade behaves: simple prose scores below dense jargon', () => {
    const simple = GATE.fkGrade('The cat sat on the mat. It was warm. She liked it.');
    const dense = GATE.fkGrade('Organizational interoperability necessitates comprehensive infrastructural rationalization across heterogeneous implementation methodologies.');
    assert(simple < 4, `simple prose graded ${simple.toFixed(1)}`);
    assert(dense > 15, `dense jargon graded ${dense.toFixed(1)}`);
    assert(GATE.syllables('rationalization') >= 5, 'syllable counter broke');
  });
}

// ---- map: dashboard + canvas ----------------------------------------------

async function mapChecks() {
  console.log('map:');
  const M = require('../lib/map');
  const b = await buildWholeOgham();
  const R = require('../lib/render');
  assert(cmdIngest(b.dir, quiet) === 0 && R.cmdPrd(b.dir, quiet) === 0, 'map fixture setup failed');
  const read = (rel) => fs.readFileSync(path.join(b.dir, '.ogma/out', rel), 'utf8');

  await checkAsync('map writes all three artifacts and map.md carries the inventory', () => {
    assert(M.cmdMap(b.dir, quiet) === 0, 'map failed');
    for (const f of ['map.md', 'map.html', 'map.canvas']) {
      assert(fs.existsSync(path.join(b.dir, '.ogma/out', f)), `${f} missing`);
    }
    const md = read('map.md');
    assert(md.includes('Payments') && md.includes('2 facts') && md.includes('1 open questions'), 'map.md inventory wrong: ' + md.split('\n')[2]);
    assert(md.includes('## Modules') && md.includes('## Surfaces'), 'map.md sections missing');
  });
  await checkAsync('map.html is self-contained: no external requests of any kind', () => {
    const html = read('map.html');
    assert(!/\b(src|href)\s*=\s*"http/i.test(html), 'external src/href found');
    assert(!html.includes('@import') && !html.includes('fetch(') && !html.includes('XMLHttpRequest'), 'external loading found');
    assert(html.includes('<style>') && html.includes('<script>'), 'styles/scripts not inlined');
  });
  await checkAsync('both themes exist and core content is never opacity-animated', () => {
    const html = read('map.html');
    assert(html.includes('[data-theme="dark"]') && html.includes('prefers-color-scheme'), 'theme wiring missing');
    assert(!/opacity\s*:\s*0/.test(html), 'core content starts invisible — a stalled compositor leaves it blank');
  });
  await checkAsync('audience payloads are pre-filtered by the one rendersTo rule', () => {
    const html = read('map.html');
    const dataStart = html.indexOf('var DATA = ') + 'var DATA = '.length;
    const data = JSON.parse(html.slice(dataStart, html.indexOf(';\nvar audience')));
    const feat = data.modules[0].features[0];
    assert(feat.facts.tech.some(f => f.id === 'FACT-payments-002'), 'engineer view lost the doubt');
    assert(!feat.facts.prd.some(f => f.id === 'FACT-payments-002'), 'business payload carries a non-LIVE fact');
    assert(!feat.facts.guides.some(f => f.id === 'FACT-payments-002'), 'guide payload carries a non-LIVE fact');
    assert(feat.facts.prd.some(f => f.id === 'FACT-payments-001'), 'business payload lost the LIVE fact');
    assert(data.certificate === null || typeof data.certificate.pass === 'boolean', 'certificate embed malformed');
  });
  await checkAsync('map.canvas parses, links every module to its surfaces, and colors by classification', () => {
    const canvas = JSON.parse(read('map.canvas'));
    assert(Array.isArray(canvas.nodes) && Array.isArray(canvas.edges), 'canvas shape wrong');
    assert(canvas.nodes.some(n => n.id === 'module-payments'), 'module node missing');
    assert(canvas.nodes.some(n => n.id === 'surface-app'), 'surface node missing');
    assert(canvas.edges.some(e => e.fromNode === 'module-payments' && e.toNode === 'surface-app'), 'module->surface edge missing');
  });
  await checkAsync('map refuses an Ogham that never passed ingest', async () => {
    const c = await buildWholeOgham();   // no ingest -> no manifest
    const msgs = [];
    assert(M.cmdMap(c.dir, m => msgs.push(m)) === 1, 'map rendered unchecked Ogham');
    assert(msgs.join(' ').includes('ogma ingest'), 'map did not point at ingest');
  });
}

// ---- Batch 7: watch — receipt invalidation --------------------------------

async function watchChecks() {
  console.log('watch:');
  const WATCH = require('../lib/watch');

  // A whole, ingested Ogham in a real repo; then commits land on top.
  async function ingested() {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'watch fixture: ingest failed');
    return b;
  }
  const commitChange = (dir, rel, body) => {
    fs.writeFileSync(path.join(dir, rel), body);
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'change']);
    return gitIn(dir, ['rev-parse', 'HEAD']).trim();
  };
  const factsOf = (b) => JSON.parse(fs.readFileSync(b.factsPath, 'utf8')).facts;
  const manifestOf = (b) => JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/ogham/manifest.json'), 'utf8'));

  check('hunk parsing: old-side intervals exact, insertions carry count 0, every hunk carries its line delta', () => {
    const t = 'diff --git a/x b/x\n@@ -4,3 +4,2 @@ ctx\n-a\n@@ -9 +8 @@\n-b\n@@ -12,0 +12,5 @@\n+c\n';
    // delta = new-side count - old-side count. Without it a hunk ABOVE a cited
    // range cannot be told from one that leaves the numbering alone.
    assert(JSON.stringify(WATCH.parseHunkIntervals(t)) ===
      JSON.stringify([{ start: 4, count: 3, delta: -1 }, { start: 9, count: 1, delta: 0 }, { start: 12, count: 0, delta: 5 }]),
      'intervals: ' + JSON.stringify(WATCH.parseHunkIntervals(t)));
  });
  check('touch rule: overlap on both boundaries, insertion boundary conservative', () => {
    const touch = (ivs, lo, hi) => WATCH.hunksTouch(ivs, lo, hi);
    assert(touch([{ start: 10, count: 1 }], 10, 12), 'exact start missed');
    assert(touch([{ start: 8, count: 3 }], 10, 12), 'leading overlap missed');
    assert(touch([{ start: 12, count: 5 }], 10, 12), 'trailing overlap missed');
    assert(!touch([{ start: 13, count: 2 }], 10, 12), 'past-the-end counted');
    assert(!touch([{ start: 1, count: 8 }], 10, 12), 'before-the-start counted');
    assert(touch([{ start: 9, count: 0 }], 10, 12), 'insertion at lo-1 (lands at lo) missed');
    assert(touch([{ start: 12, count: 0 }], 10, 12), 'insertion at hi missed');
    assert(!touch([{ start: 13, count: 0 }], 10, 12), 'insertion after hi counted');
    // SHIFT: a hunk entirely above the range never overlaps it, but any net
    // line-count change moves every cited line below it. Missing this left the
    // gate certifying PASS over a receipt pointing at unrelated code.
    assert(touch([{ start: 1, count: 0, delta: 100 }], 39, 51), 'insertion far above (shift) missed');
    assert(touch([{ start: 11, count: 10, delta: -10 }], 39, 51), 'deletion above (shift) missed');
    assert(!touch([{ start: 11, count: 10, delta: 0 }], 39, 51), 'equal-size edit above counted — numbering is intact');
    assert(!touch([{ start: 900, count: 2, delta: 3 }], 39, 51), 'edit BELOW the range counted — it shifts nothing above it');
  });
  await checkAsync('an edit inside a cited window marks exactly the citing facts stale', async () => {
    const b = await ingested();
    // handlers.ts is cited only by FACT-001's path hop (line 1, window 1..6);
    // FACT-002 cites rules.ts:7 only. Appending inside handlers.ts touches 001, not 002.
    commitChange(b.dir, 'src/handlers.ts',
      'export function payHandler(req) {\n  return checkLimits(req.amount);\n}\nconst helper = (x) => transform(x);\nconst extra = 1;\n');
    const msgs = [];
    assert(WATCH.cmdWatch(b.dir, m => msgs.push(m)) === 0, 'watch failed: ' + msgs.join(' | '));
    const facts = factsOf(b);
    assert(facts.find(f => f.id === 'FACT-payments-001').status === 'stale', 'touched fact not stale');
    assert(facts.find(f => f.id === 'FACT-payments-002').status !== 'stale', 'untouched fact went stale');
    assert(msgs.some(m => m.includes('FACT-payments-001')), 'stale fact not named in the report');
  });
  await checkAsync('an edit touching no cited code leaves every fact fresh and still advances the manifest', async () => {
    const b = await ingested();
    const head2 = commitChange(b.dir, 'src/Api.cs',
      'public class PaymentsController {\n  public void Pay() { Validate(); }\n  private void Validate() {}\n}\n// note\n');
    const msgs = [];
    assert(WATCH.cmdWatch(b.dir, m => msgs.push(m)) === 0, 'watch failed');
    assert(factsOf(b).every(f => f.status !== 'stale'), 'a fact went stale with no cited code touched');
    assert(S.sameCommit(manifestOf(b).cutoff_commit, head2), 'manifest did not advance');
    assert(msgs.some(m => m.includes('stays fresh') || m.includes('stay fresh')), 'no all-fresh line');
  });
  await checkAsync('watch never renumbers: only status changes, every other byte of every fact rides through', async () => {
    const b = await ingested();
    const before = factsOf(b);
    commitChange(b.dir, 'src/rules.ts', GRAPH_FILES['src/rules.ts'] + 'export function extraRule(x) { return x; }\n');
    assert(WATCH.cmdWatch(b.dir, quiet) === 0, 'watch failed');
    const after = factsOf(b);
    assert(before.length === after.length, 'fact count changed');
    for (let i = 0; i < before.length; i++) {
      const a = { ...after[i] }; const w = { ...before[i] };
      delete a.status; delete w.status;
      assert(JSON.stringify(a) === JSON.stringify(w), `${before[i].id}: a non-status field changed`);
      assert(after[i].id === before[i].id, 'id changed');
    }
  });
  await checkAsync('current Ogham: nothing moved, nothing written, exit 0', async () => {
    const b = await ingested();
    const beforeManifest = fs.readFileSync(path.join(b.dir, '.ogma/ogham/manifest.json'), 'utf8');
    const msgs = [];
    assert(WATCH.cmdWatch(b.dir, m => msgs.push(m)) === 0, 'watch failed on a current Ogham');
    assert(msgs.some(m => m.includes('nothing to do')), 'no current-line');
    assert(fs.readFileSync(path.join(b.dir, '.ogma/ogham/manifest.json'), 'utf8') === beforeManifest, 'manifest rewritten for nothing');
  });
  await checkAsync('watch without a manifest refuses and points at ingest', async () => {
    const b = await buildWholeOgham(); // no ingest
    const msgs = [];
    assert(WATCH.cmdWatch(b.dir, m => msgs.push(m)) === 1, 'ran without a manifest');
    assert(msgs.join(' ').includes('ogma ingest'), 'did not point at ingest');
  });
  await checkAsync('a fact whose verified commit cannot be diffed goes stale — never skip-and-pass', async () => {
    const b = await ingested();
    const doc = JSON.parse(fs.readFileSync(b.factsPath, 'utf8'));
    const gone = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    doc.facts[0].verified_at_commit = gone;
    doc.facts[0].witness.checked_at_commit = gone; // keep ruling freshness legal
    fs.writeFileSync(b.factsPath, JSON.stringify(doc, null, 2));
    commitChange(b.dir, 'src/Api.cs', GRAPH_FILES['src/Api.cs'] + '// move\n');
    const msgs = [];
    assert(WATCH.cmdWatch(b.dir, m => msgs.push(m)) === 0, 'watch failed');
    assert(factsOf(b)[0].status === 'stale', 'undiffable fact not marked stale');
    assert(msgs.some(m => m.includes('cannot be diffed')), 'reason not named');
  });
  await checkAsync('a receipt into a non-ASCII path is still invalidated — quoted diff names must not hide an edit', async () => {
    // Hand-built minimal Ogham (no ingest needed: watch checks structure, not
    // witness binding). The cited file has a non-ASCII name — the path rule
    // allows those on purpose, so watch must see them in diffs too.
    const dir = makeFixtureRepo({ 'src/héllo.ts': 'export function greet() {\n  return "hi";\n}\n' });
    cmdInit(dir, quiet);
    const c1 = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    fs.mkdirSync(path.join(dir, '.ogma/ogham/facts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ogma/ogham/manifest.json'), JSON.stringify({
      ogham_version: 1, project: 'uni', repo_root: '.', cutoff_commit: c1,
      generated_at: '2026-08-07T00:00:00Z',
      counts: { surfaces: 0, modules: 1, features: 1, facts: 1, ledger_open: 0 }
    }, null, 2));
    const factsPath = path.join(dir, '.ogma/ogham/facts/greetings.json');
    fs.writeFileSync(factsPath, JSON.stringify({
      module: 'greetings',
      features: [{ id: 'FEAT-greetings-greet', name: 'Greet', classification: 'LIVE',
        does: 'x', happens: 'y', sees: 'z', fact_ids: ['FACT-greetings-001'] }],
      facts: [{ id: 'FACT-greetings-001', feature_id: 'FEAT-greetings-greet', kind: 'state',
        statement: 'The greeting is fixed.', classification: 'LIVE',
        receipts: [{ file: 'src/héllo.ts', line: 2, symbol: 'greet' }],
        witness: { verdict: 'CONFIRMED', checked_at_commit: c1, checker: 'bench', input_hash: 'a'.repeat(64) },
        verified_at_commit: c1, status: 'fresh', ledger_refs: [] }]
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'src/héllo.ts'), 'export function greet() {\n  return "hello there";\n}\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'edit unicode file']);
    const msgs = [];
    assert(require('../lib/watch').cmdWatch(dir, m => msgs.push(m)) === 0, 'watch failed: ' + msgs.join(' | '));
    const fact = JSON.parse(fs.readFileSync(factsPath, 'utf8')).facts[0];
    assert(fact.status === 'stale', 'an edit to a non-ASCII-named cited file was not seen — quoted path hid it');
  });
  await checkAsync('already-stale facts are not re-marked, and the report says they still await re-read', async () => {
    const b = await ingested();
    const doc = JSON.parse(fs.readFileSync(b.factsPath, 'utf8'));
    doc.facts[0].status = 'stale';
    fs.writeFileSync(b.factsPath, JSON.stringify(doc, null, 2));
    commitChange(b.dir, 'src/Api.cs', GRAPH_FILES['src/Api.cs'] + '// again\n');
    const msgs = [];
    assert(WATCH.cmdWatch(b.dir, m => msgs.push(m)) === 0, 'watch failed');
    assert(msgs.some(m => m.includes('already stale')), 'awaiting-re-read line missing');
    assert(!msgs.some(m => m.startsWith('  stale  FACT-payments-001')), 'already-stale fact re-reported as newly stale');
  });
}

// ---- Batch 0 debt: instants, error caps, unicode, argv --------------------

async function debtChecks() {
  console.log('batch-0 debt:');

  check('timestamps are real calendar instants — shape alone is not a date', () => {
    for (const bad of ['9999-99-99T00:00:00Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
      '2023-02-29T00:00:00Z', '2026-08-07T25:00:00Z', '2026-08-07T12:60:00Z', '2026-00-10T00:00:00Z']) {
      assert(!S.isIsoInstant(bad), `${bad} accepted`);
    }
    for (const good of ['2026-08-07T12:00:00Z', '2024-02-29T00:00:00Z', '2026-12-31T23:59:59.123Z']) {
      assert(S.isIsoInstant(good), `${good} rejected`);
    }
    const m = { ogham_version: 1, project: 'p', repo_root: '.', cutoff_commit: 'a1b2c3d',
      generated_at: '9999-99-99T00:00:00Z', counts: { surfaces: 0, modules: 0, features: 0, facts: 0, ledger_open: 0 } };
    assert(errorsOf(S.validateManifest, m).length > 0, 'manifest took an impossible date');
  });

  check('every array-iterating validator caps error amplification and reports the suppression', () => {
    const cases = [
      [S.validateTerrain, { surfaces: Array(5000).fill({ bad: true }), modules: Array(5000).fill({ bad: true }), languages: {} }],
      [S.validateLedgerFile, { questions: Array(9000).fill({ bad: true }) }],
      [S.validateGraphIndex, { graph_version: 1, commit: 'a1b2c3d', files: Array(9000).fill({ bad: true }), skipped: {} }],
      [S.validateRaised, { raised: Array(9000).fill(42) }],
      [S.validatePushState, { push_state_version: 1, kind: 'markdown-only', commit: 'a1b2c3d',
        delivered_at: '2026-08-07T00:00:00Z', files: Array(9000).fill({ bad: true }) }],
      [S.validateCertificate, { certificate_version: 1, project: 'p', commit: 'a1b2c3d',
        generated_at: '2026-08-07T00:00:00Z', pass: true, checks: Array(9000).fill({ bad: true }) }],
      [S.validateConfig, { version: 1, project: 'p', audiences: { prd: true, tech: true, guides: true },
        destination: { kind: null, asked: false }, language: 'en',
        leaklint_extra: Array(9000).fill(42), readability_max_grade: 10 }]
    ];
    for (const [validator, hostile] of cases) {
      const e = errorsOf(validator, hostile);
      assert(e.length <= S.MAX_ERRORS + 1, `${validator.name}: ${e.length} errors — amplification uncapped`);
      assert(e.some(msg => msg.includes('suppressed')), `${validator.name}: suppression is silent`);
    }
  });

  check('a symbol in a different normalization form than the code still verifies', () => {
    const nfdCafe = 'caféRate';  // e + combining acute (NFD)
    const nfcCafe = 'caféRate';   // precomposed e-acute (NFC)
    assert(nfdCafe !== nfcCafe && nfdCafe.normalize('NFC') === nfcCafe, 'fixture strings are not a real NFD/NFC pair');
    const content = `function ${nfdCafe}() {
  return 1;
}
`;
    const read = (p) => (p === 'src/x.ts' ? content : null);
    const v = V.verifyReceipt({ file: 'src/x.ts', line: 1, symbol: nfcCafe }, read);
    assert(v.ok, 'NFC symbol did not match NFD code: ' + (v.detail || v.reason));
  });

  await checkAsync('a receipt path in a different normalization form than the repo still verifies via git', async () => {
    const nfdName = 'src/résume.ts';  // NFD on disk and in git
    const nfcName = 'src/résume.ts';   // NFC in the receipt
    assert(nfdName !== nfcName && nfdName.normalize('NFC') === nfcName, 'fixture paths are not a real NFD/NFC pair');
    const dir = makeFixtureRepo({ [nfdName]: `export function tally() {
  return 0;
}
` });
    const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    const tracked = gitIn(dir, ['-c', 'core.quotepath=false', 'ls-files']).trim();
    assert(tracked.length > 0, 'fixture repo has no tracked file');
    const reader = V.makeGitReader(dir, head);
    const v = V.verifyReceipt({ file: nfcName, line: 1, symbol: 'tally' }, reader);
    assert(v.ok, `NFC receipt path did not reach the blob git tracks as "${tracked}": ` + (v.detail || v.reason));
  });

  check('a const definition is citable even when the graph knows its name only as an argument', () => {
    // The indexer never records variable declarations, so a const referenced
    // later as a bare argument is known to the graph ONLY through that
    // reference site. The refinement must not reject the definition's own
    // receipt against that provably incomplete list. Found by the
    // OSS-fixture benchmark, pinned here.
    // The reference site sits far outside the definition's drift window —
    // exactly the shape that made the false rejection fire.
    const content = 'const lim = 5;\n' + Array(15).fill('// filler').join('\n') +
      '\nfunction f(x) {\n  return check(x, lim);\n}\n';
    const read = (p) => (p === 'src/x.ts' ? content : null);
    const index = { graph_version: 1, commit: 'abc1234', files: [
      { path: 'src/x.ts', language: 'js',
        symbols: [{ name: 'f', kind: 'function', line: 17 }],
        calls: [{ name: 'check', line: 18, from: 'f' }, { name: 'lim', line: 18, from: 'f' }] }
    ], skipped: { unsupported: 0, too_large: 0, parse_failed: 0, unreadable: 0 } };
    const v = V.verifyReceipt({ file: 'src/x.ts', line: 1, symbol: 'lim' }, read, index);
    assert(v.ok, 'const definition receipt rejected by call-site-only graph knowledge: ' + (v.detail || v.reason));
    assert(v.via === 'text', 'call-site-only knowledge must fall back to the text verdict, got: ' + v.via);
    // And the tightening still fires where it is valid: f is DEFINED in the
    // graph, so a window that only contains a comment mention must reject.
    const content2 = 'const lim = 5;\n// f is called here\nconst pad = 1;\nfunction unrelated() {}\n' +
      Array(10).fill('// filler').join('\n') + '\nfunction f(x) { return x; }\n';
    const read2 = (p) => (p === 'src/y.ts' ? content2 : null);
    const index2 = { graph_version: 1, commit: 'abc1234', files: [
      { path: 'src/y.ts', language: 'js',
        symbols: [{ name: 'f', kind: 'function', line: 15 }], calls: [] }
    ], skipped: { unsupported: 0, too_large: 0, parse_failed: 0, unreadable: 0 } };
    const v2 = V.verifyReceipt({ file: 'src/y.ts', line: 2, symbol: 'f' }, read2, index2);
    assert(!v2.ok && v2.reason === 'symbol-not-found', 'a comment mention of a DEFINED symbol still verified');
  });

  check('control bytes in argv never reach the terminal raw', () => {
    const BIN2 = path.join(__dirname, '..', 'bin', 'ogma.js');
    // Built from char codes so no raw control byte sits in this source file.
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const hostile = 'x' + ESC + '[2K' + CR + 'PASS';
    const r1 = spawnSync(process.execPath, [BIN2, hostile], { encoding: 'utf8' });
    assert(r1.status === 1, `unknown-command exit ${r1.status}`);
    assert(!r1.stderr.includes(ESC), 'unknown-command echo leaks a raw ESC byte');
    assert(r1.stderr.includes('\\x1b'), 'unknown-command echo not visibly escaped');
    const r2 = spawnSync(process.execPath, [BIN2, 'init', hostile], { encoding: 'utf8' });
    assert(r2.status === 1, `extra-args exit ${r2.status}`);
    assert(!r2.stderr.includes(ESC), 'extra-args echo leaks a raw ESC byte');
  });
}

// ---- Batch 7: push — consent, certification, delivery ---------------------

async function pushChecks() {
  console.log('push:');
  const P = require('../lib/push');
  const GATE = require('../lib/gate');
  const R = require('../lib/render');
  const M = require('../lib/map');

  async function certified() {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'push fixture: ingest failed');
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'push fixture: render failed');
    assert(M.cmdMap(b.dir, quiet) === 0, 'push fixture: map failed');
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'push fixture: gate failed');
    return b;
  }
  const configOf = (b) => JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/config.json'), 'utf8'));
  const stateOf = (b) => JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/push-state.json'), 'utf8'));
  const statePath = (b) => path.join(b.dir, '.ogma/push-state.json');

  check('md->storage: closed dialect converts, everything else stays escaped text', () => {
    const md = '# Title <x>\n\nA **bold** and `code` line & more.\n\n_An aside._\n\n- one\n- two\n  - nested\n- three\n\n1. first\n2. second\n';
    const s = P.mdToStorage(md);
    assert(s.includes('<h1>Title &lt;x&gt;</h1>'), 'heading not converted/escaped: ' + s.split('\n')[0]);
    assert(s.includes('<strong>bold</strong>') && s.includes('<code>code</code>') && s.includes('&amp; more'), 'inline marks wrong');
    assert(s.includes('<p><em>An aside.</em></p>'), 'aside not em');
    assert(s.includes('<ul><li>one') && s.includes('<ol><li>first'), 'lists not opened');
    const opens = (s.match(/<li>/g) || []).length; const closes = (s.match(/<\/li>/g) || []).length;
    assert(opens === closes, `li open/close mismatch: ${opens}/${closes}`);
    assert(s.includes('<ul><li>nested</li></ul>'), 'nesting broken: ' + s);
  });
  check('md->storage: fact-ID annotations never reach a delivered body', () => {
    const s = P.mdToStorage('## F <!-- feature:FEAT-x -->\n\n- claim <!-- fact:FACT-y -->\n');
    assert(!s.includes('fact:') && !s.includes('feature:') && !s.includes('&lt;!--'), 'annotation leaked: ' + s);
  });
  check('push-state validator: clean passes, planted violations rejected, hostile never throws', () => {
    const clean = {
      push_state_version: 1, kind: 'markdown-only', commit: 'a1b2c3d',
      delivered_at: '2026-08-07T00:00:00Z',
      files: [{ path: 'prd.md', sha256: 'a'.repeat(64) }]
    };
    assert(errorsOf(S.validatePushState, clean).length === 0, 'clean rejected: ' + errorsOf(S.validatePushState, clean)[0]);
    assert(errorsOf(S.validatePushState, { ...clean, kind: null }).length > 0, 'null kind passed');
    assert(errorsOf(S.validatePushState, { ...clean, kind: 'ftp' }).length > 0, 'unknown kind passed');
    assert(errorsOf(S.validatePushState, { ...clean, files: [{ path: '../x.md', sha256: 'a'.repeat(64) }] }).length > 0, 'traversal path passed');
    assert(errorsOf(S.validatePushState, { ...clean, files: [clean.files[0], clean.files[0]] }).length > 0, 'duplicate path passed');
    assert(errorsOf(S.validatePushState, { ...clean, files: [{ path: 'prd.md', sha256: 'zz' }] }).length > 0, 'bad digest passed');
    assert(errorsOf(S.validatePushState, { ...clean, files: [{ path: 'prd.md', sha256: 'a'.repeat(64), page_id: 'abc' }] }).length > 0, 'non-numeric page id passed');
    for (const h of HOSTILE) noThrow(S.validatePushState, h, 'validatePushState');
  });
  check('config validator: confluence settings block validated whenever present', () => {
    const c = S.defaultConfig('p');
    c.destination = { kind: 'confluence', asked: true, confluence: { space_key: 'DOCS', parent_page_id: '123' } };
    assert(errorsOf(S.validateConfig, c).length === 0, 'clean confluence block rejected');
    c.destination.confluence = { space_key: 'has space', parent_page_id: '123' };
    assert(errorsOf(S.validateConfig, c).length > 0, 'bad space key passed');
    c.destination.confluence = { space_key: 'DOCS', parent_page_id: 'x' };
    assert(errorsOf(S.validateConfig, c).length > 0, 'non-numeric parent passed');
  });
  await checkAsync('no recorded consent: push sniffs, asks, delivers nothing, exits 1', async () => {
    const b = await certified();
    const msgs = [];
    assert(await P.cmdPush(b.dir, [], m => msgs.push(m), {}) === 1, 'pushed without consent');
    assert(msgs.some(m => m.includes('consent is never assumed')), 'no consent line');
    assert(msgs.some(m => m.includes('markdown-only')) && !msgs.some(m => m.includes('confluence,')), 'sniff wrong for bare env');
    assert(!fs.existsSync(statePath(b)), 'push-state written without consent');
    assert(configOf(b).destination.asked === false, 'consent recorded by a refusal');
  });
  await checkAsync('--to records the ask-once choice and markdown-only delivers a verified, replayable state', async () => {
    const b = await certified();
    const msgs = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => msgs.push(m), {}) === 0, 'push failed: ' + msgs.join(' | '));
    const cfg = configOf(b);
    assert(cfg.destination.kind === 'markdown-only' && cfg.destination.asked === true, 'choice not recorded');
    const st = stateOf(b);
    assert(errorsOf(S.validatePushState, st).length === 0, 'push-state invalid');
    const prd = fs.readFileSync(path.join(b.dir, '.ogma/out/prd.md'), 'utf8');
    const crypto = require('crypto');
    assert(st.files.find(f => f.path === 'prd.md').sha256 ===
      crypto.createHash('sha256').update(prd, 'utf8').digest('hex'), 'recorded hash is not the file hash');
    // replay: second push, no --to needed, everything unchanged
    const msgs2 = [];
    assert(await P.cmdPush(b.dir, [], m => msgs2.push(m), {}) === 0, 'replay failed');
    assert(msgs2.some(m => m.includes('unchanged')), 'replay did not report unchanged');
  });
  await checkAsync('unknown and unbuilt destinations refuse honestly', async () => {
    const b = await certified();
    const m1 = [];
    assert(await P.cmdPush(b.dir, ['--to', 'ftp'], m => m1.push(m), {}) === 1, 'unknown kind accepted');
    assert(m1.join(' ').includes('unknown destination'), 'no unknown-kind line');
    const m2 = [];
    assert(await P.cmdPush(b.dir, ['--to', 'notion'], m => m2.push(m), {}) === 1, 'unbuilt adapter accepted');
    assert(m2.join(' ').includes('not built'), 'no not-built line');
    assert(configOf(b).destination.asked === false, 'a refused choice was recorded');
  });
  await checkAsync('no certificate, a failing certificate, and a stale certificate each refuse with the fix named', async () => {
    const b = await certified();
    const certPath = path.join(b.dir, '.ogma/certificate.json');
    const good = fs.readFileSync(certPath, 'utf8');
    // no certificate
    fs.rmSync(certPath);
    const m1 = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => m1.push(m), {}) === 1, 'shipped uncertified');
    assert(m1.join(' ').includes('ogma gate'), 'missing-cert refusal does not name the gate');
    // failing certificate (structurally valid: one row false, topline false)
    const cert = JSON.parse(good);
    cert.pass = false; cert.checks[0].pass = false;
    fs.writeFileSync(certPath, JSON.stringify(cert, null, 2));
    const m2 = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => m2.push(m), {}) === 1, 'shipped a failing fleet');
    assert(m2.join(' ').includes('FAILING'), 'failing-cert refusal unlabeled');
    // stale certificate: restore, then land a commit
    fs.writeFileSync(certPath, good);
    fs.writeFileSync(path.join(b.dir, 'src/Api.cs'), GRAPH_FILES['src/Api.cs'] + '// drift\n');
    gitIn(b.dir, ['add', '-A']);
    gitIn(b.dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'drift']);
    const m3 = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => m3.push(m), {}) === 1, 'shipped a stale certificate');
    assert(m3.join(' ').includes('ogma watch'), 'stale-cert refusal does not name watch');
    assert(!fs.existsSync(statePath(b)), 'a refused push left state behind');
  });
  await checkAsync('confluence without credentials refuses; nothing leaves the machine', async () => {
    const b = await certified();
    const msgs = [];
    assert(await P.cmdPush(b.dir, ['--to', 'confluence', '--space', 'DOCS', '--parent', '1'], m => msgs.push(m), {}) === 1, 'delivered without creds');
    assert(msgs.join(' ').includes('CONFLUENCE_BASE_URL'), 'env requirement not named');
    assert(!fs.existsSync(statePath(b)), 'state written with nothing delivered');
  });
  await checkAsync('confluence e2e against a local mock: create verified by full read-back, replay skips, edit updates in place', async () => {
    const http = require('http');
    const pages = new Map(); let nextId = 100;
    const server = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/wiki/api/v2/spaces') return send(200, { results: [{ id: '9', key: u.searchParams.get('keys') }] });
        const pm = /^\/wiki\/api\/v2\/pages(?:\/(\d+))?$/.exec(u.pathname);
        if (!pm) return send(404, {});
        if (req.method === 'POST') {
          const p = JSON.parse(body); const id = String(nextId++);
          pages.set(id, { id, title: p.title, status: 'current', version: { number: 1 }, body: p.body.value });
          return send(200, { id, title: p.title });
        }
        const page = pages.get(pm[1]);
        if (!page) return send(404, {});
        if (req.method === 'GET') {
          const out = { id: page.id, title: page.title, status: page.status, version: page.version };
          if (u.searchParams.get('body-format') === 'storage') out.body = { storage: { value: page.body } };
          return send(200, out);
        }
        if (req.method === 'PUT') {
          const p = JSON.parse(body);
          page.title = p.title; page.version = { number: p.version.number }; page.body = p.body.value;
          return send(200, { id: page.id });
        }
        return send(405, {});
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const env = {
      CONFLUENCE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CONFLUENCE_EMAIL: 'bench@ogma.test', CONFLUENCE_API_TOKEN: 'token'
    };
    try {
      const b = await certified();
      const msgs = [];
      assert(await P.cmdPush(b.dir, ['--to', 'confluence', '--space', 'DOCS', '--parent', '1'], m => msgs.push(m), env) === 0,
        'confluence push failed: ' + msgs.join(' | '));
      const st = stateOf(b);
      assert(st.kind === 'confluence' && st.files.every(f => /^\d+$/.test(f.page_id)), 'page ids not recorded');
      const prdPage = [...pages.values()].find(p => p.title.endsWith('· prd'));
      assert(prdPage && prdPage.body.includes('<h1>') && !prdPage.body.includes('fact:'), 'delivered body wrong or annotated');
      assert(!JSON.stringify(st).includes('token'), 'secret reached push-state');
      // replay: nothing changed -> every page skipped, versions untouched
      const versions1 = [...pages.values()].map(p => p.version.number);
      const msgs2 = [];
      assert(await P.cmdPush(b.dir, [], m => msgs2.push(m), env) === 0, 'replay failed');
      assert([...pages.values()].map(p => p.version.number).join() === versions1.join(), 'replay bumped versions with identical content');
      assert(msgs2.every(m => !m.includes('created')), 'replay re-created pages');
      // edit one document -> exactly that page updates, version 2, same id.
      // The edit goes THROUGH the Ogham (new ledger question -> re-render ->
      // re-gate): hand-editing out/questions.md now fails the freshness
      // check and the certificate byte-binding, by design.
      const ledgerPath = path.join(b.dir, '.ogma/ogham/ledger.json');
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      ledger.questions.push({
        id: 'Q-push-edit', question: 'Does the update path deliver in place',
        status: 'open', receipts: ledger.questions[0].receipts
      });
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      assert(require('../lib/render').cmdQuestions(b.dir, quiet) === 0, 'questions re-render failed');
      assert(require('../lib/gate').cmdGate(b.dir, quiet) === 0, 're-gate after ledger edit failed');
      const before = new Map(st.files.map(f => [f.path, f.page_id]));
      const msgs3 = [];
      assert(await P.cmdPush(b.dir, [], m => msgs3.push(m), env) === 0, 'update push failed: ' + msgs3.join(' | '));
      const st3 = stateOf(b);
      assert(st3.files.find(f => f.path === 'questions.md').page_id === before.get('questions.md'), 'update changed the page id');
      const qPage = pages.get(before.get('questions.md'));
      assert(qPage.version.number === 2 && qPage.body.includes('Does the update path deliver in place'), 'update not applied in place');
      assert([...st3.files].filter(f => f.path !== 'questions.md').every(f => pages.get(f.page_id).version.number === 1), 'unrelated pages re-written');
    } finally {
      server.close();
    }
  });
  await checkAsync('a lying destination is caught by fetch-back: 200 on write, wrong content on read — push fails, nothing records as verified', async () => {
    const http = require('http');
    // Accepts every write, then serves back an empty page: the API said yes,
    // the content is not there. Exactly the failure an API-200-is-proof
    // adapter would certify.
    const server = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/wiki/api/v2/spaces') return send(200, { results: [{ id: '9' }] });
        if (req.method === 'POST') return send(200, { id: '500', title: JSON.parse(body).title });
        return send(200, { id: '500', title: 'wrong title', status: 'current', version: { number: 1 }, body: { storage: { value: '' } } });
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const env = {
      CONFLUENCE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CONFLUENCE_EMAIL: 'bench@ogma.test', CONFLUENCE_API_TOKEN: 'token'
    };
    try {
      const b = await certified();
      const msgs = [];
      assert(await P.cmdPush(b.dir, ['--to', 'confluence', '--space', 'DOCS', '--parent', '1'], m => msgs.push(m), env) === 1,
        'a write that read back wrong was reported as delivered');
      assert(msgs.join(' ').includes('did not verify') || msgs.join(' ').includes('verify'), 'failure not named as a verification failure');
      // The created page EXISTS on the remote even though its content lied on
      // read-back. It is recorded — marked verified:false so replay never
      // skips it and the next push updates instead of duplicating — but it
      // must never be recorded AS verified.
      const st = JSON.parse(fs.readFileSync(statePath(b), 'utf8'));
      assert(st.files.length === 1 && st.files[0].verified === false && st.files[0].page_id === '500',
        'the unverified created page was not recorded as unverified');
      assert(msgs.join(' ').includes('UNVERIFIED'), 'the orphaned page was not reported');
    } finally {
      server.close();
    }
  });
  await checkAsync('a mid-fleet failure records the pages already verified — a retry cannot create duplicates', async () => {
    const http = require('http');
    // Honest for the first created page, then refuses every later create.
    const pages = new Map(); let nextId = 700; let creates = 0; let failAfter = 1;
    const server = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/wiki/api/v2/spaces') return send(200, { results: [{ id: '9' }] });
        if (req.method === 'POST') {
          if (++creates > failAfter) return send(500, {});
          const p = JSON.parse(body); const id = String(nextId++);
          pages.set(id, { id, title: p.title, status: 'current', version: { number: 1 }, body: p.body.value });
          return send(200, { id, title: p.title });
        }
        const pm = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
        const page = pm && pages.get(pm[1]);
        if (!page) return send(404, {});
        const out = { id: page.id, title: page.title, status: page.status, version: page.version };
        if (u.searchParams.get('body-format') === 'storage') out.body = { storage: { value: page.body } };
        return send(200, out);
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const env = {
      CONFLUENCE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CONFLUENCE_EMAIL: 'bench@ogma.test', CONFLUENCE_API_TOKEN: 'token'
    };
    try {
      const b = await certified();
      const msgs = [];
      assert(await P.cmdPush(b.dir, ['--to', 'confluence', '--space', 'DOCS', '--parent', '1'], m => msgs.push(m), env) === 1,
        'a mid-fleet failure exited 0');
      const st = stateOf(b);
      assert(st.files.length === 1 && /^\d+$/.test(st.files[0].page_id), 'the verified page mapping was not recorded: ' + JSON.stringify(st.files));
      const firstId = st.files[0].page_id;
      assert(msgs.join(' ').includes('page mapping is recorded'), 'partial-state line missing');
      // retry with the server healthy again: the recorded page must be REUSED
      failAfter = Infinity;
      const msgs2 = [];
      assert(await P.cmdPush(b.dir, [], m => msgs2.push(m), env) === 0, 'retry failed: ' + msgs2.join(' | '));
      const st2 = stateOf(b);
      assert(st2.files.find(f => f.page_id === firstId), 'retry abandoned the recorded page');
      assert([...pages.values()].filter(p => p.id === firstId).length === 1
        && ![...pages.values()].some(p => p.id !== firstId && p.title === pages.get(firstId).title),
        'retry created a duplicate of the already-delivered page');
    } finally {
      server.close();
    }
  });
}

// The graph checks await the WASM engine, so the bench tail (graph -> CLI ->
// housekeeping -> summary) runs inside one async main; a stray rejection is a
// bench failure, never a silent green.
(async () => {

await graphChecks();
await ingestChecks();
await renderChecks();
await gateChecks();
await mapChecks();
await watchChecks();
await debtChecks();
await pushChecks();
await batch9Checks();
await batch10Checks();
await batch11Checks();
await batch12Checks();

// ---- batch 9: the ship-panel findings, each pinned -------------------------

async function batch9Checks() {
  console.log('batch 9 (ship-panel findings):');
  const GATE = require('../lib/gate');
  const R = require('../lib/render');
  const P = require('../lib/push');
  const V9 = require('../lib/verify');
  const G9 = require('../lib/graph');

  // The full pipeline to a certified state, shared by several tests here.
  async function certified9(extraFiles) {
    const b = await buildWholeOgham(extraFiles);
    assert(cmdIngest(b.dir, quiet) === 0, 'b9 fixture: ingest failed');
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'b9 fixture: render failed');
    assert(require('../lib/map').cmdMap(b.dir, quiet) === 0, 'b9 fixture: map failed');
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'b9 fixture: gate failed');
    return b;
  }
  const certOf9 = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.ogma/certificate.json'), 'utf8'));
  const failing9 = (cert, name) => cert.checks.find(c => c.check === name && c.pass === false);

  await checkAsync('SHIP-01: after a commit touches cited code, ingest refuses, watch invalidates, gate refuses — the ordinary workflow cannot certify a lie', async () => {
    const b = await certified9();
    // Change the cited line (the probe scenario: raise the limit) and commit.
    const rules = path.join(b.dir, 'src/rules.ts');
    fs.writeFileSync(rules, fs.readFileSync(rules, 'utf8').replace('x < 500', 'x < 1000'));
    gitIn(b.dir, ['add', '-A']);
    gitIn(b.dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'raise limit']);
    // graph -> ingest (the exact sequence that used to certify PASS over a lie)
    assert(await G9.cmdGraph(b.dir, quiet) === 0, 'graph re-index failed');
    const msgs = [];
    assert(cmdIngest(b.dir, m => msgs.push(m)) === 1, 'ingest advanced the cutoff over moved cited code');
    assert(msgs.join(' ').includes('cited code moved'), 'the refusal does not name the moved code: ' + msgs.join(' | ').slice(0, 300));
    // The manifest did NOT advance, so watch still sees the gap and works.
    const m1 = JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/ogham/manifest.json'), 'utf8'));
    assert(!S.sameCommit(m1.cutoff_commit, gitIn(b.dir, ['rev-parse', 'HEAD']).trim()), 'cutoff advanced despite the refusal — watch is disarmed');
    const wmsgs = [];
    assert(require('../lib/watch').cmdWatch(b.dir, m => wmsgs.push(m)) === 0, 'watch failed');
    assert(wmsgs.some(m => m.includes('stale') && m.includes('FACT-payments-001')), 'watch did not invalidate the touched fact');
    // And the gate independently refuses the stale state.
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'gate certified a stale fact');
    const f = failing9(certOf9(b.dir), 'freshness');
    assert(f && f.detail.includes('stale'), 'freshness did not name the stale fact');
  });
  await checkAsync('SHIP-01: a hand-edited rendered document fails freshness — prose is bound to the Ogham', async () => {
    const b = await certified9();
    fs.appendFileSync(path.join(b.dir, '.ogma/out/prd.md'), '\nThe limit is a million dollars.\n');
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'an edited PRD certified');
    const f = failing9(certOf9(b.dir), 'freshness');
    assert(f && f.detail.includes('prd.md') && f.detail.includes('does not match'), 'freshness did not name the drifted document');
  });
  await checkAsync('SHIP-01: a missing or off-HEAD graph fails freshness at the gate', async () => {
    const b = await certified9();
    fs.rmSync(path.join(b.dir, '.ogma/ogham/graph/index.json'));
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'gate certified without a graph');
    const f = failing9(certOf9(b.dir), 'freshness');
    assert(f && f.detail.includes('graph'), 'freshness did not name the graph');
  });
  await checkAsync('SHIP-02: multi-line and backtick prose is refused at the schema — the leaklint bypass payload cannot enter the Ogham', async () => {
    // The maker-reproduced bypass payload from the ship panel, verbatim.
    const bypass = 'Pay your bill online.\n# this uses the http api endpoint and a database\nAll good.';
    assert(errorsOf(S.validateFact, fact({ statement: bypass })).some(e => e.includes('single-line')), 'a newline-bearing statement validated');
    assert(errorsOf(S.validateFact, fact({ statement: 'uses the `api` quietly' })).some(e => e.includes('single-line')), 'a backtick-bearing statement validated');
    assert(errorsOf(S.validateFeature, feature({ does: 'Click.\n# http api database' })).length > 0, 'a newline-bearing narration validated');
    assert(errorsOf(S.validateLedgerEntry, { id: 'Q-x', question: 'why `api`?', status: 'open', receipts: [cleanFact.receipts[0]] }).some(e => e.includes('single-line')), 'a backtick-bearing question validated');
  });
  await checkAsync('SHIP-03: init refuses a repo-supplied confluence targeting block, not just kind/asked', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, '.ogma'), { recursive: true });
    const cfg = S.defaultConfig('x');
    cfg.destination.confluence = { space_key: 'EVIL', parent_page_id: '666' };
    fs.writeFileSync(path.join(dir, '.ogma/config.json'), JSON.stringify(cfg, null, 2));
    const msgs = [];
    assert(cmdInit(dir, m => msgs.push(m)) === 1, 'init accepted a pre-seeded targeting block');
    assert(msgs.join(' ').includes('targeting block'), 'refusal does not name the targeting block');
  });
  await checkAsync('SHIP-03: push refuses when the repo itself ships .ogma/config.json', async () => {
    const b = await certified9();
    gitIn(b.dir, ['add', '-f', '.ogma/config.json']);
    gitIn(b.dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'ship a config']);
    const msgs = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => msgs.push(m), {}) === 1, 'push trusted a repo-tracked config');
    assert(msgs.join(' ').includes('tracked by this repository'), 'refusal does not name the tracked file');
    assert(!fs.existsSync(path.join(b.dir, '.ogma/push-state.json')), 'a refused push left state behind');
  });
  await checkAsync('SHIP-04: a repo-planted symlink under .ogma is refused by every write path (shared guarded write)', async () => {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'fixture ingest failed');
    const outside = tmpdir();
    const outDir = path.join(b.dir, '.ogma/out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.symlinkSync(outside, outDir, 'junction');
    const msgs = [];
    assert(R.cmdPrd(b.dir, m => msgs.push(m)) === 1, 'render wrote through a symlinked out/');
    assert(msgs.join(' ').includes('symlink'), 'refusal does not name the symlink');
    assert(fs.readdirSync(outside).length === 0, 'bytes escaped through the link');
    // The certifying write is guarded by the same implementation. (A junction
    // stands in for the link: file symlinks need elevation on win32, and
    // refuseSymlink treats both as links.)
    fs.rmSync(path.join(b.dir, '.ogma/certificate.json'), { force: true });
    fs.symlinkSync(outside, path.join(b.dir, '.ogma/certificate.json'), 'junction');
    const gmsgs = [];
    assert(GATE.cmdGate(b.dir, m => gmsgs.push(m)) === 1, 'gate wrote a certificate through a symlink');
    assert(gmsgs.join(' ').includes('symlink'), 'gate refusal does not name the symlink');
  });
  await checkAsync('SHIP-05: value-position references (exports, returns, assignments) are graph occurrences — genuine receipts verify', async () => {
    const filler = 'const pad = 0;\n'.repeat(20);
    const body = 'function pay() { return 1; }\n' + filler
      + 'module.exports = { pay };\n'          // line 22
      + 'function useIt() { return pay; }\n'   // line 23: return-position
      + 'const alias = pay;\n';                // line 24: assignment-position
    const files = { 'src/mod.js': body };
    const read = (p) => files[p] || null;
    const { index } = await G9.indexTree({
      entries: [{ path: 'src/mod.js', size: Buffer.byteLength(body) }],
      readText: read, commit: 'abc1234'
    });
    for (const line of [22, 23, 24]) {
      const v = V9.verifyReceipt({ file: 'src/mod.js', line, symbol: 'pay' }, read, index);
      assert(v.ok === true, `a genuine value-position reference at line ${line} was rejected: ${v.detail || ''}`);
    }
    // The tightening still works: a comment mention far from any occurrence still fails.
    const far = 'function pay2() { return 1; }\n' + '// no calls here\n' + 'const a = 1;\n'.repeat(20) + '// pay2 is mentioned here in a comment only\n';
    const files2 = { 'src/far.js': far };
    const read2 = (p) => files2[p] || null;
    const { index: idx2 } = await G9.indexTree({
      entries: [{ path: 'src/far.js', size: Buffer.byteLength(far) }], readText: read2, commit: 'abc1234'
    });
    const mention = V9.verifyReceipt({ file: 'src/far.js', line: 23, symbol: 'pay2' }, read2, idx2);
    assert(mention.ok === false, 'a comment-only mention verified — the refinement stopped tightening');
  });
  await checkAsync('certificate binds document bytes: a doc edited after the gate refuses to push', async () => {
    const b = await certified9();
    fs.appendFileSync(path.join(b.dir, '.ogma/out/prd.md'), '\nEdited after the gate.\n');
    const msgs = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => msgs.push(m), {}) === 1, 'an edited document shipped under the certified banner');
    assert(msgs.join(' ').includes('changed after the gate'), 'refusal does not name the drift');
  });
  await checkAsync('coverage matches module headings as whole lines, not substrings', async () => {
    const b = await certified9();
    const prdPath = path.join(b.dir, '.ogma/out/prd.md');
    fs.writeFileSync(prdPath, fs.readFileSync(prdPath, 'utf8').replace('## Payments', '#### Payments'));
    assert(GATE.cmdGate(b.dir, quiet) === 1, 'a demoted module heading certified');
    const f = failing9(certOf9(b.dir), 'coverage');
    assert(f && f.detail.includes('payments'), 'coverage did not name the absent module');
  });
  await checkAsync('a markdown-only push preserves page-id mappings from an earlier page-backed push', async () => {
    const b = await certified9();
    const prd = fs.readFileSync(path.join(b.dir, '.ogma/out/prd.md'), 'utf8');
    const crypto9 = require('crypto');
    const state = {
      push_state_version: S.PUSH_STATE_VERSION, kind: 'confluence',
      commit: b.head, delivered_at: '2026-08-08T00:00:00Z',
      files: [{ path: 'prd.md', sha256: crypto9.createHash('sha256').update(prd, 'utf8').digest('hex'), page_id: '4242' }]
    };
    assert(errorsOf(S.validatePushState, state).length === 0, 'fixture state invalid');
    fs.writeFileSync(path.join(b.dir, '.ogma/push-state.json'), JSON.stringify(state, null, 2) + '\n');
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], quiet, {}) === 0, 'markdown-only push failed');
    const st = JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/push-state.json'), 'utf8'));
    assert(st.files.find(f => f.path === 'prd.md').page_id === '4242', 'the page-id mapping was wiped — the next confluence push would create duplicates');
  });
  await checkAsync('a corrupt certificate is reported as corrupt by the map, not as "not yet run"', async () => {
    const b = await certified9();
    fs.writeFileSync(path.join(b.dir, '.ogma/certificate.json'), '{ not json');
    assert(require('../lib/map').cmdMap(b.dir, quiet) === 0, 'map failed on a corrupt certificate');
    const md = fs.readFileSync(path.join(b.dir, '.ogma/out/map.md'), 'utf8');
    assert(md.includes('unreadable'), 'corrupt certificate conflated with absent');
    const html = fs.readFileSync(path.join(b.dir, '.ogma/out/map.html'), 'utf8');
    assert(html.includes('CERT UNREADABLE'), 'dashboard does not distinguish corrupt from absent');
  });
  await checkAsync('an uncitable-only repo and a commitless repo refuse with honest sentences', async () => {
    // Commitless: git internals must not leak into the answer.
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'x.js'), 'x');
    gitIn(dir, ['init', '-q']);
    fs.mkdirSync(path.join(dir, '.ogma/ogham'), { recursive: true });
    const m1 = [];
    assert(cmdTerrain(dir, m => m1.push(m)) === 1, 'terrain ran on a commitless repo');
    assert(m1.join(' ').includes('not a git repository with commits'), 'commitless refusal is not honest: ' + m1.join(' | '));
    // Uncitable-only: every tracked path fails the citability rule (a leading
    // dash is argv-shaped). The answer names the problem, not the validator.
    const dir2 = makeFixtureRepo({ '-x.js': 'x' });
    fs.mkdirSync(path.join(dir2, '.ogma/ogham'), { recursive: true });
    const m2 = [];
    assert(cmdTerrain(dir2, m => m2.push(m)) === 1, 'terrain wrote a terrain with zero surfaces');
    assert(m2.join(' ').includes('nothing citable'), 'uncitable refusal is not honest: ' + m2.join(' | '));
    assert(!m2.join(' ').includes('surfaces must be'), 'the validator leaked into the user-facing answer');
  });
}

// ---- batch 10: the 2026-08-08 ship-panel findings, each pinned -------------

async function batch10Checks() {
  console.log('batch 10 (ship-panel round 2):');
  const P = require('../lib/push');
  const GATE = require('../lib/gate');
  const R = require('../lib/render');
  const M = require('../lib/map');
  const G10 = require('../lib/graph');
  const U = require('../lib/util');

  async function ingested10() {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'b10 fixture: ingest failed');
    return b;
  }
  async function certified10() {
    const b = await ingested10();
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'b10 fixture: render failed');
    assert(M.cmdMap(b.dir, quiet) === 0, 'b10 fixture: map failed');
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'b10 fixture: gate failed');
    return b;
  }

  // F2 — map was the one handler with no try/catch, and bin ran the sync path
  // unguarded: a write refusal escaped as a raw stack instead of a sentence.
  await checkAsync('F2: a map write that cannot proceed fails as a sentence, not a thrown stack', async () => {
    const b = await ingested10();
    // A directory where the document belongs makes the guarded write throw —
    // the same shape a repo-planted symlink produces, without needing symlink
    // privileges on the test machine.
    fs.mkdirSync(path.join(b.dir, '.ogma/out/map.md'), { recursive: true });
    const msgs = [];
    let threw = null;
    let code;
    try { code = M.cmdMap(b.dir, m => msgs.push(m)); } catch (e) { threw = e; }
    assert(threw === null, `cmdMap threw instead of returning: ${threw && threw.message}`);
    assert(code === 1, `expected exit 1, got ${code}`);
    assert(msgs.join(' ').includes('ogma map failed'), 'the failure was not reported in the house form: ' + msgs.join(' | '));
  });
  check('F2: bin guards the synchronous handler path, so no handler can dump a raw stack', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ogma.js'), 'utf8');
    // The sync call must sit inside a try that reports and sets exit 1.
    const guarded = /try\s*\{\s*result\s*=\s*main\(process\.argv\)/.test(src)
      && /catch\s*\(\s*err\s*\)\s*\{[^}]*ogma failed/.test(src);
    assert(guarded, 'bin/ogma.js calls main() outside a try/catch — a throwing handler dumps a stack');
  });

  // F3 — graph was the only entry point that leaked git internals on a repo
  // with no commits; terrain and watch already translated the same condition.
  await checkAsync('F3: graph on a commitless repo answers in English, never with git internals', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
    gitIn(dir, ['init', '-q']);
    assert(cmdInit(dir, quiet) === 0, 'init failed on a commitless repo');
    const msgs = [];
    assert(await G10.cmdGraph(dir, m => msgs.push(m)) === 1, 'graph did not refuse a commitless repo');
    const said = msgs.join(' ');
    assert(said.includes('not a git repository with commits'), 'the refusal is not the translated sentence: ' + said);
    assert(!/rev-parse|fatal:|ambiguous argument/.test(said), 'git internals leaked to the user: ' + said);
  });

  // F4 — escapeXml left the single quote raw, so any future adapter emitting
  // repo-derived text into an attribute would have been an injection point.
  check('F4: escapeXml escapes both quote forms, so attribute contexts are safe too', () => {
    const out = U.escapeXml(`a'b"c<d>e&f`);
    assert(!out.includes("'"), 'single quote left raw — attribute injection stays open');
    assert(out.includes('&#39;') && out.includes('&quot;') && out.includes('&lt;') && out.includes('&amp;'),
      'expected all five escapes: ' + out);
  });

  // F5 (SUPERSEDED by B11-SEC below). Batch 10 asked whether the provenance
  // gate should refuse EVERY tracked .ogma/ file and answered no, reasoning
  // that a committed certificate cannot lie — it would have to name the
  // commit that contains it. That fixpoint is real, and still asserted here,
  // but it was wrongly generalised to the whole directory: facts/ has no
  // fixpoint, and a committed fact file is the payload that actually reaches
  // a reader. The scope question is now settled by B11-SEC; this check keeps
  // the HEAD-binding property itself pinned, since the rest of the design
  // leans on it.
  await checkAsync('F5: a certificate can never authorize a push unless it names the commit that contains it', async () => {
    const b = await certified10();
    const cert = JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/certificate.json'), 'utf8'));
    // Move HEAD without touching any cited code: the certificate now names a
    // commit that is no longer HEAD, which is exactly the shape a repo-shipped
    // certificate is stuck in permanently.
    fs.writeFileSync(path.join(b.dir, 'NOTES.md'), 'unrelated\n');
    gitIn(b.dir, ['add', '-A']);
    gitIn(b.dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'unrelated commit']);
    const msgs = [];
    assert(await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => msgs.push(m)) === 1,
      'a certificate that does not name HEAD was accepted as authorization');
    assert(/certificate is for .* but HEAD is/.test(msgs.join(' ')),
      'the refusal is not the HEAD-binding one: ' + msgs.join(' | ').slice(0, 300));
    assert(cert.commit && cert.commit.length === 40, 'certificate did not record a full commit id');
  });

  // B11-SEC — the round-2 blocking finding, reproduced as the panel ran it:
  // a repository that COMMITS its own Ogham gets those facts adopted as
  // authored, certified, and delivered under the operator's credentials. The
  // witness input_hash is an unkeyed digest of statement + cited code, all of
  // which a repo author holds, so a CONFIRMED ruling forges offline; the one
  // thing the attacker cannot supply — a manifest naming HEAD — is produced by
  // the victim's own ingest run. Every reader must refuse, not just push.
  await checkAsync('B11-SEC: a repo-committed Ogham is refused by ingest, gate AND push — never adopted as authored', async () => {
    const b = await certified10();
    const factsDir = path.join(b.dir, '.ogma/ogham/facts');
    const factFile = fs.readdirSync(factsDir).filter(f => f.endsWith('.json'))[0];
    assert(factFile, 'fixture has no facts file to commit');
    gitIn(b.dir, ['add', '-f', `.ogma/ogham/facts/${factFile}`]);
    gitIn(b.dir, ['-c', 'user.email=bench@ogma.test', '-c', 'user.name=bench', 'commit', '-q', '-m', 'ship an Ogham']);

    for (const [name, run] of [
      ['ingest', () => cmdIngest(b.dir, m => msgs.push(m))],
      ['gate', () => GATE.cmdGate(b.dir, m => msgs.push(m))],
      ['push', async () => await P.cmdPush(b.dir, ['--to', 'markdown-only'], m => msgs.push(m))]
    ]) {
      var msgs = [];
      assert(await run() === 1, `${name} read a repo-committed Ogham instead of refusing it`);
      const said = msgs.join(' ');
      assert(said.includes('tracked by this repository'),
        `${name}'s refusal does not name the provenance problem: ` + said.slice(0, 200));
      assert(said.includes('git rm --cached'), `${name}'s refusal does not tell the operator how to fix it`);
    }
    assert(!fs.existsSync(path.join(b.dir, '.ogma/push-state.json')), 'a refused push left delivery state behind');
  });

  // The other half of the same fix: the ordinary workflow must not produce
  // tracked state in the first place, or the refusal above becomes a tax on
  // every honest user rather than a signal.
  check('B11-SEC: init writes a self-ignoring .ogma/, so `git add -A` cannot track OGMA state', () => {
    const dir = makeFixtureRepo({ 'a.js': 'const x = 1;\n' });
    assert(cmdInit(dir, quiet) === 0, 'init failed');
    const ignore = path.join(dir, '.ogma/.gitignore');
    assert(fs.existsSync(ignore), 'init did not write .ogma/.gitignore');
    assert(/^\*$/m.test(fs.readFileSync(ignore, 'utf8')), '.ogma/.gitignore does not ignore everything');
    gitIn(dir, ['add', '-A']);
    const staged = gitIn(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    assert(!staged.some(p => p.startsWith('.ogma/')), 'git add -A staged OGMA state: ' + staged.join(', '));
  });

  // F6 — an excerpt whose end_line ran past EOF was labelled with the
  // un-clamped range, so the blind judge saw a range wider than the bytes.
  check('F6: an over-EOF citation is labelled with the clamped range it actually shows', () => {
    const read = () => 'one\ntwo\nthree\n';
    const d = W.deriveExcerpts([{ file: 'a.js', line: 1, end_line: 9999 }], read);
    assert(!d.error, 'derivation failed: ' + d.error);
    assert(d.excerpts[0].end_line === 3, `label overstates the excerpt: end_line ${d.excerpts[0].end_line}, file has 3 lines`);
    assert(d.excerpts[0].code === 'one\ntwo\nthree', 'code no longer matches the label');
  });

  // F7 — a 200 whose body carried no version.number reached
  // `.version.number` and threw a TypeError instead of an honest refusal.
  await checkAsync('F7: a Confluence 200 with no version.number is refused, never guessed at', async () => {
    const http = require('http');
    // Honest for every CREATE (so the fleet reaches the seeded update), but
    // page 500 — the one the seeded push-state maps — comes back WITHOUT a
    // version block: a proxy or a drifted API shape.
    const pages = new Map(); let nextId = 700;
    const server = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/wiki/api/v2/spaces') return send(200, { results: [{ id: '9' }] });
        if (req.method === 'POST' && u.pathname === '/wiki/api/v2/pages') {
          const p = JSON.parse(body);
          const id = String(nextId++);
          pages.set(id, { id, title: p.title, status: 'current', version: { number: 1 }, body: p.body.value });
          return send(200, { id, title: p.title });
        }
        const id = u.pathname.split('/').pop();
        if (id === '500') return send(200, { id: '500', title: 'x', status: 'current' });   // no version block
        const page = pages.get(id);
        if (!page) return send(404, {});
        if (u.searchParams.get('body-format') === 'storage') {
          return send(200, { id: page.id, title: page.title, status: page.status, version: page.version, body: { storage: { value: page.body } } });
        }
        return send(200, { id: page.id, title: page.title, status: page.status, version: page.version });
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const env = {
      CONFLUENCE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CONFLUENCE_EMAIL: 'bench@ogma.test', CONFLUENCE_API_TOKEN: 'token'
    };
    try {
      const b = await certified10();
      const cert = JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/certificate.json'), 'utf8'));
      // Seed a page mapping so the run takes the UPDATE path, with a sha that
      // does not match the document so replay cannot skip it.
      fs.writeFileSync(path.join(b.dir, '.ogma/push-state.json'), JSON.stringify({
        push_state_version: S.PUSH_STATE_VERSION,
        kind: 'confluence',
        commit: cert.commit,
        delivered_at: '2026-01-01T00:00:00Z',
        files: [{ path: 'prd.md', sha256: '0'.repeat(64), page_id: '500' }]
      }, null, 2) + '\n');
      const msgs = [];
      assert(await P.cmdPush(b.dir, ['--to', 'confluence', '--space', 'DOCS', '--parent', '1'], m => msgs.push(m), env) === 1,
        'push reported success against a version-less API response');
      const said = msgs.join(' ');
      assert(said.includes('version.number'), 'the failure does not name the missing field: ' + said.slice(0, 300));
      assert(!said.includes('TypeError') && !said.includes('undefined'),
        'the failure surfaced as a JS error rather than a refusal: ' + said.slice(0, 300));
    } finally {
      server.close();
    }
  });

  // F8 — the same four-line rev-parse idiom was hand-copied into ingest,
  // watch, gate and push; drift there desynchronizes what "HEAD" means.
  check('F8: gitHead is the one HEAD reader, and every caller uses it', () => {
    const inRepo = U.gitHead(makeFixtureRepo({ 'a.js': 'x' }));
    assert(!inRepo.error && /^[0-9a-f]{40}$/.test(inRepo.commit), 'gitHead did not return a full sha in a real repo');
    const bare = U.gitHead(tmpdir());
    assert(bare.error && !bare.commit, 'gitHead did not report an error outside a repository');
    for (const f of ['ingest', 'watch', 'gate', 'push']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', `${f}.js`), 'utf8');
      assert(/gitHead\(/.test(src), `lib/${f}.js does not use the shared gitHead`);
      assert(!/spawnSync\('git',\s*\[\s*'-C',\s*cwd,\s*'rev-parse'/.test(src),
        `lib/${f}.js still hand-rolls the rev-parse idiom`);
    }
  });
}

// ---- batch 11: the round-2 ship-panel findings, each pinned ----------------

async function batch11Checks() {
  console.log('batch 11 (ship-panel round 2):');
  const GATE = require('../lib/gate');
  const R = require('../lib/render');
  const M = require('../lib/map');
  const U = require('../lib/util');
  const V11 = require('../lib/verify');
  const W11 = require('../lib/witness');

  // R2-03 — `git cat-file -s` succeeds on a TREE and `git show` returns its
  // listing, so a receipt citing a directory "verified" against text that
  // happened to contain the symbol. A directory is not code.
  check('R2-03: a receipt citing a DIRECTORY does not verify — only blobs are code', () => {
    const dir = makeFixtureRepo({ 'src/pay.js': 'function pay() {}\n', 'src/other.js': 'const x = 1;\n' });
    const head = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    const read = V11.makeGitReader(dir, head);
    assert(read('src') === null, 'a directory was returned as file content');
    assert(typeof read('src/pay.js') === 'string', 'a real file stopped being readable');
    const r = V11.verifyReceipt({ file: 'src', line: 1, symbol: 'pay.js' }, read);
    assert(r.ok === false && r.reason === 'missing-file', 'a directory citation verified: ' + JSON.stringify(r));
    // The witness must not be handed a directory listing as "the cited code".
    const d = W11.deriveExcerpts([{ file: 'src', line: 1 }], read);
    assert(d.error, 'deriveExcerpts produced excerpts from a directory');
  });

  // R2-04 — narrativeText dropped every heading line before the lint ran, and
  // module/feature names are RENDERED AS HEADINGS and repo-derived.
  check('R2-04: banned vocabulary in a heading is caught; readability still ignores headings', () => {
    assert(GATE.leakHits('## The API surface\n\nEverything is fine here.', []).includes('api'),
      'a banned term in a heading escaped the leak lint');
    assert(GATE.leakHits('## Duration conversion\n\nAll good.', []).length === 0, 'a clean heading was flagged');
    // Readability must NOT read headings: a long label is not a sentence.
    const readabilityText = GATE.narrativeText('## Antidisestablishmentarianism\n\nThe cat sat.');
    assert(!readabilityText.includes('Antidisestablish'), 'readability text kept a heading and will skew the grade');
  });

  // R2-08 — the PRD preamble promised every claim traced to verified code
  // while feature narration carries no receipt and no witness. It must state
  // only what is true, and must not fail its own readability gate.
  check('R2-08: the PRD preamble claims only what is checked, and passes its own grade', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'render.js'), 'utf8');
    assert(!/Every claim in this document traces to verified code/.test(src),
      'the PRD still promises that every claim traces to verified code');
    const m = /_Current as of commit \$\{[^}]*\}\. ([^`]*?)_`/.exec(src);
    assert(m, 'could not find the rendered preamble in render.js');
    const preamble = m[1];
    assert(/not checked on their own/.test(preamble),
      'the preamble does not state that the summaries are unchecked: ' + preamble);
    const grade = GATE.fkGrade(GATE.narrativeText('_Current as of commit abc123456789. ' + preamble + '_'));
    assert(grade <= S.defaultConfig('t').readability_max_grade,
      `OGMA's own preamble fails its own readability gate: grade ${grade.toFixed(2)}`);
  });

  // R2-09 — docs said an out/ file outside the contract fails integrity; the
  // check only parsed annotations and never compared the two sets.
  await checkAsync('R2-09: a document in out/ that the contract does not name fails integrity', async () => {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'fixture ingest failed');
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'fixture render failed');
    assert(M.cmdMap(b.dir, quiet) === 0, 'fixture map failed');
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'clean fixture did not certify');
    fs.writeFileSync(path.join(b.dir, '.ogma/out/leftover.md'), '# left over\n');
    const msgs = [];
    assert(GATE.cmdGate(b.dir, m => msgs.push(m)) === 1, 'an unlisted out/ document still certified');
    const cert = JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/certificate.json'), 'utf8'));
    const integrity = cert.checks.find(c => c.check === 'integrity');
    assert(integrity && integrity.pass === false && /leftover\.md/.test(integrity.detail),
      'integrity did not name the unlisted document: ' + JSON.stringify(integrity));
  });

  // R2-10 — leaklint and readability hardcoded 'prd.md' instead of deriving
  // the measured population from the ONE document contract.
  check('R2-10: the measured business documents come from the contract, so a disabled audience is not linted', () => {
    const cfg = { ...S.defaultConfig('t'), audiences: { prd: false, tech: true, guides: true } };
    const terrain = {
      surfaces: [{ id: 'web', kind: 'frontend', root: '.', entry_points: [], modules: [] }],
      modules: [{ id: 'm1', name: 'M One', surface_ids: ['web'], roots: ['src'], summary: 's' }],
      languages: {}
    };
    const docs = S.outDocuments(cfg, terrain);
    assert(!docs.includes('prd.md'), 'outDocuments listed prd.md while the audience is disabled');
    const business = docs.filter(r => r === 'prd.md' || r.startsWith('guides/'));
    assert(JSON.stringify(business) === JSON.stringify(['guides/web.md']),
      'the measured population is not contract-derived: ' + JSON.stringify(business));
    const gateSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gate.js'), 'utf8');
    assert(!/const docs = \['prd\.md'/.test(gateSrc), 'gate.js still hardcodes the business document list');
  });

  // R2-11 — writes refused symlinks; reads followed them. A planted junction
  // sourced the Ogham from outside the repo, and the gate's walk crossed the
  // filesystem (a self-referential link aborted with a raw ELOOP).
  check('R2-11: OGMA state listings refuse a linked directory and never follow linked entries', () => {
    const dir = tmpdir();
    const real = path.join(dir, 'real');
    const outside = tmpdir();
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'a.json'), '{}');
    fs.writeFileSync(path.join(outside, 'planted.json'), '{}');
    assert(JSON.stringify(U.safeListFiles(real)) === JSON.stringify(['a.json']), 'real listing broke');
    const linked = path.join(dir, 'linked');
    try { fs.symlinkSync(outside, linked, 'junction'); } catch { return; }   // no privilege: skip
    let refused = false;
    try { U.safeListFiles(linked); } catch (e) { refused = /symlink/.test(e.message); }
    assert(refused, 'a linked state directory was listed instead of refused');
    // A link INSIDE a walked tree is skipped, never followed.
    const walkRoot = path.join(dir, 'walk');
    fs.mkdirSync(walkRoot);
    fs.writeFileSync(path.join(walkRoot, 'own.md'), '# own\n');
    fs.writeFileSync(path.join(outside, 'foreign.md'), '# foreign\n');
    fs.symlinkSync(outside, path.join(walkRoot, 'escape'), 'junction');
    const walked = U.safeWalkFiles(walkRoot, '.md');
    assert(JSON.stringify(walked) === JSON.stringify(['own.md']),
      'the walk followed a link out of its tree: ' + JSON.stringify(walked));
  });

  // R2-12 — one implementation per contract. sha256 spans the gate/push trust
  // boundary; an encoding change in a private copy silently turns every push
  // into "changed after the gate ran".
  check('R2-12: sha256, MAX_REPORTED, factIndex and narratable each have exactly one implementation', () => {
    assert(typeof U.sha256 === 'function' && U.sha256('x').length === 64, 'util does not own sha256');
    assert(U.MAX_REPORTED === 50, 'util does not own MAX_REPORTED');
    assert(typeof R.factIndex === 'function' && typeof R.narratable === 'function',
      'render does not export the helpers map.js needs');
    for (const f of ['gate', 'push']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', `${f}.js`), 'utf8');
      assert(!/createHash\('sha256'\)/.test(src), `lib/${f}.js still hand-rolls sha256`);
    }
    for (const f of ['ingest', 'watch']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', `${f}.js`), 'utf8');
      assert(!/^const MAX_REPORTED = /m.test(src), `lib/${f}.js still declares its own MAX_REPORTED`);
    }
    const mapSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'map.js'), 'utf8');
    assert(!/new Map\(facts\.map\(/.test(mapSrc), 'map.js still reimplements factIndex');
    assert(/narratable\(feat, byId, 'guides'\)/.test(mapSrc),
      'map.js no longer computes a guides answer at all');
    // The CONSUMER is the half that actually decides what a reader sees: it
    // must read the flag for the audience being rendered, not the prd one.
    assert(/!f\.narratable\[audience\]/.test(mapSrc),
      'map.js answers the guides view with the prd narratable flag');
  });
}

// ---- batch 12: the last two blocking findings -----------------------------

async function batch12Checks() {
  console.log('batch 12 (final blockers):');
  const T = require('../lib/terrain');
  const P = require('../lib/push');
  const GATE = require('../lib/gate');
  const R = require('../lib/render');
  const M = require('../lib/map');

  // R2-05 — a scanned surface whose id collides with an existing one is
  // renamed (web -> web-2), but its MODULES still carried the old id, so they
  // were re-attributed to whichever surface already owned the name. The guide
  // for one app then documented the other app's features, under a PASS.
  check('R2-05: a renamed surface keeps its own modules — a colliding id never steals them', () => {
    const existing = {
      surfaces: [{ id: 'web', kind: 'frontend', root: 'packages/web', entry_points: ['packages/web/package.json'], modules: [] }],
      modules: [{ id: 'web-main', name: 'Web Main', surface_ids: ['web'], roots: ['packages/web/src'], summary: 'first app' }],
      languages: { js: 10 }
    };
    // A second app at a DIFFERENT root whose basename slugs to the same id.
    const scanned = {
      surfaces: [
        { id: 'web', kind: 'frontend', root: 'packages/web', entry_points: ['packages/web/package.json'], modules: [] },
        { id: 'web', kind: 'frontend', root: 'apps/web', entry_points: ['apps/web/package.json'], modules: [] }
      ],
      modules: [
        { id: 'web-main', name: 'Web Main', surface_ids: ['web'], roots: ['packages/web/src'], summary: 'first app' },
        { id: 'web-main', name: 'Web Main', surface_ids: ['web'], roots: ['apps/web/src'], summary: 'second app' }
      ],
      languages: { js: 20 }
    };
    const { terrain } = T.mergeTerrain(existing, scanned);
    const byRoot = new Map(terrain.surfaces.map(s => [s.root, s.id]));
    assert(byRoot.get('apps/web') && byRoot.get('apps/web') !== byRoot.get('packages/web'),
      'the colliding surface was not given its own id: ' + JSON.stringify(terrain.surfaces));
    for (const m of terrain.modules) {
      for (const root of m.roots) {
        // The surface that actually contains this module's root.
        const owner = terrain.surfaces
          .filter(s => root === s.root || root.startsWith(s.root + '/'))
          .sort((a, b) => b.root.length - a.root.length)[0];
        assert(owner, `no surface contains ${root}`);
        assert(m.surface_ids.includes(owner.id),
          `module ${m.id} (${root}) is attributed to ${JSON.stringify(m.surface_ids)} but its root lives under ${owner.id}`);
      }
    }
    // And the second app's module must exist at all — it used to be dropped
    // or misfiled, leaving its surface with zero modules.
    const second = terrain.modules.find(m => m.roots.includes('apps/web/src'));
    assert(second, 'the second app produced no module at all');
    assert(second.surface_ids.includes(byRoot.get('apps/web')),
      'the second app module is not attached to its own surface');
  });

  // R2-07 (decided: option A) — the dashboard is a view over the certificate,
  // so the gate that produces the verdict cannot byte-bind the document that
  // displays it. It used to ship anyway, with its hash check skipped: the one
  // delivered document nobody could vouch for. It is now local-only.
  await checkAsync('R2-07: the dashboard is never delivered, and every document that IS delivered is certificate-bound', async () => {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'fixture ingest failed');
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'fixture render failed');
    assert(M.cmdMap(b.dir, quiet) === 0, 'fixture map failed');
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'fixture did not certify');

    const fleet = P.loadCertifiedFleet(b.dir);
    assert(!fleet.error, 'fleet did not load: ' + fleet.error);
    assert(!fleet.files.some(f => /^map\./.test(f.path)),
      'the dashboard is still in the delivered fleet: ' + fleet.files.map(f => f.path).join(', '));
    assert(fleet.files.length > 0, 'nothing at all would be delivered');

    // Every remaining document must be named by the certificate — the
    // exemption is gone, not merely narrowed.
    const cert = JSON.parse(fs.readFileSync(path.join(b.dir, '.ogma/certificate.json'), 'utf8'));
    const certified = new Set(cert.documents.map(d => d.path));
    for (const f of fleet.files) {
      assert(certified.has(f.path), `${f.path} would ship without being named in the certificate`);
    }

    // The dashboard still exists locally and is still required by the
    // contract — local-only is not the same as deleted.
    assert(fs.existsSync(path.join(b.dir, '.ogma/out/map.md')), 'map.md stopped being written locally');
    const readAt = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
    assert(S.outDocuments(readAt(path.join(b.dir, '.ogma/config.json')),
      readAt(path.join(b.dir, '.ogma/ogham/terrain.json'))).includes('map.md'),
      'map.md fell out of the document contract, so coverage and integrity stopped requiring it');

    // A hand-edited dashboard must not be able to ship, because it does not
    // ship at all — and it must not break the push either.
    fs.writeFileSync(path.join(b.dir, '.ogma/out/map.md'), '# tampered\n');
    const after = P.loadCertifiedFleet(b.dir);
    assert(!after.error, 'a tampered local dashboard broke the push: ' + after.error);
    assert(!after.files.some(f => /^map\./.test(f.path)), 'the tampered dashboard entered the fleet');
  });

  // The other half of option A: a tampered DELIVERABLE still refuses. The
  // exemption removal must not have loosened anything.
  await checkAsync('R2-07: a document edited after the gate still refuses to ship', async () => {
    const b = await buildWholeOgham();
    assert(cmdIngest(b.dir, quiet) === 0, 'fixture ingest failed');
    assert(R.cmdPrd(b.dir, quiet) === 0 && R.cmdExplain(b.dir, quiet) === 0
      && R.cmdGuides(b.dir, quiet) === 0 && R.cmdQuestions(b.dir, quiet) === 0, 'fixture render failed');
    assert(M.cmdMap(b.dir, quiet) === 0, 'fixture map failed');
    assert(GATE.cmdGate(b.dir, quiet) === 0, 'fixture did not certify');
    fs.appendFileSync(path.join(b.dir, '.ogma/out/questions.md'), '\nsneaked in\n');
    const fleet = P.loadCertifiedFleet(b.dir);
    assert(fleet.error && /changed after the gate ran/.test(fleet.error),
      'an edited deliverable was accepted: ' + JSON.stringify(fleet.error));
  });
}

// ---- CLI process-level behavior -------------------------------------------

console.log('cli:');
const BIN = path.join(__dirname, '..', 'bin', 'ogma.js');
function run(args) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }); }
check('--help exits 0 and lists every power', () => {
  const r = run(['--help']);
  assert(r.status === 0, `exit ${r.status}`);
  for (const p of ['init', 'terrain', 'ingest', 'gate', 'watch']) assert(r.stdout.includes(p), `help missing ${p}`);
});
check('help shows terrain as built — no "not built yet" tag on its line', () => {
  const r = run(['--help']);
  const line = r.stdout.split('\n').find(l => l.trim().startsWith('terrain'));
  assert(line && !line.includes('not built yet'), `terrain line: ${line}`);
});
// Every power now has a handler; the honest-stub refusal in bin/ still guards
// any FUTURE power added without one. What replaces the old unbuilt-command
// check: the built watch refusing to run without its prerequisites.
check('watch in a bare directory exits 1 and points at ingest', () => {
  const dir = tmpdir();
  const r = spawnSync(process.execPath, [BIN, 'watch'], { encoding: 'utf8', cwd: dir });
  assert(r.status === 1, `exit ${r.status}`);
  assert((r.stdout + r.stderr).includes('ogma ingest'), 'no pointer at ingest');
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

// ---- the bench cleans up after itself -------------------------------------

console.log('housekeeping:');
const leaked = [];
for (const d of TEMPS) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* reported below */ }
  if (fs.existsSync(d)) leaked.push(d);
}
check('bench leaves no temp directories behind', () => {
  assert(TEMPS.length > 0, 'no temp dirs were tracked — the helper is not being used');
  assert(leaked.length === 0, `leaked ${leaked.length} temp dirs: ${leaked.join(', ')}`);
});

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;

})().catch(e => {
  console.error(`bench crashed: ${e.stack || e.message}`);
  process.exitCode = 1;
});
