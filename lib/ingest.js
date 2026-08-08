// ogma ingest — the deterministic bookend of a read. The sweeps (reading
// code, authoring facts, witnessing) are the skill layer's work; this command
// proves the result is structurally whole and writes the manifest. It checks:
//   1. every Ogham file validates against its schema
//   2. facts <-> terrain reconcile in BOTH directions (a facts file for a
//      module terrain does not know, or a terrain module with no facts file,
//      is documentation silently missing while everything else reads green —
//      the product's own worst failure mode, so it is checked here, not
//      deferred to judgment)
//   3. every receipt verifies against the repo (graph-backed where the graph
//      is current for that fact's commit)
//   4. every witness ruling is BOUND: its input_hash recomputes from the
//      statement + the excerpts derived at the fact's own commit — a forged
//      or stale hash cannot pass
//   5. ids are globally unique; every ledger_ref and raised id resolves
// On success it writes ogham/manifest.json. On failure it names everything
// it found and writes nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./schema');
const { verifyReceipt, makeReaderCache } = require('./verify');
const { factInputHash } = require('./witness');
const { reachableFrom } = require('./graph');
const { makeCurrencyChecker } = require('./watch');
const { readJson, nowIso, ogmaWrite, gitHead } = require('./util');

const MAX_REPORTED = 50;

function cmdIngest(cwd, log = console.log) {
  try {
    const ogham = path.join(cwd, '.ogma', 'ogham');
    if (!fs.existsSync(ogham)) { log('No .ogma/ogham/ here — run `ogma init` first.'); return 1; }

    const head = gitHead(cwd);
    if (head.error) { log('ogma ingest failed: not a git repository with commits.'); return 1; }
    const headCommit = head.commit;

    const errors = [];
    const warnings = [];
    const err = (m) => { if (errors.length < S.MAX_ERRORS) errors.push(m); };

    // --- load + schema-validate every Ogham file -----------------------------
    const configRead = readJson(path.join(cwd, '.ogma', 'config.json'));
    if (configRead.error) { log(`ogma ingest failed: config.json unreadable: ${S.safe(configRead.error, 200)}`); return 1; }
    const config = configRead.value;
    S.validateConfig(config, errors);

    const terrainRead = readJson(path.join(ogham, 'terrain.json'));
    if (terrainRead.error) { log('ogma ingest failed: terrain.json missing or unreadable — run `ogma terrain` first.'); return 1; }
    const terrain = terrainRead.value;
    S.validateTerrain(terrain, errors);

    const graphRead = readJson(path.join(ogham, 'graph', 'index.json'));
    if (graphRead.error) { log('ogma ingest failed: graph/index.json missing or unreadable — run `ogma graph` first.'); return 1; }
    const graph = graphRead.value;
    S.validateGraphIndex(graph, errors);
    const graphCurrent = S.sameCommit(graph.commit, headCommit);
    if (!graphCurrent) {
      log(`ogma ingest failed: graph is at ${S.safe(String(graph.commit), 20)} but HEAD is ${headCommit.slice(0, 12)} — re-run \`ogma graph\`.`);
      return 1;
    }

    const ledgerRead = readJson(path.join(ogham, 'ledger.json'));
    if (ledgerRead.error) { log('ogma ingest failed: ledger.json unreadable — run `ogma init` to scaffold it.'); return 1; }
    const ledger = ledgerRead.value;
    S.validateLedgerFile(ledger, errors);

    const raisedPath = path.join(ogham, 'raised.json');
    let raised = { raised: [] };
    if (fs.existsSync(raisedPath)) {
      const raisedRead = readJson(raisedPath);
      if (raisedRead.error) err(`raised.json unreadable: ${S.safe(raisedRead.error, 120)}`);
      else { raised = raisedRead.value; S.validateRaised(raised, errors); }
    }

    const factsDir = path.join(ogham, 'facts');
    const factFiles = fs.existsSync(factsDir)
      ? fs.readdirSync(factsDir).filter(f => f.endsWith('.json')).sort()
      : [];
    const moduleDocs = new Map(); // module id -> doc
    for (const f of factFiles) {
      const read = readJson(path.join(factsDir, f));
      if (read.error) { err(`facts/${f}: unreadable: ${S.safe(read.error, 120)}`); continue; }
      const doc = read.value;
      S.validateModuleFile(doc, errors);
      if (doc && typeof doc.module === 'string') {
        if (moduleDocs.has(doc.module)) err(`facts/${f}: module "${S.safe(doc.module, 60)}" already defined by another facts file`);
        else moduleDocs.set(doc.module, doc);
      }
    }

    // --- facts <-> terrain reconciliation, both directions -------------------
    const terrainModuleIds = new Set(
      (Array.isArray(terrain.modules) ? terrain.modules : [])
        .filter(m => m && typeof m.id === 'string').map(m => m.id));
    for (const id of moduleDocs.keys()) {
      if (!terrainModuleIds.has(id)) {
        err(`facts file exists for module "${S.safe(id, 60)}" but terrain does not know that module — orphaned documentation`);
      }
    }
    for (const id of terrainModuleIds) {
      if (!moduleDocs.has(id)) {
        err(`terrain module "${S.safe(id, 60)}" has no facts file — its documentation is silently missing`);
      }
    }

    // --- global id uniqueness + reference resolution -------------------------
    const questionIds = new Set();
    for (const q of Array.isArray(ledger.questions) ? ledger.questions : []) {
      if (q && typeof q.id === 'string') questionIds.add(q.id);
    }
    const globalIds = new Set([...questionIds]);
    const allFacts = [];
    for (const [moduleId, doc] of moduleDocs) {
      const features = Array.isArray(doc.features) ? doc.features : [];
      const facts = Array.isArray(doc.facts) ? doc.facts : [];
      for (const rec of [...features, ...facts]) {
        if (!rec || typeof rec.id !== 'string') continue;
        if (globalIds.has(rec.id)) err(`${S.safe(rec.id, 80)}: id is not unique across the Ogham`);
        globalIds.add(rec.id);
      }
      for (const fact of facts) {
        if (fact && typeof fact.id === 'string') allFacts.push({ moduleId, fact });
      }
    }
    for (const { fact } of allFacts) {
      for (const ref of Array.isArray(fact.ledger_refs) ? fact.ledger_refs : []) {
        if (!questionIds.has(ref)) err(`${S.safe(fact.id, 80)}: ledger_ref "${S.safe(ref, 60)}" resolves to no ledger question`);
      }
    }
    for (const id of Array.isArray(raised.raised) ? raised.raised : []) {
      if (typeof id === 'string' && !questionIds.has(id)) {
        err(`raised id "${S.safe(id, 60)}" resolves to no ledger question — a raised flag was never authored`);
      }
    }

    // --- receipts + witness binding, per fact at its own commit --------------
    const readerAt = makeReaderCache(cwd);

    // --- currency at HEAD: the cutoff may not advance over moved code --------
    // The manifest's cutoff_commit is stamped to HEAD below, and everything
    // downstream (render banners, the gate's HEAD binding, watch's "nothing
    // moved") trusts that stamp. Receipts verify at each fact's OWN commit,
    // so without this check a commit that rewrote cited code still ingested
    // clean — certifying a PRD that contradicts HEAD and permanently
    // disarming watch. A fresh fact whose cited ranges were touched since
    // its verified commit is stale, and stale is a refusal here, not a
    // footnote. Cannot-diff refuses too: silence is not freshness.
    const staleReason = makeCurrencyChecker(cwd, headCommit);
    for (const { fact } of allFacts) {
      if (fact.status === 'stale') {
        err(`${S.safe(fact.id, 80)}: status is stale — re-read it at HEAD (re-author, re-witness, set verified_at_commit) before ingest advances the cutoff`);
        continue;
      }
      const reason = staleReason(fact);
      if (reason !== null) {
        err(`${S.safe(fact.id, 80)}: cited code moved since its verified commit (${reason}) — run \`ogma watch\`, re-read the stale facts, then re-run ingest`);
      }
    }

    for (const { fact } of allFacts) {
      const commit = S.isCommitish(fact.verified_at_commit) ? fact.verified_at_commit : headCommit;
      const reader = readerAt(commit);
      // Graph refinement only when the graph describes THIS fact's commit;
      // refining an old-commit receipt against a HEAD graph would reject
      // legitimately drifted citations for the wrong reason.
      const useGraph = S.sameCommit(commit, headCommit) ? graph : undefined;
      const receipts = S.receiptsOf(fact);
      receipts.forEach((r, i) => {
        const v = verifyReceipt(r, reader, useGraph);
        if (!v.ok) err(`${S.safe(fact.id, 80)}: receipt[${i}] failed verification (${v.reason}): ${v.detail}`);
      });
      if (S.isObject(fact.witness) && Array.isArray(fact.receipts) && fact.receipts.length > 0) {
        const h = factInputHash(fact.statement, fact.receipts, reader);
        if (h.error) err(`${S.safe(fact.id, 80)}: witness excerpts underivable — ${S.safe(h.error, 160)}`);
        else if (h.hash !== fact.witness.input_hash) {
          err(`${S.safe(fact.id, 80)}: witness.input_hash does not recompute from the statement + cited code at ${S.safe(commit.slice(0, 12), 12)} — the ruling is forged or stale`);
        }
      }
    }

    // --- ledger question receipts verify at HEAD -----------------------------
    const headReader = readerAt(headCommit);
    for (const q of Array.isArray(ledger.questions) ? ledger.questions : []) {
      if (!q || !Array.isArray(q.receipts)) continue;
      q.receipts.forEach((r, i) => {
        const v = verifyReceipt(r, headReader, graph);
        if (!v.ok) err(`ledger ${S.safe(q.id, 60)}: receipt[${i}] failed verification (${v.reason})`);
      });
    }

    // --- classifier contradiction signal (warning, not verdict) --------------
    const reach = reachableFrom(graph, ['(top)']);
    for (const { fact } of allFacts) {
      if (fact.classification !== 'LIVE' || !fact.path || !Array.isArray(fact.path.chain)) continue;
      const hopSymbols = fact.path.chain.map(h => h && h.receipt && h.receipt.symbol).filter(Boolean);
      if (hopSymbols.length > 0 && hopSymbols.every(s => !reach.has(s))) {
        warnings.push(`${S.safe(fact.id, 80)}: LIVE, but no symbol on its path is reachable from (top) in the graph — re-check the wiring or ledger it`);
      }
    }

    if (errors.length > 0) {
      log(`ogma ingest: the Ogham is NOT whole — ${errors.length} finding(s):`);
      for (const e of errors.slice(0, MAX_REPORTED)) log(`  - ${e}`);
      if (errors.length > MAX_REPORTED) log(`  ... ${errors.length - MAX_REPORTED} more`);
      log('Nothing was written. Fix the findings and re-run.');
      return 1;
    }

    // --- manifest ------------------------------------------------------------
    const counts = {
      surfaces: Array.isArray(terrain.surfaces) ? terrain.surfaces.length : 0,
      modules: terrainModuleIds.size,
      features: [...moduleDocs.values()].reduce((n, d) => n + (Array.isArray(d.features) ? d.features.length : 0), 0),
      facts: allFacts.length,
      ledger_open: (Array.isArray(ledger.questions) ? ledger.questions : []).filter(q => q && q.status === 'open').length
    };
    const manifest = {
      ogham_version: S.OGHAM_VERSION,
      project: config.project,
      repo_root: '.',
      cutoff_commit: headCommit,
      generated_at: nowIso(),
      counts
    };
    const mErrors = [];
    S.validateManifest(manifest, mErrors);
    if (mErrors.length) { log('ogma ingest failed: produced an invalid manifest: ' + mErrors.slice(0, 3).join('; ')); return 1; }
    ogmaWrite(cwd, 'ogham/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

    log(`Ogham is whole at ${headCommit.slice(0, 12)}: ${counts.modules} modules, ${counts.features} features, ${counts.facts} facts, ${counts.ledger_open} open questions.`);
    for (const w of warnings.slice(0, MAX_REPORTED)) log(`  warning: ${w}`);
    log('Wrote ogham/manifest.json');
    return 0;
  } catch (e) {
    log(`ogma ingest failed: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdIngest };
