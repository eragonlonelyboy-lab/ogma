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
    // Composition, not a single worst-of label: a module holding LIVE and DEAD
    // features says both. The worst-of rollup stays computed for the canvas
    // node color only — flattening "2 live · 1 dead" into [DEAD] on the
    // dashboard or the overview labeled living modules as corpses.
    const composition = {};
    for (const f of features) {
      if (S.CLASSIFICATIONS.includes(f.classification)) {
        composition[f.classification] = (composition[f.classification] || 0) + 1;
      }
    }
    modules.push({
      id: m.id, name: m.name, summary: m.summary, surface_ids: m.surface_ids,
      features, factCount: facts.length, composition,
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

function compText(composition) {
  return S.CLASSIFICATIONS
    .filter(c => composition && composition[c])
    .map(c => `${composition[c]} ${c.toLowerCase()}`)
    .join(' · ');
}

function renderMd(v) {
  const lines = [`# ${v.project} · map`, ''];
  lines.push(`Bound to \`${v.commit.slice(0, 12)}\` · ${v.counts.modules} modules · ${v.counts.features} features · ${v.counts.facts} facts · ${v.counts.ledger_open} open questions`, '');
  lines.push(`Certificate: ${
    !v.certificate ? 'not yet run'
      : v.certificate.corrupt ? 'unreadable · re-run ogma gate'
        : v.certificate.pass ? 'PASS' : 'FAIL'}`, '');
  lines.push('## Surfaces', '');
  for (const s of v.surfaces) lines.push(`- **${s.id}** (${s.kind}) · \`${s.root}\``);
  lines.push('', '## Modules', '');
  for (const m of v.modules) {
    const comp = compText(m.composition);
    lines.push(`- **${m.name}**${comp ? ` [${comp}]` : ''} · ${m.summary} (${m.features.length} features, ${m.factCount} facts)`);
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
<meta name="color-scheme" content="light dark">
<title>${esc(v.project)} · OGMA map</title>
<style>
  /* The Ledger Line. Every mark is a stroke cut against a stemline, the way
     the Ogham script wrote: strokes right of a vertical stem are LIVE, left
     are DEAD, diagonal across are HALF-BUILT, a notch on the line is UNCLEAR.
     A stroke that could be deleted without losing information does not ship. */
  /* Every signal is a PAIR: the bright fill paints graphics (marks, bar,
     tiles, certificate strokes — non-text, 3:1 floor) and the deeper ink
     writes text labels (4.5:1 floor). Cheer on the graphics, contrast on
     the words. */
  :root {
    --bg:#eef3fb; --panel:#ffffff; --line:#dfe6f1; --stem:#c2cddf;
    --ink:#1b1f27;
    --accent:#4f8ef7; --accent-ink:#2160d3;
    --live:#16a34a;   --live-ink:#116a34;
    --dead:#64748b;   --dead-ink:#475569;
    --half:#d97706;   --half-ink:#8a5a00;
    --unclear:#8b5cf6; --unclear-ink:#5f35c9;
    --pass:#16a34a;   --pass-ink:#116a34;
    --fail:#ef4444;   --fail-ink:#b3362b;
    --m60:66%;  /* metadata tier: the Material 60% step fails AA on this light bg; contrast outranks the ladder */
  }
  [data-theme="dark"] {
    --bg:#10141f; --panel:#171c2a; --line:#262d3f; --stem:#3d465c;
    --ink:#e9ecf3;
    --accent:#82aaff; --accent-ink:#8fb3ff;
    --live:#4ade80;   --live-ink:#5fdd92;
    --dead:#94a3b8;   --dead-ink:#a5b0c2;
    --half:#fbbf24;   --half-ink:#f3c14b;
    --unclear:#a78bfa; --unclear-ink:#bda6f7;
    --pass:#4ade80;   --pass-ink:#5fdd92;
    --fail:#f87171;   --fail-ink:#f28282;
    --m60:60%;
  }
  * { box-sizing:border-box; margin:0; }
  html { background:var(--bg); }
  body {
    background:var(--bg); color:var(--ink);
    font:15px/1.6 system-ui, sans-serif;
    max-width:1160px; margin:0 auto; padding:44px clamp(20px,4vw,40px) 60px;
  }
  header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; flex-wrap:wrap; }
  h1 { font-size:32px; font-weight:650; letter-spacing:-0.025em; line-height:1.15; }
  .controls { display:flex; gap:10px; align-items:center; }
  .seg { display:flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--panel); }
  .seg button {
    font:600 13px system-ui, sans-serif; color:color-mix(in srgb, var(--ink) 70%, transparent);
    background:transparent; border:0; padding:7px 14px; cursor:pointer;
    transition:background-color 120ms ease, color 120ms ease;
  }
  .seg button + button { border-left:1px solid var(--line); }
  .seg button[aria-pressed="true"] { color:var(--accent-ink); background:color-mix(in srgb, var(--accent) 16%, transparent); }
  .seg button:focus-visible, #theme:focus-visible { outline:2px solid var(--accent-ink); outline-offset:-2px; }
  #theme {
    font:600 13px system-ui, sans-serif; color:color-mix(in srgb, var(--ink) 70%, transparent);
    background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:7px 12px; cursor:pointer;
    transition:background-color 120ms ease, color 120ms ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .seg button:hover, #theme:hover { color:color-mix(in srgb, var(--ink) 87%, transparent); }
  }
  @media (prefers-reduced-motion: no-preference) {
    .seg button:active, #theme:active { transform:scale(0.97); transition:transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }
  }
  .cert { margin-top:18px; }
  .cert-line { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  .cert svg { display:block; }
  .verdict { font:650 13px/1 ui-monospace, Consolas, monospace; letter-spacing:.14em; }
  .verdict.pass { color:var(--pass-ink); }
  .verdict.fail { color:var(--fail-ink); }
  .verdict.none { color:color-mix(in srgb, var(--ink) var(--m60), transparent); }
  .cert-meta { font:12.5px/1.5 ui-monospace, Consolas, monospace; color:color-mix(in srgb, var(--ink) var(--m60), transparent);
               display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .cert-meta b { color:color-mix(in srgb, var(--ink) 87%, transparent); font-weight:600; }
  .cert-fails { margin-top:6px; font:12px ui-monospace, Consolas, monospace; color:var(--fail-ink); }
  .stemrule { border:0; border-top:1px solid var(--line); margin:16px 0 0; }
  .spined { position:relative; padding-left:30px; }
  .spine { position:absolute; left:7px; top:0; bottom:0; width:2px; background:var(--stem); }
  .spined section h2 { position:relative; font-size:16px; font-weight:650; letter-spacing:-0.01em; margin:30px 0 14px; }
  .spined section h2 svg.node { position:absolute; left:-30px; top:50%; transform:translateY(-50%); }
  .overview { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin:20px 0 6px; }
  .tile { background:color-mix(in srgb, var(--accent) 12%, var(--panel)); border:1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
          border-radius:12px; padding:14px 16px; text-align:left; }
  .tile .num { font:650 24px/1.2 system-ui, sans-serif; letter-spacing:-0.02em; display:block; }
  .tile .lbl { font:12.5px/1.4 system-ui, sans-serif; color:color-mix(in srgb, var(--ink) 70%, transparent); }
  .tile.warn { background:color-mix(in srgb, var(--half) 14%, var(--panel)); border-color:color-mix(in srgb, var(--half) 34%, var(--line)); cursor:pointer; font:inherit; color:inherit; }
  .tile.warn:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
  .tile.wide { grid-column:1 / -1; }
  .bar { display:flex; height:10px; border-radius:999px; overflow:hidden; background:color-mix(in srgb, var(--ink) 6%, transparent); }
  .bar i { display:block; height:100%; }
  .chips { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
  .chip { font:600 10.5px ui-monospace, Consolas, monospace; letter-spacing:.08em; padding:3px 9px; border-radius:6px; }
  .chip.LIVE { color:var(--live-ink); background:color-mix(in srgb, var(--live) 14%, var(--panel)); }
  .chip.DEAD { color:var(--dead-ink); background:color-mix(in srgb, var(--dead) 14%, var(--panel)); }
  .chip.HALF-BUILT { color:var(--half-ink); background:color-mix(in srgb, var(--half) 16%, var(--panel)); }
  .chip.UNCLEAR { color:var(--unclear-ink); background:color-mix(in srgb, var(--unclear) 14%, var(--panel)); }
  .legend { margin-top:12px; display:flex; gap:6px 18px; flex-wrap:wrap; align-items:center;
            font:12.5px system-ui, sans-serif; color:color-mix(in srgb, var(--ink) 70%, transparent); }
  .legend svg { vertical-align:-2px; margin-right:4px; }
  .legend .lt { font-weight:650; color:color-mix(in srgb, var(--ink) 87%, transparent); margin-right:2px; }
  .surfaces { display:flex; gap:14px; margin:14px 0 0; flex-wrap:wrap; }
  .surf { font:12.5px ui-monospace, Consolas, monospace; color:color-mix(in srgb, var(--ink) var(--m60), transparent); }
  .surf b { color:color-mix(in srgb, var(--ink) 87%, transparent); font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px 22px 14px; position:relative;
          box-shadow:0 1px 2px color-mix(in srgb, var(--ink) 5%, transparent); }
  .card.stemmed { padding-left:40px; }
  .featwrap { position:relative; }
  .card-stem { position:absolute; left:-20px; top:10px; bottom:8px; width:2px; background:var(--stem); }
  .card-top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .card.stemmed .card-top, .card.stemmed .sum { margin-left:-18px; }
  .card h3 { font-size:18px; font-weight:650; letter-spacing:-0.015em; }
  .tally-cap { font:11.5px ui-monospace, Consolas, monospace; color:color-mix(in srgb, var(--ink) var(--m60), transparent); white-space:nowrap; }
  .card .sum { font-size:13.5px; color:color-mix(in srgb, var(--ink) 70%, transparent); margin:6px 0 10px; }
  .feat { border-top:1px solid var(--line); padding:12px 0 10px; position:relative; }
  .feat > svg.fmark { position:absolute; left:-33px; top:16px; }
  .feat-name { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:600; color:color-mix(in srgb, var(--ink) 87%, transparent); flex-wrap:wrap; }
  .klabel { font:600 10.5px ui-monospace, Consolas, monospace; letter-spacing:.08em; padding:2px 8px; border-radius:6px; }
  .klabel.LIVE { color:var(--live-ink); background:color-mix(in srgb, var(--live) 14%, var(--panel)); }
  .klabel.DEAD { color:var(--dead-ink); background:color-mix(in srgb, var(--dead) 14%, var(--panel)); }
  .klabel.HALF-BUILT { color:var(--half-ink); background:color-mix(in srgb, var(--half) 16%, var(--panel)); }
  .klabel.UNCLEAR { color:var(--unclear-ink); background:color-mix(in srgb, var(--unclear) 14%, var(--panel)); }
  .narr { font-size:13.5px; color:color-mix(in srgb, var(--ink) 70%, transparent); margin-top:3px; }
  ul.facts { list-style:none; padding:0; margin:7px 0 0; }
  ul.facts li { display:flex; gap:8px; align-items:baseline; font-size:13.5px; color:color-mix(in srgb, var(--ink) 87%, transparent); margin:5px 0; }
  ul.facts svg { flex:none; transform:translateY(1px); }
  .receipt { font:11.5px ui-monospace, Consolas, monospace; color:var(--accent-ink); }
  .stale { color:var(--half-ink); font:600 10.5px ui-monospace, Consolas, monospace; letter-spacing:.1em; }
  ol.steps { margin:6px 0 0 18px; font-size:13.5px; color:color-mix(in srgb, var(--ink) 87%, transparent); }
  ol.steps li { margin:3px 0; }
  .empty { font-size:13.5px; color:color-mix(in srgb, var(--ink) 70%, transparent); padding:10px 0 6px; }
  .qrow { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px 16px; margin-bottom:8px;
          display:flex; gap:10px; align-items:baseline; font-size:13.5px; }
  .qrow .qid { font:600 11.5px ui-monospace, Consolas, monospace; color:color-mix(in srgb, var(--ink) var(--m60), transparent); flex:none; }
  .qrow .qtext { color:color-mix(in srgb, var(--ink) 87%, transparent); }
  footer { margin-top:34px; border-top:1px solid var(--line); padding-top:14px;
           font:12px ui-monospace, Consolas, monospace; color:color-mix(in srgb, var(--ink) var(--m60), transparent); }
  @media (max-width:720px) {
    .spined { padding-left:0; }
    .spine, .spined section h2 svg.node { display:none; }
    .card.stemmed { padding-left:22px; }
    .card-stem, .feat > svg.fmark { display:none; }
    .card.stemmed .card-top, .card.stemmed .sum { margin-left:0; }
    .featwrap { position:static; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1 id="title"></h1>
    <div class="cert"><div class="cert-line" id="certline"></div><div id="certfails"></div></div>
  </div>
  <div class="controls">
    <div class="seg" role="group" aria-label="audience">
      <button data-aud="prd" aria-pressed="true">Business</button>
      <button data-aud="tech" aria-pressed="false">Engineer</button>
      <button data-aud="guides" aria-pressed="false">User</button>
    </div>
    <button id="theme" aria-pressed="false">Dark</button>
  </div>
</header>
<hr class="stemrule">
<div class="spined">
  <div class="spine" aria-hidden="true"></div>
  <div class="overview" id="overview"></div>
  <div class="surfaces" id="surfaces"></div>
  <section><h2 id="h-modules"><svg class="node" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><line x1="1" y1="7" x2="21" y2="7" stroke="var(--stem)" stroke-width="2"/></svg>Modules</h2><div class="grid" id="modules"></div></section>
  <section><h2 id="h-questions"><svg class="node" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><line x1="1" y1="7" x2="21" y2="7" stroke="var(--stem)" stroke-width="2"/></svg>Open questions</h2><div id="questions"></div></section>
  <footer id="foot"></footer>
</div>
<script>
var DATA = ${data};
var audience = 'prd';
var CLASS_ORDER = ['LIVE', 'DEAD', 'HALF-BUILT', 'UNCLEAR'];
var SVG_NS = 'http:' + '//www.w3.org/2000/svg';
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function svgel(tag, attrs) {
  var e = document.createElementNS(SVG_NS, tag);
  for (var k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function ln(x1, y1, x2, y2, color, w) {
  return svgel('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: color, 'stroke-width': w });
}
// Plain words for every mark, surfaced as a native tooltip and in the legend.
var TIP = {
  'LIVE': 'LIVE: built and reaching users',
  'DEAD': 'DEAD: built, but nothing reaches it',
  'HALF-BUILT': 'HALF-BUILT: started and not finished',
  'UNCLEAR': 'UNCLEAR: an open question is attached'
};
function tip(svg, cls) {
  var t = svgel('title', {});
  t.textContent = TIP[cls] || cls;
  svg.appendChild(t);
  return svg;
}
// A vertical-stem mark, as on a standing stone edge: LIVE right, DEAD left,
// HALF-BUILT diagonal, UNCLEAR notch.
function vMark(cls) {
  var s = tip(svgel('svg', { 'class': 'fmark', width: 26, height: 18, viewBox: '0 0 26 18', role: 'img', 'aria-label': TIP[cls] || cls }), cls);
  s.appendChild(ln(13, 0, 13, 18, 'var(--stem)', 2));
  if (cls === 'LIVE') s.appendChild(ln(13, 9, 25, 9, 'var(--live)', 2.5));
  if (cls === 'DEAD') s.appendChild(ln(1, 9, 13, 9, 'var(--dead)', 2.5));
  if (cls === 'HALF-BUILT') s.appendChild(ln(4, 14, 22, 4, 'var(--half)', 2.5));
  if (cls === 'UNCLEAR') s.appendChild(ln(8, 9, 18, 9, 'var(--unclear)', 2.5));
  return s;
}
// The same grammar on a horizontal stem, sized as a list bullet.
function bulletMark(cls) {
  var s = tip(svgel('svg', { width: 14, height: 14, viewBox: '0 0 14 14', role: 'img', 'aria-label': TIP[cls] || cls }), cls);
  s.appendChild(ln(1, 7, 13, 7, 'var(--stem)', 1.5));
  if (cls === 'LIVE') s.appendChild(ln(7, 0.5, 7, 7, 'var(--live)', 2.5));
  if (cls === 'DEAD') s.appendChild(ln(7, 7, 7, 13.5, 'var(--dead)', 2.5));
  if (cls === 'HALF-BUILT') s.appendChild(ln(4, 11, 10, 3, 'var(--half)', 2.5));
  if (cls === 'UNCLEAR') s.appendChild(ln(7, 4, 7, 10, 'var(--unclear)', 2.5));
  return s;
}
// A count as stroke groups of five, like the aicmi. Inherits the text color.
function countStrokes(n) {
  var x = 2, marks = [];
  for (var i = 0; i < n; i++) {
    marks.push(ln(x, 2, x, 10, 'currentColor', 1.5));
    x += 4;
    if ((i + 1) % 5 === 0) x += 4;
  }
  var w = Math.max(x, 4);
  var s = svgel('svg', { width: w, height: 12, viewBox: '0 0 ' + w + ' 12', 'aria-hidden': 'true' });
  s.appendChild(ln(0, 11, w, 11, 'var(--stem)', 1.5));
  marks.forEach(function (m) { s.appendChild(m); });
  return s;
}
function compText(counts, liveOnly) {
  var parts = [];
  CLASS_ORDER.forEach(function (c) {
    if (!counts[c]) return;
    if (liveOnly && c !== 'LIVE') return;
    parts.push(counts[c] + ' ' + c.toLowerCase());
  });
  return parts.join(' \\u00b7 ');
}
function renderCert() {
  var root = document.getElementById('certline'); root.replaceChildren();
  var fails = document.getElementById('certfails'); fails.replaceChildren();
  var cert = DATA.certificate;
  var checks = (cert && !cert.corrupt && Array.isArray(cert.checks)) ? cert.checks : [];
  if (checks.length) {
    var x = 10, lines = [], names = [];
    checks.forEach(function (c, i) {
      var t = svgel('title', {});
      t.textContent = c.check + (c.pass ? '' : ': FAIL');
      var stroke = c.pass ? ln(x, 2, x, 22, 'var(--pass)', 2.5) : ln(x - 4, 19, x + 4, 5, 'var(--fail)', 2.5);
      stroke.appendChild(t);
      lines.push(stroke);
      if (!c.pass) names.push(c.check);
      x += 10;
      if ((i + 1) % 5 === 0) x += 20;
    });
    var w = x + 20;
    var svg = svgel('svg', { width: w, height: 24, viewBox: '0 0 ' + w + ' 24', role: 'img',
      'aria-label': (checks.length - names.length) + ' of ' + checks.length + ' checks passed' });
    svg.appendChild(ln(0, 12, w, 12, 'var(--stem)', 2));
    lines.forEach(function (l) { svg.appendChild(l); });
    root.appendChild(svg);
    root.appendChild(el('span', 'verdict ' + (cert.pass ? 'pass' : 'fail'), cert.pass ? 'CERTIFIED' : 'GATE FAIL'));
    if (names.length) fails.appendChild(el('div', 'cert-fails', 'failing: ' + names.join(' \\u00b7 ')));
  } else if (cert && cert.corrupt) {
    root.appendChild(el('span', 'verdict fail', 'CERT UNREADABLE'));
  } else {
    root.appendChild(el('span', 'verdict none', 'UNCERTIFIED'));
  }
  var meta = el('span', 'cert-meta');
  var passCount = checks.filter(function (c) { return c.pass; }).length;
  if (checks.length) meta.appendChild(document.createTextNode(passCount + ' of ' + checks.length + ' checks \\u00b7 '));
  else if (cert && cert.corrupt) meta.appendChild(document.createTextNode('re-run ogma gate \\u00b7 '));
  else meta.appendChild(document.createTextNode('not yet run \\u00b7 '));
  meta.appendChild(document.createTextNode('bound to '));
  meta.appendChild(el('b', null, DATA.commit.slice(0, 12)));
  [[DATA.counts.modules, 'modules'], [DATA.counts.features, 'features'], [DATA.counts.facts, 'facts']].forEach(function (p) {
    meta.appendChild(document.createTextNode(' \\u00b7 '));
    if (p[0] > 0 && p[0] <= 30) meta.appendChild(countStrokes(p[0]));
    meta.appendChild(document.createTextNode(' ' + p[0] + ' ' + p[1]));
  });
  root.appendChild(meta);
}
// The overview band: counts at a glance, one composition bar across every
// feature, and the legend that teaches the stroke grammar. All of it is data.
function renderOverview() {
  var root = document.getElementById('overview'); root.replaceChildren();
  var totals = {};
  DATA.modules.forEach(function (m) {
    CLASS_ORDER.forEach(function (c) { totals[c] = (totals[c] || 0) + ((m.composition || {})[c] || 0); });
  });
  var featureTotal = CLASS_ORDER.reduce(function (n, c) { return n + (totals[c] || 0); }, 0);
  var openCount = DATA.questions.filter(function (q) { return q.status === 'open'; }).length;
  [[DATA.counts.modules, 'modules'], [DATA.counts.features, 'features'], [DATA.counts.facts, 'verified facts']].forEach(function (p) {
    var t = el('div', 'tile');
    t.appendChild(el('span', 'num', String(p[0])));
    t.appendChild(el('span', 'lbl', p[1]));
    root.appendChild(t);
  });
  var q = el('button', 'tile warn');
  q.setAttribute('type', 'button');
  q.appendChild(el('span', 'num', String(openCount)));
  q.appendChild(el('span', 'lbl', 'open questions \\u00b7 jump to list'));
  q.addEventListener('click', function () { document.getElementById('h-questions').scrollIntoView(); });
  root.appendChild(q);
  var wide = el('div', 'tile wide');
  if (featureTotal > 0) {
    var bar = el('div', 'bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', CLASS_ORDER.map(function (c) { return (totals[c] || 0) + ' ' + c.toLowerCase(); }).join(', '));
    var colors = { 'LIVE': 'var(--live)', 'DEAD': 'var(--dead)', 'HALF-BUILT': 'var(--half)', 'UNCLEAR': 'var(--unclear)' };
    CLASS_ORDER.forEach(function (c) {
      if (!totals[c]) return;
      var seg = el('i');
      seg.style.width = (100 * totals[c] / featureTotal) + '%';
      seg.style.background = colors[c];
      var t = el('span'); t.title = TIP[c]; seg.appendChild(t);
      bar.appendChild(seg);
    });
    wide.appendChild(bar);
    var chips = el('div', 'chips');
    CLASS_ORDER.forEach(function (c) {
      if (!totals[c]) return;
      var chip = el('span', 'chip ' + c, totals[c] + ' ' + c);
      chip.title = TIP[c];
      chips.appendChild(chip);
    });
    wide.appendChild(chips);
  }
  var legend = el('div', 'legend');
  legend.appendChild(el('span', 'lt', 'Reading the marks:'));
  CLASS_ORDER.forEach(function (c) {
    var item = el('span');
    item.appendChild(bulletMark(c));
    item.appendChild(document.createTextNode(TIP[c].split(': ')[1]));
    item.title = TIP[c];
    legend.appendChild(item);
  });
  wide.appendChild(legend);
  root.appendChild(wide);
}
function render() {
  document.getElementById('title').textContent = DATA.project;
  renderOverview();
  var sroot = document.getElementById('surfaces'); sroot.replaceChildren();
  DATA.surfaces.forEach(function (s) {
    var span = el('span', 'surf');
    span.appendChild(el('b', null, s.id));
    span.appendChild(document.createTextNode(' \\u00b7 ' + s.kind));
    sroot.appendChild(span);
  });
  var mroot = document.getElementById('modules'); mroot.replaceChildren();
  var tech = audience === 'tech';
  DATA.modules.forEach(function (m) {
    var card = el('div', tech ? 'card stemmed' : 'card');
    var top = el('div', 'card-top');
    top.appendChild(el('h3', null, m.name));
    // Honest States: the engineer sees the whole composition; business and
    // user views only ever carry LIVE content, so their caption counts only it.
    var cap = compText(m.composition || {}, !tech);
    if (cap) top.appendChild(el('span', 'tally-cap', cap));
    card.appendChild(top);
    card.appendChild(el('div', 'sum', m.summary));
    var wrap = el('div', 'featwrap');
    if (tech) {
      var stem = el('div', 'card-stem');
      stem.setAttribute('aria-hidden', 'true');
      wrap.appendChild(stem);
    }
    var shown = 0;
    m.features.forEach(function (f) {
      var facts = f.facts[audience];
      if (audience !== 'tech' && facts.length === 0 && !f.narratable[audience]) return;
      shown++;
      var box = el('div', 'feat');
      if (tech) box.appendChild(vMark(f.classification));
      var head = el('div', 'feat-name');
      head.appendChild(document.createTextNode(f.name));
      if (tech) head.appendChild(el('span', 'klabel ' + f.classification, f.classification));
      box.appendChild(head);
      if (audience === 'prd' && f.does) box.appendChild(el('div', 'narr', f.does + ' ' + (f.sees || '')));
      if (audience === 'guides' && f.does) {
        var olist = el('ol', 'steps');
        olist.appendChild(el('li', null, f.does));
        if (f.sees) olist.appendChild(el('li', null, f.sees));
        box.appendChild(olist);
      }
      if (tech && f.why_not_narrated) box.appendChild(el('div', 'narr', 'Not narrated: ' + f.why_not_narrated));
      if (facts.length) {
        var ul = el('ul', 'facts');
        facts.forEach(function (fa) {
          var li = el('li');
          li.appendChild(bulletMark(fa.classification));
          var span = el('span', null, fa.statement + ' ');
          if (tech) {
            span.appendChild(el('span', 'klabel ' + fa.classification, fa.classification));
            if (fa.status === 'stale') span.appendChild(el('span', 'stale', ' STALE'));
            span.appendChild(document.createTextNode(' '));
            span.appendChild(el('span', 'receipt', fa.receipts.join(' ')));
          }
          li.appendChild(span);
          ul.appendChild(li);
        });
        box.appendChild(ul);
      }
      wrap.appendChild(box);
    });
    if (shown === 0) {
      var msg = tech ? 'No features mapped yet.' : 'Nothing here is live for this audience yet.';
      var box0 = el('div', 'feat');
      box0.appendChild(el('div', 'empty', msg));
      wrap.appendChild(box0);
    }
    card.appendChild(wrap);
    mroot.appendChild(card);
  });
  var qroot = document.getElementById('questions'); qroot.replaceChildren();
  var open = DATA.questions.filter(function (q) { return q.status === 'open'; });
  if (open.length === 0) qroot.appendChild(el('div', 'empty', 'No open questions.'));
  open.forEach(function (q) {
    var row = el('div', 'qrow');
    row.appendChild(bulletMark('UNCLEAR'));
    row.appendChild(el('span', 'qid', q.id));
    var text = el('span', 'qtext', q.question + ' ');
    text.appendChild(el('span', 'receipt', q.receipts.join(' ')));
    row.appendChild(text);
    qroot.appendChild(row);
  });
  document.getElementById('foot').textContent =
    'ogma map \\u00b7 rendered from the Ogham at ' + DATA.commit.slice(0, 12) +
    ' \\u00b7 ' + String(DATA.generated_at).slice(0, 10);
}
document.querySelectorAll('.seg button[data-aud]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    audience = btn.getAttribute('data-aud');
    document.querySelectorAll('.seg button[data-aud]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
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
renderCert();
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
