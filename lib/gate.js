// The Gate — ten deterministic checks and the certificate. This is the
// certifying boundary: some checks re-prove what ingest already proved
// (receipts, witness binding, ledger integrity) because the gate runs on
// whatever is on disk NOW, not on what ingest saw earlier; the rest exist
// only here (coverage, leak lint, readability, HEAD binding, annotation
// resolution). The certificate is written on PASS and on FAIL alike — an
// honest failing certificate is the product working, not the product broken.
//
// Pass conditions are pinned here in executable form; docs/ogham-schema.md
// states them in prose and the two change together.
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./schema');
const { verifyReceipt, makeReaderCache, containsWord } = require('./verify');
const { factInputHash } = require('./witness');
const { loadOgham, parseAnnotations, stripAnnotations, buildDocuments } = require('./render');
const { makeCurrencyChecker } = require('./watch');
const { readJson, nowIso, ogmaWrite, gitHead, safeWalkFiles, sha256, trackedOgmaState, refuseTrackedOgma } = require('./util');

// ---------------------------------------------------------------------------
// Readability: Flesch-Kincaid grade. The measured population is PINNED:
// each of prd.md and guides/*.md, taken whole, after stripAnnotations,
// after removing fenced and inline code, after dropping heading lines.
// Grade is computed PER DOCUMENT; the check passes iff every measured
// document's grade <= config.readability_max_grade. Syllables: vowel-group
// counting ([aeiouy]+ runs), minus a silent trailing 'e', minimum 1.
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  const groups = (w.match(/[aeiouy]+/g) || []).length;
  const silentE = w.length > 2 && w.endsWith('e') && !/[aeiouy]/.test(w[w.length - 2]) ? 1 : 0;
  return Math.max(1, groups - silentE);
}

// The prose a check measures. Headings are handled differently by the two
// callers on purpose:
//   - READABILITY drops them. A heading is a label, not a sentence; feeding
//     "## Duration conversion" to a grade-level formula measures nothing and
//     skews the score of the text that matters.
//   - LEAK LINT keeps their words. Module and feature names are rendered as
//     headings and are repo-derived (a module name is humanize() of a
//     directory slug), so dropping heading lines let `## The API surface`
//     ship to business readers under a certificate stating no technical
//     vocabulary reached them. The banned word is just as loud in a heading.
function narrativeText(markdown, { keepHeadings = false } = {}) {
  const lines = stripAnnotations(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n');
  return (keepHeadings
    ? lines.map(line => line.replace(/^\s*#{1,6}\s+/, ''))
    : lines.filter(line => !/^\s*#/.test(line))
  ).join('\n');
}

function fkGrade(text) {
  const words = (text.match(/[A-Za-z][A-Za-z'-]*/g) || []);
  if (words.length === 0) return 0;
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) || []).length);
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

// ---------------------------------------------------------------------------
// Leak lint: banned technical vocabulary in business/guide output.
// LEAKLINT_BASE terms plus config.leaklint_extra — extras are LITERAL TERMS,
// never regex source: a regex here would hand pattern syntax (and
// catastrophic backtracking) to a config file. Matching is case-insensitive
// whole-word on the same narrative text readability measures.
function leakHits(markdown, extraTerms) {
  const text = narrativeText(markdown, { keepHeadings: true }).toLowerCase();
  const hits = [];
  const terms = [...S.LEAKLINT_BASE, ...(Array.isArray(extraTerms) ? extraTerms : [])]
    .filter(t => typeof t === 'string' && t.trim().length > 0);
  for (const term of terms) {
    if (containsWord(text, term.toLowerCase())) hits.push(term);
  }
  return hits;
}

// ---------------------------------------------------------------------------

function cmdGate(cwd, log = console.log) {
  try {
    const o = loadOgham(cwd);
    if (o.error) { log(`ogma gate failed: ${o.error}`); return 1; }

    const head = gitHead(cwd);
    if (head.error) { log('ogma gate failed: not a git repository with commits.'); return 1; }
    const headCommit = head.commit;

    // The certifying boundary re-asks the provenance question rather than
    // trusting that ingest ran here: a certificate is the artifact everything
    // downstream believes, so it must never be issued over state the repo
    // supplied. Refuse rather than emit a FAIL certificate — a certificate at
    // all would imply this Ogham was ours to judge.
    const trackedState = trackedOgmaState(cwd);
    if (trackedState.length > 0) { refuseTrackedOgma('gate', trackedState, log); return 1; }

    const out = path.join(cwd, '.ogma', 'out');
    const readOut = (rel) => {
      try { return fs.readFileSync(path.join(out, rel), 'utf8'); } catch { return null; }
    };
    const checks = [];
    const record = (check, pass, detail) => checks.push({ check, pass, detail });

    // Collect facts/features once.
    const allFacts = [];
    const allFeatures = [];
    for (const doc of o.modules.values()) {
      for (const f of Array.isArray(doc.facts) ? doc.facts : []) allFacts.push(f);
      for (const f of Array.isArray(doc.features) ? doc.features : []) allFeatures.push(f);
    }
    const factIds = new Set(allFacts.map(f => f.id));
    const featureIds = new Set(allFeatures.map(f => f.id));

    // The documents written for non-technical readers — the population the
    // leak lint and the readability grade both measure. Derived from the ONE
    // document contract, never re-listed: leaklint and readability each used
    // to hardcode 'prd.md' and re-derive the guide list, so with prd disabled
    // they linted and graded a stale prd.md that was not part of the certified
    // fleet at all.
    const businessDocs = S.outDocuments(o.config, o.terrain)
      .filter(rel => rel === 'prd.md' || rel.startsWith('guides/'));

    // 1. coverage — every expected document exists; every terrain module has
    // its section in the PRD when prd is enabled. Exemptions (worker/service
    // surfaces get no guide) are built into outDocuments and recorded here.
    {
      const expected = S.outDocuments(o.config, o.terrain);
      const missing = expected.filter(rel => readOut(rel) === null);
      const detailParts = [];
      let pass = missing.length === 0;
      if (missing.length) detailParts.push(`missing documents: ${missing.join(', ')}`);
      if (o.config.audiences.prd === true) {
        // Whole-line match, not substring: `prd.includes('## Name')` was
        // satisfied by ANY deeper heading (#### Name), so a demoted module
        // heading still certified.
        const prdLines = new Set((readOut('prd.md') || '').split('\n'));
        const absent = o.terrain.modules.filter(m => !prdLines.has(`## ${m.name}`)).map(m => m.id);
        if (absent.length) { pass = false; detailParts.push(`modules absent from prd.md: ${absent.join(', ')}`); }
      }
      const exempt = o.terrain.surfaces.filter(s => !S.INTERACTIVE_SURFACE_KINDS.includes(s.kind)).map(s => s.id);
      if (exempt.length) detailParts.push(`guide-exempt (non-interactive): ${exempt.join(', ')}`);
      record('coverage', pass, detailParts.join(' | ') || `all ${expected.length} expected documents present`);
    }

    // The graph is part of the certified state: without it the receipt check
    // runs weaker than ingest's (text-backed only) and passes states ingest
    // refuses. Missing or off-HEAD graph is a freshness failure below; when
    // current, it refines the receipt check here exactly as ingest does.
    const graphRead = readJson(path.join(cwd, '.ogma', 'ogham', 'graph', 'index.json'));
    let graph = null;
    let graphProblem = null;
    if (graphRead.error) {
      graphProblem = 'graph/index.json missing or unreadable — run `ogma graph`';
    } else {
      const gErrors = [];
      S.validateGraphIndex(graphRead.value, gErrors);
      if (gErrors.length) graphProblem = `graph/index.json is not valid: ${gErrors[0]}`;
      else if (!S.sameCommit(graphRead.value.commit, headCommit)) {
        graphProblem = `graph is at ${S.safe(String(graphRead.value.commit), 20)} but HEAD is ${headCommit.slice(0, 12)} — re-run \`ogma graph\``;
      } else graph = graphRead.value;
    }

    const readerAt = makeReaderCache(cwd);

    // 2. receipts — every receipt on every fact and ledger question verifies
    // against the repo at the fact's own commit, graph-refined when the graph
    // describes that commit (the same rule ingest applies).
    {
      const failures = [];
      for (const f of allFacts) {
        const commit = S.isCommitish(f.verified_at_commit) ? f.verified_at_commit : headCommit;
        const reader = readerAt(commit);
        const useGraph = graph && S.sameCommit(commit, headCommit) ? graph : undefined;
        for (const r of S.receiptsOf(f)) {
          const v = verifyReceipt(r, reader, useGraph);
          if (!v.ok) failures.push(`${f.id}: ${v.reason}`);
        }
      }
      for (const q of Array.isArray(o.ledger.questions) ? o.ledger.questions : []) {
        for (const r of Array.isArray(q.receipts) ? q.receipts : []) {
          const v = verifyReceipt(r, readerAt(headCommit), graph || undefined);
          if (!v.ok) failures.push(`${q.id}: ${v.reason}`);
        }
      }
      record('receipts', failures.length === 0,
        failures.length ? failures.slice(0, 10).join('; ') : `all receipts verified`);
      // 3. witness — every fact carries a ruling; LIVE means CONFIRMED at the
      // verified commit; every input_hash recomputes from statement + cited code.
      const wFailures = [];
      for (const f of allFacts) {
        if (!S.isObject(f.witness)) { wFailures.push(`${f.id}: no ruling`); continue; }
        if (f.classification === 'LIVE' && f.witness.verdict !== 'CONFIRMED') {
          wFailures.push(`${f.id}: LIVE without CONFIRMED`);
        }
        if (Array.isArray(f.receipts) && f.receipts.length > 0) {
          const commit = S.isCommitish(f.verified_at_commit) ? f.verified_at_commit : headCommit;
          const h = factInputHash(f.statement, f.receipts, readerAt(commit));
          if (h.error) wFailures.push(`${f.id}: excerpts underivable`);
          else if (h.hash !== f.witness.input_hash) wFailures.push(`${f.id}: ruling not bound to this statement+code`);
        }
      }
      record('witness', wFailures.length === 0,
        wFailures.length ? wFailures.slice(0, 10).join('; ') : 'every ruling present and bound');
    }

    // 4. leaklint — banned technical vocabulary in business/guide documents.
    {
      const hits = [];
      const docs = businessDocs;
      for (const rel of docs) {
        const text = readOut(rel);
        if (text === null) continue;   // absence is coverage's finding, not leaklint's
        for (const term of leakHits(text, o.config.leaklint_extra)) hits.push(`"${term}" in ${rel}`);
      }
      record('leaklint', hits.length === 0, hits.length ? hits.slice(0, 10).join('; ') : `none of the ${S.LEAKLINT_BASE.length + (Array.isArray(o.config.leaklint_extra) ? o.config.leaklint_extra.length : 0)} banned terms appear in business or guide output`);
    }

    // 5. complete — narration policy (schema-enforced; re-proven here at the boundary).
    {
      const failures = [];
      for (const feat of allFeatures) {
        const narrated = ['does', 'happens', 'sees'].every(k => typeof feat[k] === 'string' && feat[k].trim().length > 0);
        if (feat.classification === 'LIVE' && !narrated) failures.push(`${feat.id}: LIVE without does/happens/sees`);
        if (!narrated && !(typeof feat.why_not_narrated === 'string' && feat.why_not_narrated.trim().length > 0)) {
          failures.push(`${feat.id}: neither narrated nor why_not_narrated`);
        }
      }
      record('complete', failures.length === 0, failures.length ? failures.slice(0, 10).join('; ') : 'narration policy holds');
    }

    // 6. ledger — every raised flag resolves to a ledger question.
    {
      const qIds = new Set((Array.isArray(o.ledger.questions) ? o.ledger.questions : []).map(q => q.id));
      const raisedPath = path.join(cwd, '.ogma', 'ogham', 'raised.json');
      let dangling = [];
      if (fs.existsSync(raisedPath)) {
        try {
          const raised = JSON.parse(fs.readFileSync(raisedPath, 'utf8'));
          dangling = (Array.isArray(raised.raised) ? raised.raised : []).filter(id => !qIds.has(id));
        } catch { dangling = ['raised.json unreadable']; }
      }
      const noRef = allFacts.filter(f =>
        (f.classification === 'HALF-BUILT' || f.classification === 'UNCLEAR')
        && !(Array.isArray(f.ledger_refs) && f.ledger_refs.length > 0 && f.ledger_refs.every(r => qIds.has(r))));
      const pass = dangling.length === 0 && noRef.length === 0;
      record('ledger', pass, pass ? 'every flag filed with an id'
        : [...dangling.map(d => `raised ${d} unresolved`), ...noRef.map(f => `${f.id}: doubtful without a resolving ledger question`)].slice(0, 10).join('; '));
    }

    // 7. orphans — feature<->fact bidirectional per module file (schema),
    // plus: every fact belongs to a feature that exists.
    {
      const failures = [];
      for (const doc of o.modules.values()) {
        const errs = [];
        S.validateModuleFile(doc, errs);
        failures.push(...errs);
      }
      record('orphans', failures.length === 0, failures.length ? failures.slice(0, 10).join('; ') : 'module files internally whole');
    }

    // 8. readability — FK grade per business/guide document, against config.
    {
      const failures = [];
      const details = [];
      const docs = businessDocs;
      for (const rel of docs) {
        const text = readOut(rel);
        if (text === null) continue;
        const grade = fkGrade(narrativeText(text));
        details.push(`${rel}: grade ${grade.toFixed(1)}`);
        if (grade > o.config.readability_max_grade) failures.push(`${rel}: grade ${grade.toFixed(1)} > max ${o.config.readability_max_grade}`);
      }
      record('readability', failures.length === 0, (failures.length ? failures : details).join('; ') || 'no measurable documents');
    }

    // 9. integrity — bound to HEAD; global id uniqueness; every annotation in
    // every rendered document resolves to a real fact or feature (an
    // annotation nothing owns is a fabricated claim wearing a receipt).
    {
      const failures = [];
      if (!S.oghamIsBound(o.manifest.cutoff_commit, headCommit)) {
        failures.push(`manifest.cutoff_commit ${String(o.manifest.cutoff_commit).slice(0, 12)} != HEAD ${headCommit.slice(0, 12)} — run watch/ingest`);
      }
      const seen = new Set();
      for (const id of [...allFacts.map(f => f.id), ...allFeatures.map(f => f.id),
                        ...(Array.isArray(o.ledger.questions) ? o.ledger.questions : []).map(q => q.id)]) {
        if (typeof id !== 'string') continue;
        if (seen.has(id)) failures.push(`duplicate id ${S.safe(id, 60)}`);
        seen.add(id);
      }
      // Guarded walk: real directories only. The previous local walk used
      // statSync, which follows links, so a planted link under out/ traversed
      // the operator's filesystem and a self-referential one aborted the whole
      // command with a raw ELOOP instead of a named finding.
      const walked = safeWalkFiles(out, '.md');
      // The out/ contract, enforced where the docs say it is enforced: a
      // document sitting in out/ that the contract does not name has no
      // certified provenance — it is a leftover from an earlier config or a
      // file someone dropped there, and shipping it under a PASS certificate
      // is exactly the silent-extra-document case coverage cannot see (it only
      // looks for what is MISSING).
      const contract = new Set(S.outDocuments(o.config, o.terrain));
      for (const rel of walked) {
        if (!contract.has(rel)) {
          failures.push(`out/${rel} is not in the document contract — remove it or enable the audience that owns it`);
        }
      }
      for (const rel of walked) {
        for (const a of parseAnnotations(readOut(rel) || '')) {
          const pool = a.kind === 'fact' ? factIds : featureIds;
          if (!pool.has(a.id)) failures.push(`${rel}: annotation ${a.kind}:${a.id} resolves to nothing in the Ogham`);
        }
      }
      record('integrity', failures.length === 0, failures.length ? failures.slice(0, 10).join('; ') : `bound to ${headCommit.slice(0, 12)}, ids unique, annotations resolve`);
    }

    // 10. freshness — the certifying boundary's own answer to "does this
    // documentation still describe HEAD". Four things, each of which slipped
    // past the other nine at least once:
    //   a. the graph must exist, validate and describe HEAD (else the receipt
    //      check silently ran weaker than ingest's);
    //   b. no fact may be marked stale — a stale fact is a re-read that has
    //      not happened, and its feature is silently absent from business
    //      output, which is documentation silently missing;
    //   c. every fresh fact's cited ranges must be untouched between its
    //      verified commit and HEAD (the same invalidation signal watch
    //      computes — cannot-diff fails, silence is not freshness);
    //   d. every renderer-owned document on disk must byte-match a fresh
    //      rebuild from the Ogham — this is what binds rendered prose to fact
    //      content and status, so a document rendered before a fact changed
    //      can never ship under a passing certificate.
    const renderedDocs = [];   // { path, sha256 } for the certificate
    {
      const failures = [];
      if (graphProblem) failures.push(graphProblem);
      const staleReason = makeCurrencyChecker(cwd, headCommit);
      for (const f of allFacts) {
        if (f.status === 'stale') { failures.push(`${f.id}: stale — awaiting its re-read at HEAD`); continue; }
        const reason = staleReason(f);
        if (reason !== null) failures.push(`${f.id}: cited code moved (${reason}) — run \`ogma watch\` and re-read`);
      }
      const built = buildDocuments(o);
      for (const [rel, content] of built) {
        const onDisk = readOut(rel);
        if (onDisk === null) continue;   // absence is coverage's finding, not freshness's
        if (onDisk !== content) {
          failures.push(`out/${rel} does not match the Ogham — re-render before certifying`);
        } else {
          renderedDocs.push({ path: rel, sha256: sha256(onDisk) });
        }
      }
      record('freshness', failures.length === 0,
        failures.length ? failures.slice(0, 10).join('; ')
          : `every fact current at ${headCommit.slice(0, 12)}, every document matches the Ogham`);
    }

    // --- certificate, written on pass AND fail -------------------------------
    const pass = checks.every(c => c.pass);
    const certificate = {
      certificate_version: S.CERTIFICATE_VERSION,
      project: o.config.project,
      commit: headCommit,
      generated_at: nowIso(),
      pass,
      checks,
      counts: o.manifest.counts,
      // The certified bytes: push refuses to deliver a document whose hash
      // moved after the gate. On a failing run this still records whatever
      // verified, but the pass flag gates delivery regardless.
      documents: renderedDocs.sort((a, b) => a.path.localeCompare(b.path))
    };
    const certErrors = [];
    S.validateCertificate(certificate, certErrors);
    if (certErrors.length) { log('ogma gate failed: produced an invalid certificate: ' + certErrors.slice(0, 3).join('; ')); return 1; }
    ogmaWrite(cwd, 'certificate.json', JSON.stringify(certificate, null, 2) + '\n');

    const badge = pass ? 'PASS' : 'FAIL';
    log(`Certificate: ${badge} at ${headCommit.slice(0, 12)} — ${checks.filter(c => c.pass).length}/${checks.length} checks green.`);
    for (const c of checks) log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.check}${c.pass ? '' : ' — ' + c.detail}`);
    log('Wrote .ogma/certificate.json');
    return pass ? 0 : 1;
  } catch (e) {
    log(`ogma gate failed: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdGate, fkGrade, syllables, narrativeText, leakHits };
