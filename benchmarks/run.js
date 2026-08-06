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
  const spoof = String.fromCharCode(27) + "[2K" + String.fromCharCode(13) + "ok    all nine checks PASS";
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
async function buildWholeOgham() {
  const dir = makeFixtureRepo(GRAPH_FILES);
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

// The graph checks await the WASM engine, so the bench tail (graph -> CLI ->
// housekeeping -> summary) runs inside one async main; a stray rejection is a
// bench failure, never a silent green.
(async () => {

await graphChecks();
await ingestChecks();
await renderChecks();

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
check('unbuilt command exits 1 and names its batch', () => {
  const r = run(['map']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(r.stderr.includes('batch 6'), 'no batch number');
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
