// The Nerves — the structural graph indexer. Parses every supported tracked
// file AT HEAD into a symbol table + call edges, then answers questions:
// where is this defined, who calls it, does a chain exist from this entry to
// that rule, what is reachable at all. Resolution is BY NAME (structural, not
// semantic) — that limit is documented in docs/ogham-schema.md and is what
// the classifier's ledger discipline exists to absorb.
//
// The parsing engine is WebAssembly (web-tree-sitter + prebuilt grammar
// wasm) — pure npm install: no compiler toolchain, no network at runtime.
// Grammars are open-library ingredients, allowed under the purity rule.
'use strict';

const fs = require('fs');
const path = require('path');
const {
  validateGraphIndex, GRAPH_VERSION, safe, MAX_ARRAY
} = require('./schema');
const { listTracked, gitShow } = require('./terrain');

// Per-file parse cap. A single source file past this is generated or hostile;
// it is skipped and COUNTED, never silently missing and never parsed.
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

// language key -> grammar package + wasm file + extensions it claims.
const GRAMMARS = {
  js:   { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm', exts: ['js', 'jsx', 'mjs', 'cjs'] },
  ts:   { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm', exts: ['ts', 'mts', 'cts'] },
  tsx:  { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm', exts: ['tsx'] },
  py:   { pkg: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm', exts: ['py'] },
  cs:   { pkg: 'tree-sitter-c-sharp', wasm: 'tree-sitter-c_sharp.wasm', exts: ['cs'] },
  go:   { pkg: 'tree-sitter-go', wasm: 'tree-sitter-go.wasm', exts: ['go'] },
  java: { pkg: 'tree-sitter-java', wasm: 'tree-sitter-java.wasm', exts: ['java'] }
};
const LANG_BY_EXT = {};
for (const [key, g] of Object.entries(GRAMMARS)) for (const e of g.exts) LANG_BY_EXT[e] = key;

// Definition node types per language family, with the symbol kind each maps
// to. Name extraction is childForFieldName('name') everywhere; the JS-family
// arrow case (const pay = () => {}) is handled separately below.
const DEF_TYPES = {
  js: {
    function_declaration: 'function', generator_function_declaration: 'function',
    class_declaration: 'class', method_definition: 'method'
  },
  ts: {
    function_declaration: 'function', generator_function_declaration: 'function',
    class_declaration: 'class', method_definition: 'method',
    interface_declaration: 'interface', enum_declaration: 'enum',
    type_alias_declaration: 'type', abstract_class_declaration: 'class'
  },
  py: { function_definition: 'function', class_definition: 'class' },
  cs: {
    method_declaration: 'method', class_declaration: 'class',
    interface_declaration: 'interface', struct_declaration: 'struct',
    enum_declaration: 'enum', constructor_declaration: 'constructor',
    property_declaration: 'property', record_declaration: 'record',
    local_function_statement: 'function'
  },
  go: { function_declaration: 'function', method_declaration: 'method', type_spec: 'type' },
  java: {
    method_declaration: 'method', class_declaration: 'class',
    interface_declaration: 'interface', enum_declaration: 'enum',
    constructor_declaration: 'constructor', record_declaration: 'record'
  }
};
DEF_TYPES.tsx = DEF_TYPES.ts;

// Call-site node types per language family.
const CALL_TYPES = {
  js: ['call_expression', 'new_expression'],
  ts: ['call_expression', 'new_expression'],
  py: ['call'],
  cs: ['invocation_expression', 'object_creation_expression'],
  go: ['call_expression'],
  java: ['method_invocation', 'object_creation_expression']
};
CALL_TYPES.tsx = CALL_TYPES.ts;

// ---------------------------------------------------------------------------
// Engine lifecycle. Loaded once per process, per language on demand.
let parserReady = null;
const languages = new Map();

async function loadLanguage(key) {
  const { Parser, Language } = require('web-tree-sitter');
  if (!parserReady) parserReady = Parser.init();
  await parserReady;
  if (!languages.has(key)) {
    const g = GRAMMARS[key];
    const wasmPath = require.resolve(`${g.pkg}/${g.wasm}`);
    languages.set(key, await Language.load(wasmPath));
  }
  const { Parser: P } = require('web-tree-sitter');
  const parser = new P();
  parser.setLanguage(languages.get(key));
  return parser;
}

// The name-ish leaf of a callee expression: `pay(...)` -> pay,
// `svc.pay(...)` -> pay, `new Payments(...)` -> Payments, `pkg.Type{}` etc.
function calleeName(node) {
  if (!node) return null;
  if (node.type.endsWith('identifier') || node.type === 'type_identifier') return node.text;
  for (const field of ['property', 'field', 'name', 'attribute', 'type', 'constructor', 'function']) {
    const child = node.childForFieldName(field);
    if (child) {
      const n = calleeName(child);
      if (n) return n;
    }
  }
  // Fall back to the last identifier-shaped named child (member chains).
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (c.type.endsWith('identifier')) return c.text;
  }
  return null;
}

// Extract symbols and calls from one parsed tree. Symbols carry 1-based
// line/end_line (receipt-compatible); calls carry the line and, after the
// containment pass, the innermost enclosing symbol they fire from.
function extractFile(root, langKey) {
  const defs = DEF_TYPES[langKey] || {};
  const callTypes = new Set(CALL_TYPES[langKey] || []);
  const symbols = [];
  const calls = [];

  (function walk(node) {
    const kind = defs[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name');
      if (nameNode && nameNode.text) {
        symbols.push({
          name: nameNode.text.slice(0, 200), kind,
          line: node.startPosition.row + 1, end_line: node.endPosition.row + 1
        });
      }
    }
    // JS/TS arrow + function-expression bindings: const pay = () => {}
    if ((langKey === 'js' || langKey === 'ts' || langKey === 'tsx') && node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      const nameNode = node.childForFieldName('name');
      if (nameNode && value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function')) {
        symbols.push({
          name: nameNode.text.slice(0, 200), kind: 'function',
          line: node.startPosition.row + 1, end_line: node.endPosition.row + 1
        });
      }
    }
    if (callTypes.has(node.type)) {
      const callee = node.childForFieldName('function') || node.childForFieldName('constructor')
        || node.childForFieldName('name') || node.childForFieldName('type') || node.namedChild(0);
      const name = calleeName(callee);
      if (name) calls.push({ name: name.slice(0, 200), line: node.startPosition.row + 1 });
      // Bare-identifier ARGUMENTS are reference edges: a route registration
      // (`app.post("/payments", payHandler)`) never calls its handler here,
      // it hands it over — and without this edge no route→handler→rule chain
      // exists to trace. A reference is a use, so it rides in `calls`.
      const args = node.childForFieldName('arguments') || node.childForFieldName('argument_list');
      if (args) {
        for (let i = 0; i < args.namedChildCount; i++) {
          const a = args.namedChild(i);
          if (a.type.endsWith('identifier') && a.text && callee !== a) {
            calls.push({ name: a.text.slice(0, 200), line: a.startPosition.row + 1 });
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  })(root);

  symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

  // Containment pass: attribute each call to the innermost symbol whose span
  // covers it, and each symbol to its innermost enclosing container.
  const innermost = (line, exceptIdx) => {
    let best = -1, bestSpan = Infinity;
    for (let i = 0; i < symbols.length; i++) {
      if (i === exceptIdx) continue;
      const s = symbols[i];
      const span = s.end_line - s.line;
      if (s.line <= line && line <= s.end_line && span < bestSpan) { best = i; bestSpan = span; }
    }
    return best;
  };
  symbols.forEach((s, i) => {
    const c = innermost(s.line, i);
    // A container must strictly contain, not merely start on the same line.
    if (c !== -1 && !(symbols[c].line === s.line && symbols[c].end_line === s.end_line)) {
      s.container = symbols[c].name;
    }
  });
  for (const call of calls) {
    const c = innermost(call.line, -1);
    call.from = c === -1 ? null : symbols[c].name;
  }
  calls.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return { symbols, calls };
}

// ---------------------------------------------------------------------------
// Index a set of files. files: [{path, size}]; readText(path) -> string|null.
// Returns { index, notes }. Deterministic: same inputs, same JSON.
async function indexTree({ entries, readText, commit } = {}) {
  const notes = [];
  const skipped = { unsupported: 0, too_large: 0, parse_failed: 0, unreadable: 0 };
  const files = [];

  const list = (Array.isArray(entries) ? entries : [])
    .filter(e => e && typeof e.path === 'string' && e.path.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const e of list) {
    const ext = e.path.slice(e.path.lastIndexOf('.') + 1).toLowerCase();
    const langKey = LANG_BY_EXT[ext];
    if (!langKey || e.path.indexOf('.') === -1) { skipped.unsupported++; continue; }
    if (Number.isFinite(e.size) && e.size > MAX_PARSE_BYTES) { skipped.too_large++; continue; }
    if (files.length >= MAX_ARRAY) { skipped.unsupported++; continue; }
    const text = typeof readText === 'function' ? readText(e.path) : null;
    if (typeof text !== 'string') { skipped.unreadable++; continue; }
    let parser, tree;
    try {
      parser = await loadLanguage(langKey);
      tree = parser.parse(text);
      const { symbols, calls } = extractFile(tree.rootNode, langKey);
      if (symbols.length > MAX_ARRAY || calls.length > MAX_ARRAY) {
        symbols.length = Math.min(symbols.length, MAX_ARRAY);
        calls.length = Math.min(calls.length, MAX_ARRAY);
        notes.push(`${safe(e.path, 120)}: symbol/call caps hit — truncated`);
      }
      files.push({ path: e.path, language: langKey, symbols, calls });
    } catch (err) {
      skipped.parse_failed++;
      notes.push(`parse failed on ${safe(e.path, 120)}: ${safe(err.message, 120)}`);
    } finally {
      if (tree && typeof tree.delete === 'function') tree.delete();
      if (parser && typeof parser.delete === 'function') parser.delete();
    }
  }
  if (list.length > MAX_ARRAY) notes.push(`file cap ${MAX_ARRAY} hit — ${list.length - MAX_ARRAY} files not indexed`);

  const index = { graph_version: GRAPH_VERSION, commit: commit || null, files, skipped };
  return { index, notes };
}

// ---------------------------------------------------------------------------
// Query layer — pure functions over a validated index. Name-based resolution.

function definitionsOf(index, name) {
  const out = [];
  for (const f of index.files) {
    for (const s of f.symbols) {
      if (s.name === name) out.push({ file: f.path, line: s.line, end_line: s.end_line, kind: s.kind, container: s.container });
    }
  }
  return out;
}

function callersOf(index, name) {
  const out = [];
  for (const f of index.files) {
    for (const c of f.calls) {
      if (c.name === name) out.push({ file: f.path, line: c.line, from: c.from });
    }
  }
  return out;
}

// Shortest call chain from one symbol NAME to another, BFS over name-resolved
// edges. Each hop carries a receipt-shaped location: the call site it was
// reached through and the definition it lands on. Returns null when no chain
// exists — a null here is the "route does not reach this rule" answer.
function trace(index, fromName, toName, maxDepth = 20) {
  if (fromName === toName) {
    const d = definitionsOf(index, fromName)[0];
    return d ? [{ symbol: fromName, file: d.file, line: d.line }] : null;
  }
  // adjacency: caller symbol name -> [{callee, file, line}], sorted for a
  // deterministic BFS. Top-level edges (from: null) belong to the '(top)'
  // node — the SAME convention reachableFrom uses, so a chain that starts at
  // a route registration is traceable, not silently absent.
  const adj = new Map();
  for (const f of index.files) {
    for (const c of f.calls) {
      const from = c.from === null || c.from === undefined ? '(top)' : c.from;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push({ callee: c.name, file: f.path, line: c.line });
    }
  }
  for (const list of adj.values()) list.sort((a, b) => a.callee.localeCompare(b.callee) || a.file.localeCompare(b.file) || a.line - b.line);

  const visited = new Set([fromName]);
  let frontier = [[{ symbol: fromName, file: null, line: null }]];
  const start = definitionsOf(index, fromName)[0];
  if (start) frontier = [[{ symbol: fromName, file: start.file, line: start.line }]];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    for (const chain of frontier) {
      const tail = chain[chain.length - 1].symbol;
      for (const edge of adj.get(tail) || []) {
        if (visited.has(edge.callee)) continue;
        visited.add(edge.callee);
        const hop = { symbol: edge.callee, file: edge.file, line: edge.line };
        const grown = [...chain, hop];
        if (edge.callee === toName) return grown;
        next.push(grown);
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  return null;
}

// Every symbol name reachable from the given entry names — the raw signal the
// Batch 3 classifier turns into LIVE/DEAD. Includes the entries themselves.
function reachableFrom(index, entryNames) {
  const adj = new Map();
  for (const f of index.files) {
    for (const c of f.calls) {
      const from = c.from === null || c.from === undefined ? '(top)' : c.from;
      if (!adj.has(from)) adj.set(from, new Set());
      adj.get(from).add(c.name);
    }
  }
  const seen = new Set();
  const queue = [];
  for (const n of Array.isArray(entryNames) ? entryNames : []) {
    if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  while (queue.length > 0) {
    const n = queue.shift();
    for (const callee of adj.get(n) || []) {
      if (!seen.has(callee)) { seen.add(callee); queue.push(callee); }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------

async function cmdGraph(cwd, log = console.log) {
  try {
    const ogham = path.join(cwd, '.ogma', 'ogham');
    if (!fs.existsSync(ogham)) {
      log('No .ogma/ogham/ here — run `ogma init` first.');
      return 1;
    }
    const { commit, entries } = listTracked(cwd);
    if (entries.length === 0) { log('HEAD has no tracked files — nothing to index.'); return 1; }

    const readText = (p) => gitShow(cwd, p, MAX_PARSE_BYTES + 1024);
    const { index, notes } = await indexTree({ entries, readText, commit });

    const errors = [];
    validateGraphIndex(index, errors);
    if (errors.length) {
      throw new Error(`indexing produced an invalid graph, refusing to write it: ${errors.slice(0, 5).join('; ')}`);
    }
    const graphDir = path.join(ogham, 'graph');
    if (!fs.existsSync(graphDir)) fs.mkdirSync(graphDir);
    fs.writeFileSync(path.join(graphDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

    const nSym = index.files.reduce((n, f) => n + f.symbols.length, 0);
    const nCall = index.files.reduce((n, f) => n + f.calls.length, 0);
    log(`Indexed HEAD (${commit.slice(0, 12)}): ${index.files.length} files, ${nSym} symbols, ${nCall} call sites.`);
    const skipTotal = Object.values(index.skipped).reduce((a, b) => a + b, 0);
    if (skipTotal > 0) {
      log(`  skipped: ${Object.entries(index.skipped).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    for (const n of notes) log(`  note: ${n}`);
    log('Wrote .ogma/ogham/graph/index.json');
    return 0;
  } catch (e) {
    log(`ogma graph failed: ${e.message}`);
    return 1;
  }
}

module.exports = {
  cmdGraph, indexTree, extractFile, loadLanguage,
  definitionsOf, callersOf, trace, reachableFrom,
  GRAMMARS, MAX_PARSE_BYTES
};
