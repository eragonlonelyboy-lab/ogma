#!/usr/bin/env node
// OGMA — One Graph, Many Audiences.
// Deterministic CLI. No model calls happen here, ever: the CLI scaffolds,
// validates, and (from Batch 5) certifies. Reading and writing prose is the
// skill layer's job; proving it is this binary's job.
'use strict';

const { OGHAM_VERSION, safe } = require('../lib/schema');
const { cmdInit } = require('../lib/init');
const { cmdTerrain } = require('../lib/terrain');
const { cmdGraph } = require('../lib/graph');
const { cmdIngest } = require('../lib/ingest');
const { cmdPrd, cmdExplain, cmdGuides, cmdQuestions } = require('../lib/render');
const { cmdGate } = require('../lib/gate');
const { cmdMap } = require('../lib/map');
const { cmdWatch } = require('../lib/watch');
const { cmdPush } = require('../lib/push');

const VERSION = require('../package.json').version;

// Command table: doubles as the build-status board. A power without a handler
// is not built; it says so and exits 1 — it never pretends. "Built but
// unwired" is structurally impossible: built means handler present.
const POWERS = [
  { cmd: 'init',      batch: 0, handler: cmdInit, desc: 'Scaffold .ogma/ in the current project (config + Ogham skeleton)' },
  { cmd: 'terrain',   batch: 1, handler: cmdTerrain, desc: 'Scan the repo at HEAD: surfaces, entry points, module candidates, language stats' },
  { cmd: 'graph',     batch: 2, handler: cmdGraph, desc: 'Index the repo at HEAD: symbol table + call sites (graph/index.json)' },
  { cmd: 'ingest',    batch: 3, handler: cmdIngest, desc: 'Check a completed read: schemas, facts<->terrain, receipts, witness binding; writes the manifest' },
  { cmd: 'map',       batch: 6, handler: cmdMap, desc: 'Render the dashboard (map.html, both themes) + map.md + canvas export' },
  { cmd: 'explain',   batch: 4, handler: cmdExplain, desc: 'Render implementation notes for engineers' },
  { cmd: 'prd',       batch: 4, handler: cmdPrd, desc: 'Render the feature-first PRD for business readers' },
  { cmd: 'guides',    batch: 4, handler: cmdGuides, desc: 'Render click-by-click user guides per surface' },
  { cmd: 'questions', batch: 4, handler: cmdQuestions, desc: 'Render the open-questions ledger' },
  { cmd: 'watch',     batch: 7, handler: cmdWatch, desc: 'Diff new commits against the Ogham, mark only touched facts stale, advance the manifest' },
  { cmd: 'push',      batch: 7, handler: (cwd, rest) => cmdPush(cwd, rest), takesArgs: true,
    desc: 'Deliver the certified fleet to the chosen destination (--to <kind> records the ask-once choice)' },
  { cmd: 'gate',      batch: 5, handler: cmdGate, desc: 'Run the nine checks and emit the certificate' },
  { cmd: 'version',   batch: 0, handler: () => { console.log(VERSION); return 0; }, desc: 'Print the version' }
];

function printHelp(out) {
  out(`OGMA v${VERSION} — One Graph, Many Audiences (Ogham schema v${OGHAM_VERSION})`);
  out('Reads a codebase once into a receipt-backed, witness-checked model, renders');
  out('it per audience, and certifies every output with a deterministic gate.');
  out('');
  out('Usage: ogma <command>');
  out('');
  const pad = Math.max(...POWERS.map(p => p.cmd.length)) + 2;
  for (const p of POWERS) {
    const status = p.handler ? '' : `  [not built yet — arrives in batch ${p.batch}]`;
    out(`  ${p.cmd.padEnd(pad)}${p.desc}${status}`);
  }
  out('');
  out('Docs: docs/ogham-schema.md defines the model. In-development build: unbuilt powers say so and exit 1.');
}

function main(argv) {
  const cmd = argv[2];
  const rest = argv.slice(3);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { printHelp(console.log); return 0; }
  if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return 0; }

  const power = POWERS.find(p => p.cmd === cmd);
  if (!power) {
    // argv is attacker-adjacent text (a script, a copy-paste): control bytes
    // in it must never reach the terminal raw — safe() strips them.
    console.error(`Unknown command: ${safe(cmd, 60)}`);
    printHelp(console.error);
    return 1;
  }
  if (rest.length > 0 && !power.takesArgs) {
    console.error(`ogma ${cmd}: unrecognized arguments: ${rest.map(a => safe(a, 60)).join(' ')}`);
    console.error('This command takes no arguments; refusing rather than silently ignoring them.');
    return 1;
  }
  if (!power.handler) {
    console.error(`ogma ${cmd}: not built yet — arrives in batch ${power.batch}.`);
    console.error('OGMA ships complete; unbuilt powers refuse to pretend.');
    return 1;
  }
  // Handlers keep their (cwd, log) signature; only arg-taking powers get rest.
  return power.takesArgs ? power.handler(process.cwd(), rest) : power.handler(process.cwd());
}

// exitCode, not process.exit: exit() discards queued stdout on pipes.
// A handler may be async (the graph indexer's engine loads WebAssembly);
// a rejected promise is a defect surfaced honestly, never a silent 0.
const result = main(process.argv);
if (result && typeof result.then === 'function') {
  result.then(
    code => { process.exitCode = code; },
    err => { console.error(`ogma failed: ${err.message}`); process.exitCode = 1; }
  );
} else {
  process.exitCode = result;
}
