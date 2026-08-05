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
    assert(S.rendersTo({ classification: c }, 'prd') === false, `${c} reached prd`);
    assert(S.rendersTo({ classification: c }, 'guides') === false, `${c} reached guides`);
    assert(S.rendersTo({ classification: c }, 'tech') === true, `${c} hidden from tech output`);
  }
  assert(S.rendersTo({ classification: 'LIVE' }, 'prd') === true, 'LIVE excluded from prd');
  assert(S.rendersTo({ classification: 'BOGUS' }, 'tech') === false, 'unknown classification rendered');
  assert(S.rendersTo({ classification: 'LIVE' }, 'nonsense') === false, 'unknown audience rendered');
  assert(S.rendersTo(null, 'prd') === false, 'null fact rendered');
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
  for (const p of ['../x.md', '/etc/x.md', 'tech/../../x.md', 'x.md ', 'tech/x.txt', '']) {
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
  fs.writeFileSync(ledgerPath, JSON.stringify({ questions: [{ id: 'Q-1' }] }));
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
  if (!made) { console.log('       (file symlinks unavailable on this machine — dir case covers the class)'); return; }
  const msgs = [];
  assert(cmdInit(dir, m => msgs.push(m)) === 1, 'init wrote through a symlinked ledger');
  assert(!fs.existsSync(outside), 'created a file outside the project through the link');
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

// ---- CLI process-level behavior -------------------------------------------

console.log('cli:');
const BIN = path.join(__dirname, '..', 'bin', 'ogma.js');
function run(args) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }); }
check('--help exits 0 and lists every power', () => {
  const r = run(['--help']);
  assert(r.status === 0, `exit ${r.status}`);
  for (const p of ['init', 'ingest', 'gate', 'watch']) assert(r.stdout.includes(p), `help missing ${p}`);
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
