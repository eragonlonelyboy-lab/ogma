// The Voices — renderers. Deterministic assembly of the prose the skill layer
// authored at ingest: the PRD, the tech notes, the guides and the ledger all
// retell the SAME fields from the SAME facts, which is what "cannot disagree"
// means mechanically. Renderers read ONLY the Ogham — never the repo, never
// git; if a renderer needs something the Ogham lacks, the fix is in ingest
// (non-negotiable 5). This file must never import child_process.
//
// The fact-ID annotation (pinned here, parsed by the gate):
//   <!-- fact:FACT-x -->   at the end of a claim line
//   <!-- feature:FEAT-x --> at the end of a feature heading
// One regex, ANNOTATION_RX, is the whole syntax. Invisible in rendered
// markdown; the leak lint and the readability check strip annotations before
// scanning (stripAnnotations is the one implementation of that).
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./schema');

const ANNOTATION_RX = /<!-- (fact|feature):([A-Za-z0-9-]+) -->/g;

function annotate(kind, id) { return `<!-- ${kind}:${id} -->`; }

function stripAnnotations(text) {
  return String(text).replace(ANNOTATION_RX, '').replace(/[ \t]+$/gm, '');
}

function parseAnnotations(text) {
  const out = [];
  for (const m of String(text).matchAll(ANNOTATION_RX)) out.push({ kind: m[1], id: m[2] });
  return out;
}

// ---------------------------------------------------------------------------

const { readJson, ogmaWrite } = require('./util');

// Load and re-validate the whole Ogham. Renderers require a manifest — proof
// that `ogma ingest` has passed at least once; rendering an unchecked Ogham
// would put unverified claims in front of the least-equipped readers.
function loadOgham(cwd) {
  const ogham = path.join(cwd, '.ogma', 'ogham');
  if (!fs.existsSync(path.join(ogham, 'manifest.json'))) {
    return { error: 'no ogham/manifest.json — run `ogma ingest` (a read must pass its checks before anything renders)' };
  }
  const errors = [];
  const config = readJson(path.join(cwd, '.ogma', 'config.json'));
  if (config.error) return { error: `config.json unreadable: ${S.safe(config.error, 120)}` };
  S.validateConfig(config.value, errors);
  const manifest = readJson(path.join(ogham, 'manifest.json'));
  if (manifest.error) return { error: `manifest.json unreadable: ${S.safe(manifest.error, 120)}` };
  S.validateManifest(manifest.value, errors);
  const terrain = readJson(path.join(ogham, 'terrain.json'));
  if (terrain.error) return { error: `terrain.json unreadable: ${S.safe(terrain.error, 120)}` };
  S.validateTerrain(terrain.value, errors);
  const ledger = readJson(path.join(ogham, 'ledger.json'));
  if (ledger.error) return { error: `ledger.json unreadable: ${S.safe(ledger.error, 120)}` };
  S.validateLedgerFile(ledger.value, errors);

  const modules = new Map();
  const factsDir = path.join(ogham, 'facts');
  if (fs.existsSync(factsDir)) {
    for (const f of fs.readdirSync(factsDir).filter(x => x.endsWith('.json')).sort()) {
      const doc = readJson(path.join(factsDir, f));
      if (doc.error) return { error: `facts/${f} unreadable: ${S.safe(doc.error, 120)}` };
      S.validateModuleFile(doc.value, errors);
      if (doc.value && typeof doc.value.module === 'string') modules.set(doc.value.module, doc.value);
    }
  }
  if (errors.length) {
    return { error: `the Ogham does not validate (${errors.length} finding(s); run \`ogma ingest\`): ${errors.slice(0, 3).join('; ')}` };
  }
  return {
    config: config.value, manifest: manifest.value, terrain: terrain.value,
    ledger: ledger.value, modules
  };
}

function writeDoc(cwd, rel, content) {
  ogmaWrite(cwd, `out/${rel}`, content);   // symlink-guarded at every component
}

// A feature narrates to business/guide readers when at least one of its facts
// renders there — the SAME rendersTo rule facts use, never a re-statement.
function narratable(feature, factById, audience) {
  return (Array.isArray(feature.fact_ids) ? feature.fact_ids : [])
    .some(id => factById.has(id) && S.rendersTo(factById.get(id), audience));
}

function factIndex(doc) {
  return new Map((Array.isArray(doc.facts) ? doc.facts : []).map(f => [f.id, f]));
}

function receiptRef(r) {
  const span = r.end_line !== undefined && r.end_line !== r.line ? `-${r.end_line}` : '';
  return `\`${r.file}:${r.line}${span}\` (${r.symbol})`;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Builders — pure functions from a validated Ogham to document content.
// The commands write what the builders produce; the gate REBUILDS through the
// same functions and byte-compares against .ogma/out/, which is what binds
// rendered prose to fact content and status: a document rendered before a
// fact changed, went stale, or was demoted can no longer certify.

function buildPrd(o) {
  const lines = [`# ${o.config.project} — what the product does`, ''];
  lines.push(`_Current as of commit ${o.manifest.cutoff_commit.slice(0, 12)}. Every claim in this document traces to verified code; open questions live in questions.md._`, '');
  for (const m of o.terrain.modules) {
    const doc = o.modules.get(m.id);
    if (!doc) continue;
    lines.push(`## ${m.name}`, '', m.summary, '');
    const byId = factIndex(doc);
    const features = (Array.isArray(doc.features) ? doc.features : []);
    const shown = features.filter(f => narratable(f, byId, 'prd'));
    if (shown.length === 0) {
      lines.push('_Nothing here is live for users yet._', '');
      continue;
    }
    for (const feat of shown) {
      lines.push(`### ${feat.name} ${annotate('feature', feat.id)}`, '');
      lines.push(`- **What you do:** ${feat.does}`);
      lines.push(`- **What happens:** ${feat.happens}`);
      lines.push(`- **What you see:** ${feat.sees}`);
      const rules = feat.fact_ids
        .map(id => byId.get(id))
        .filter(f => f && S.rendersTo(f, 'prd') && (f.kind === 'rule' || f.kind === 'limit'));
      if (rules.length > 0) {
        lines.push('', 'Rules that apply:');
        for (const f of rules) lines.push(`- ${f.statement} ${annotate('fact', f.id)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function buildTech(o) {
  const docs = [];   // { rel, content }
  for (const m of o.terrain.modules) {
    const doc = o.modules.get(m.id);
    if (!doc) continue;
    const byId = factIndex(doc);
    const lines = [`# ${m.name} — implementation notes`, ''];
    lines.push(`Roots: ${m.roots.map(r => `\`${r}\``).join(', ')}. ${m.summary}`, '');
    const features = Array.isArray(doc.features) ? doc.features : [];
    if (features.length === 0) {
      lines.push(`_No features. Reason: ${doc.empty_reason || 'not recorded'}_`, '');
    }
    for (const feat of features) {
      lines.push(`## ${feat.name} — ${feat.classification} ${annotate('feature', feat.id)}`, '');
      for (const id of feat.fact_ids) {
        const f = byId.get(id);
        if (!f) continue;
        const stale = f.status === 'stale' ? ' **[STALE — unverified since the code moved]**' : '';
        const witness = S.isObject(f.witness) ? f.witness.verdict : 'NONE';
        lines.push(`- **${f.classification}** (${f.kind}, witness ${witness})${stale}: ${f.statement} ${annotate('fact', f.id)}`);
        for (const r of Array.isArray(f.receipts) ? f.receipts : []) lines.push(`  - receipt: ${receiptRef(r)}`);
        if (S.isObject(f.path)) {
          const chain = f.path.chain.map(h => h.hop).join(' → ');
          lines.push(`  - path: ${f.path.entry} → ${chain} → ${f.path.exit}`);
        }
        for (const q of Array.isArray(f.ledger_refs) ? f.ledger_refs : []) lines.push(`  - open question: ${q}`);
      }
      lines.push('');
    }
    docs.push({ rel: `tech/${m.id}.md`, content: lines.join('\n') + '\n' });
  }
  return docs;
}

function buildGuides(o) {
  const docs = [];   // { rel, content }
  for (const s of o.terrain.surfaces) {
    if (!S.INTERACTIVE_SURFACE_KINDS.includes(s.kind)) continue;   // workers/services have no user to guide
    const lines = [`# Using ${s.id}`, ''];
    let any = false;
    for (const m of o.terrain.modules.filter(m => m.surface_ids.includes(s.id))) {
      const doc = o.modules.get(m.id);
      if (!doc) continue;
      const byId = factIndex(doc);
      for (const feat of (Array.isArray(doc.features) ? doc.features : []).filter(f => narratable(f, byId, 'guides'))) {
        any = true;
        lines.push(`## ${feat.name} ${annotate('feature', feat.id)}`, '');
        lines.push(`1. ${feat.does}`);
        lines.push(`2. ${feat.sees}`, '');
        const rules = feat.fact_ids
          .map(id => byId.get(id))
          .filter(f => f && S.rendersTo(f, 'guides') && (f.kind === 'rule' || f.kind === 'limit'));
        if (rules.length > 0) {
          lines.push('Good to know:');
          for (const f of rules) lines.push(`- ${f.statement} ${annotate('fact', f.id)}`);
          lines.push('');
        }
      }
    }
    if (!any) lines.push('_Nothing is live on this surface yet._', '');
    docs.push({ rel: `guides/${s.id}.md`, content: lines.join('\n') + '\n' });
  }
  return docs;
}

function buildQuestions(o) {
  const qs = Array.isArray(o.ledger.questions) ? o.ledger.questions : [];
  const lines = [`# Open questions — ${o.config.project}`, ''];
  lines.push('_Ambiguity is filed here with an ID, never papered over. Every question cites the code that raised it._', '');
  const open = qs.filter(q => q.status === 'open');
  const closed = qs.filter(q => q.status !== 'open');
  for (const [label, list] of [['Open', open], ['Resolved', closed]]) {
    if (list.length === 0) continue;
    lines.push(`## ${label}`, '');
    for (const q of list) {
      const ctx = q.classification_context ? ` (${q.classification_context})` : '';
      lines.push(`- **${q.id}**${ctx} [${q.status}]: ${q.question}`);
      for (const r of q.receipts) lines.push(`  - raised by: ${receiptRef(r)}`);
    }
    lines.push('');
  }
  if (qs.length === 0) lines.push('_No questions on file._', '');
  return { content: lines.join('\n') + '\n', open: open.length, closed: closed.length };
}

// Every renderer-owned document the current config + terrain call for, as
// rel -> content. This is outDocuments minus map.md (the map is a view over
// the certificate, built by lib/map.js, and is not itself certified).
function buildDocuments(o) {
  const docs = new Map();
  docs.set('questions.md', buildQuestions(o).content);
  if (o.config.audiences.prd === true) docs.set('prd.md', buildPrd(o));
  if (o.config.audiences.tech === true) for (const d of buildTech(o)) docs.set(d.rel, d.content);
  if (o.config.audiences.guides === true) for (const d of buildGuides(o)) docs.set(d.rel, d.content);
  return docs;
}

// ---------------------------------------------------------------------------
// Commands — load, build, write.

function cmdPrd(cwd, log = console.log) {
  try {
    const o = loadOgham(cwd);
    if (o.error) { log(`ogma prd failed: ${o.error}`); return 1; }
    if (o.config.audiences.prd !== true) { log('ogma prd: the prd audience is disabled in config.json.'); return 1; }
    writeDoc(cwd, 'prd.md', buildPrd(o));
    log('Wrote .ogma/out/prd.md');
    return 0;
  } catch (e) {
    log(`ogma prd failed: ${e.message}`);
    return 1;
  }
}

function cmdExplain(cwd, log = console.log) {
  try {
    const o = loadOgham(cwd);
    if (o.error) { log(`ogma explain failed: ${o.error}`); return 1; }
    if (o.config.audiences.tech !== true) { log('ogma explain: the tech audience is disabled in config.json.'); return 1; }
    const docs = buildTech(o);
    for (const d of docs) writeDoc(cwd, d.rel, d.content);
    log(`Wrote ${docs.length} module note(s) under .ogma/out/tech/`);
    return 0;
  } catch (e) {
    log(`ogma explain failed: ${e.message}`);
    return 1;
  }
}

function cmdGuides(cwd, log = console.log) {
  try {
    const o = loadOgham(cwd);
    if (o.error) { log(`ogma guides failed: ${o.error}`); return 1; }
    if (o.config.audiences.guides !== true) { log('ogma guides: the guides audience is disabled in config.json.'); return 1; }
    const docs = buildGuides(o);
    for (const d of docs) writeDoc(cwd, d.rel, d.content);
    log(`Wrote ${docs.length} guide(s) under .ogma/out/guides/`);
    return 0;
  } catch (e) {
    log(`ogma guides failed: ${e.message}`);
    return 1;
  }
}

function cmdQuestions(cwd, log = console.log) {
  try {
    const o = loadOgham(cwd);
    if (o.error) { log(`ogma questions failed: ${o.error}`); return 1; }
    const q = buildQuestions(o);
    writeDoc(cwd, 'questions.md', q.content);
    log(`Wrote .ogma/out/questions.md (${q.open} open, ${q.closed} resolved)`);
    return 0;
  } catch (e) {
    log(`ogma questions failed: ${e.message}`);
    return 1;
  }
}

module.exports = {
  cmdPrd, cmdExplain, cmdGuides, cmdQuestions,
  buildPrd, buildTech, buildGuides, buildQuestions, buildDocuments,
  loadOgham, stripAnnotations, parseAnnotations, ANNOTATION_RX
};
