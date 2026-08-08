// The Map — ogma map. Three artifacts from one Ogham, all deterministic:
//   out/map.md      the markdown overview (the out-contract slot)
//   out/map.html    the dashboard: self-contained, both themes, zero
//                   external requests (no CDN, no fonts, no fetch)
//   out/map.canvas  the canvas export (open JSON Canvas format)
// Audience-awareness is PRECOMPUTED here through the same rendersTo rule the
// renderers use — the browser toggles between three already-filtered
// payloads and never re-implements the rule. Entrance motion is transform
// only; core content is never animated from opacity 0 (a stalled compositor
// must never leave the dashboard blank).
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./schema');
const { loadOgham, narratable, factIndex } = require('./render');
const { readJson, ogmaWrite, escapeXml: esc } = require('./util');

// JSON destined for an inline <script>: forbid the sequence that would close
// the tag early ("</script>" inside a statement string).
function embedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildViews(o, cwd) {
  const modules = [];
  for (const m of o.terrain.modules) {
    const doc = o.modules.get(m.id);
    if (!doc) continue;
    const facts = Array.isArray(doc.facts) ? doc.facts : [];
    const byId = factIndex(doc);
    const features = (Array.isArray(doc.features) ? doc.features : []).map(feat => {
      const own = (Array.isArray(feat.fact_ids) ? feat.fact_ids : []).map(id => byId.get(id)).filter(Boolean);
      const factView = (audience) => own
        .filter(f => audience === 'tech' ? true : S.rendersTo(f, audience))
        .map(f => ({
          id: f.id, kind: f.kind, classification: f.classification,
          status: f.status || null, witness: S.isObject(f.witness) ? f.witness.verdict : null,
          statement: f.statement,
          receipts: (Array.isArray(f.receipts) ? f.receipts : []).map(r => `${r.file}:${r.line}`)
        }));
      return {
        id: feat.id, name: feat.name, classification: feat.classification,
        does: feat.does || null, happens: feat.happens || null, sees: feat.sees || null,
        why_not_narrated: feat.why_not_narrated || null,
        // Per audience: the PRD answer never speaks for the guides view.
        narratable: { prd: narratable(feat, byId, 'prd'), guides: narratable(feat, byId, 'guides') },
        facts: { prd: factView('prd'), tech: factView('tech'), guides: factView('guides') }
      };
    });
    modules.push({
      id: m.id, name: m.name, summary: m.summary, surface_ids: m.surface_ids,
      features, factCount: facts.length,
      worst: features.length
        ? S.worstClassification(features.map(f => f.classification).filter(c => S.CLASSIFICATIONS.includes(c)))
        : null
    });
  }
  const questions = (Array.isArray(o.ledger.questions) ? o.ledger.questions : []).map(q => ({
    id: q.id, status: q.status, question: q.question,
    receipts: (Array.isArray(q.receipts) ? q.receipts : []).map(r => `${r.file}:${r.line}`)
  }));
  // Absent, corrupt and valid are three different truths and the dashboard
  // says which one it is showing: JSON.parse-and-conflate rendered a corrupt
  // certificate as merely "not yet run".
  let certificate = null;
  const certPath = path.join(cwd, '.ogma', 'certificate.json');
  if (fs.existsSync(certPath)) {
    const certRead = readJson(certPath);
    if (certRead.error) {
      certificate = { corrupt: true };
    } else {
      const certErrors = [];
      S.validateCertificate(certRead.value, certErrors);
      if (certErrors.length) certificate = { corrupt: true };
      else {
        const cert = certRead.value;
        certificate = { pass: cert.pass === true, commit: cert.commit, checks: cert.checks.map(c => ({ check: c.check, pass: c.pass })) };
      }
    }
  }
  return {
    project: o.config.project,
    commit: o.manifest.cutoff_commit,
    generated_at: o.manifest.generated_at,
    counts: o.manifest.counts,
    surfaces: o.terrain.surfaces.map(s => ({ id: s.id, kind: s.kind, root: s.root })),
    modules, questions, certificate
  };
}

// ---------------------------------------------------------------------------

function renderMd(v) {
  const lines = [`# ${v.project} — map`, ''];
  lines.push(`Bound to \`${v.commit.slice(0, 12)}\` · ${v.counts.modules} modules · ${v.counts.features} features · ${v.counts.facts} facts · ${v.counts.ledger_open} open questions`, '');
  lines.push(`Certificate: ${
    !v.certificate ? 'not yet run'
      : v.certificate.corrupt ? 'unreadable — re-run ogma gate'
        : v.certificate.pass ? 'PASS' : 'FAIL'}`, '');
  lines.push('## Surfaces', '');
  for (const s of v.surfaces) lines.push(`- **${s.id}** (${s.kind}) — \`${s.root}\``);
  lines.push('', '## Modules', '');
  for (const m of v.modules) {
    lines.push(`- **${m.name}**${m.worst ? ` [${m.worst}]` : ''} — ${m.summary} (${m.features.length} features, ${m.factCount} facts)`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

function renderCanvas(v) {
  const nodes = [];
  const edges = [];
  const W = 320, H = 140, GAP = 40;
  v.surfaces.forEach((s, i) => {
    nodes.push({
      id: `surface-${s.id}`, type: 'text', x: i * (W + GAP), y: 0, width: W, height: 80,
      text: `**${s.id}** (${s.kind})`, color: '4'
    });
  });
  const color = { LIVE: '4', DEAD: '1', 'HALF-BUILT': '2', UNCLEAR: '3' };
  v.modules.forEach((m, i) => {
    const perRow = Math.max(1, v.surfaces.length + 1);
    const x = (i % perRow) * (W + GAP);
    const y = 160 + Math.floor(i / perRow) * (H + GAP);
    nodes.push({
      id: `module-${m.id}`, type: 'text', x, y, width: W, height: H,
      text: `**${m.name}**\n${m.summary}`, color: m.worst ? color[m.worst] : '6'
    });
    for (const sid of m.surface_ids) {
      edges.push({ id: `e-${m.id}-${sid}`, fromNode: `module-${m.id}`, fromSide: 'top', toNode: `surface-${sid}`, toSide: 'bottom' });
    }
  });
  return JSON.stringify({ nodes, edges }, null, 2) + '\n';
}

function renderHtml(v) {
  const data = embedJson(v);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.project)} — OGMA map</title>
<style>
  :root {
    --bg:#f6f4ef; --panel:#ffffff; --ink:#1b1b20; --muted:#6b6b74; --line:#e4e0d6;
    --live:#1a7f4e; --dead:#8a8a92; --half:#b07b1e; --unclear:#7a5bbd;
    --accent:#274690; --badge-pass:#1a7f4e; --badge-fail:#b3362b;
  }
  [data-theme="dark"] {
    --bg:#15151a; --panel:#1e1e26; --ink:#ececf1; --muted:#9a9aa6; --line:#2c2c36;
    --live:#4fce8f; --dead:#7d7d88; --half:#e0a84a; --unclear:#a98ae8;
    --accent:#8fb0ff; --badge-pass:#2f9e64; --badge-fail:#d15044;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,sans-serif; padding:28px clamp(16px,4vw,56px); }
  header { display:flex; flex-wrap:wrap; align-items:baseline; gap:14px 22px; margin-bottom:6px; }
  h1 { font-size:clamp(22px,3vw,32px); letter-spacing:-.02em; }
  .meta { color:var(--muted); font-size:13px; }
  .badge { font-weight:700; font-size:12px; letter-spacing:.08em; padding:3px 10px; border-radius:999px; color:#fff; }
  .badge.pass { background:var(--badge-pass); } .badge.fail { background:var(--badge-fail); } .badge.none { background:var(--dead); }
  nav { display:flex; gap:8px; margin:18px 0 22px; flex-wrap:wrap; }
  nav button { font:600 13px ui-sans-serif,system-ui; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer; }
  nav button[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:#fff; }
  #theme { margin-left:auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .card h2 { font-size:16px; display:flex; align-items:center; gap:8px; }
  .card .sum { color:var(--muted); font-size:13px; margin:6px 0 10px; }
  .chip { display:inline-block; font-size:10.5px; font-weight:700; letter-spacing:.06em; padding:1px 7px; border-radius:999px; color:#fff; vertical-align:1px; }
  .chip.LIVE { background:var(--live); } .chip.DEAD { background:var(--dead); }
  .chip.HALF-BUILT { background:var(--half); } .chip.UNCLEAR { background:var(--unclear); }
  .feat { border-top:1px solid var(--line); padding:9px 0 7px; }
  .feat b { font-size:13.5px; }
  .feat .facts { margin-top:5px; padding-left:14px; color:var(--muted); font-size:12.5px; }
  .feat .facts li { margin:3px 0; }
  .receipt { font:11px ui-monospace,monospace; color:var(--accent); }
  .stale { color:var(--half); font-weight:700; }
  section.panel { margin-top:26px; }
  section.panel h3 { font-size:14px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
  .qrow { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin-bottom:8px; font-size:13.5px; }
  .surfaces { display:flex; gap:10px; flex-wrap:wrap; }
  .surf { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px 14px; font-size:13px; }
  .empty { color:var(--muted); font-style:italic; }
  .card { transition:transform .15s ease; }
  .card:hover { transform:translateY(-2px); }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <span id="cert" class="badge none">UNCERTIFIED</span>
  <span class="meta" id="meta"></span>
</header>
<nav>
  <button data-aud="prd" aria-pressed="true">Business</button>
  <button data-aud="tech" aria-pressed="false">Engineer</button>
  <button data-aud="guides" aria-pressed="false">User</button>
  <button id="theme" aria-pressed="false">Dark</button>
</nav>
<div class="surfaces" id="surfaces"></div>
<section class="panel"><h3>Modules</h3><div class="grid" id="modules"></div></section>
<section class="panel"><h3>Open questions</h3><div id="questions"></div></section>
<script>
var DATA = ${data};
var audience = 'prd';
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function chip(c) { var s = el('span', 'chip ' + c, c); return s; }
function render() {
  document.getElementById('title').textContent = DATA.project;
  document.getElementById('meta').textContent = 'bound to ' + DATA.commit.slice(0, 12) + ' \\u00b7 ' +
    DATA.counts.modules + ' modules \\u00b7 ' + DATA.counts.features + ' features \\u00b7 ' + DATA.counts.facts + ' facts';
  var cert = document.getElementById('cert');
  if (DATA.certificate) {
    if (DATA.certificate.corrupt) {
      cert.textContent = 'CERT UNREADABLE';
      cert.className = 'badge fail';
    } else {
      cert.textContent = DATA.certificate.pass ? 'CERTIFIED' : 'GATE FAIL';
      cert.className = 'badge ' + (DATA.certificate.pass ? 'pass' : 'fail');
    }
  }
  var sroot = document.getElementById('surfaces'); sroot.replaceChildren();
  DATA.surfaces.forEach(function (s) { sroot.appendChild(el('div', 'surf', s.id + ' \\u2014 ' + s.kind)); });
  var mroot = document.getElementById('modules'); mroot.replaceChildren();
  DATA.modules.forEach(function (m) {
    var card = el('div', 'card');
    var h = el('h2', null, m.name); if (m.worst && audience === 'tech') h.appendChild(chip(m.worst));
    card.appendChild(h);
    card.appendChild(el('div', 'sum', m.summary));
    var shown = 0;
    m.features.forEach(function (f) {
      var facts = f.facts[audience];
      if (audience !== 'tech' && facts.length === 0 && !f.narratable[audience]) return;
      shown++;
      var box = el('div', 'feat');
      var b = el('b', null, f.name + ' ');
      if (audience === 'tech') b.appendChild(chip(f.classification));
      box.appendChild(b);
      if (audience === 'prd' && f.does) box.appendChild(el('div', 'sum', f.does + ' ' + (f.sees || '')));
      if (audience === 'guides' && f.does) box.appendChild(el('div', 'sum', '1. ' + f.does + '  2. ' + (f.sees || '')));
      if (audience === 'tech' && f.why_not_narrated) box.appendChild(el('div', 'sum', 'not narrated: ' + f.why_not_narrated));
      var ul = el('ul', 'facts');
      facts.forEach(function (fa) {
        var li = el('li');
        li.appendChild(document.createTextNode(fa.statement + ' '));
        if (audience === 'tech') {
          li.appendChild(chip(fa.classification));
          if (fa.status === 'stale') li.appendChild(el('span', 'stale', ' STALE'));
          li.appendChild(document.createTextNode(' '));
          li.appendChild(el('span', 'receipt', fa.receipts.join(' ')));
        }
        ul.appendChild(li);
      });
      if (facts.length) box.appendChild(ul);
      card.appendChild(box);
    });
    if (shown === 0) card.appendChild(el('div', 'empty', 'Nothing live for this audience yet.'));
    mroot.appendChild(card);
  });
  var qroot = document.getElementById('questions'); qroot.replaceChildren();
  var open = DATA.questions.filter(function (q) { return q.status === 'open'; });
  if (open.length === 0) qroot.appendChild(el('div', 'empty', 'No open questions.'));
  open.forEach(function (q) {
    var row = el('div', 'qrow', q.id + ' \\u2014 ' + q.question + ' ');
    row.appendChild(el('span', 'receipt', q.receipts.join(' ')));
    qroot.appendChild(row);
  });
}
document.querySelectorAll('nav button[data-aud]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    audience = btn.getAttribute('data-aud');
    document.querySelectorAll('nav button[data-aud]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
    render();
  });
});
var themeBtn = document.getElementById('theme');
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  themeBtn.setAttribute('aria-pressed', String(dark));
  themeBtn.textContent = dark ? 'Light' : 'Dark';
}
themeBtn.addEventListener('click', function () {
  applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
});
applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
render();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

function cmdMap(cwd, log = console.log) {
  try {
    const o = loadOgham(cwd);
    if (o.error) { log(`ogma map failed: ${o.error}`); return 1; }
    const v = buildViews(o, cwd);
    ogmaWrite(cwd, 'out/map.md', renderMd(v));
    ogmaWrite(cwd, 'out/map.html', renderHtml(v));
    const canvas = renderCanvas(v);
    JSON.parse(canvas);   // a canvas that does not parse is not written half-broken
    ogmaWrite(cwd, 'out/map.canvas', canvas);
    log(`Wrote .ogma/out/map.md, map.html (${v.modules.length} modules, 3 audience views, both themes), map.canvas`);
    return 0;
  } catch (e) {
    log(`ogma map failed: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdMap, buildViews, renderHtml, renderCanvas, renderMd };
