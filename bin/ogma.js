#!/usr/bin/env node
// OGMA — One Graph, Many Audiences.
// Deterministic CLI. No model calls happen here, ever: the CLI scaffolds,
// validates, and (from Batch 5) certifies. Reading and writing prose is the
// skill layer's job; proving it is this binary's job.
'use strict';

const { OGHAM_VERSION } = require('../lib/schema');
const { cmdInit } = require('../lib/init');

const VERSION = require('../package.json').version;

// Command table: doubles as the build-status board. A power without a handler
// is not built; it says so and exits 1 — it never pretends. "Built but
// unwired" is structurally impossible: built means handler present.
const POWERS = [
  { cmd: 'init',      batch: 0, handler: cmdInit, desc: 'Scaffold .ogma/ in the current project (config + Ogham skeleton)' },
  { cmd: 'ingest',    batch: 3, desc: 'Read the codebase into the Ogham (terrain -> graph -> sweeps -> witnessed facts)' },
  { cmd: 'map',       batch: 6, desc: 'Render the dashboard + canvas from the Ogham' },
  { cmd: 'explain',   batch: 4, desc: 'Render implementation notes for engineers' },
  { cmd: 'prd',       batch: 4, desc: 'Render the feature-first PRD for business readers' },
  { cmd: 'guides',    batch: 4, desc: 'Render click-by-click user guides per surface' },
  { cmd: 'questions', batch: 4, desc: 'Show the open-questions ledger' },
  { cmd: 'watch',     batch: 7, desc: 'Diff new commits, invalidate receipts, refresh only stale facts' },
  { cmd: 'push',      batch: 7, desc: 'Deliver rendered artifacts to the configured destination' },
  { cmd: 'gate',      batch: 5, desc: 'Run the nine checks and emit the certificate' },
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
  out('Docs: docs/ogham-schema.md defines the model. In-development build: only init works.');
}

function main(argv) {
  const cmd = argv[2];
  const rest = argv.slice(3);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { printHelp(console.log); return 0; }
  if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return 0; }

  const power = POWERS.find(p => p.cmd === cmd);
  if (!power) {
    console.error(`Unknown command: ${cmd}`);
    printHelp(console.error);
    return 1;
  }
  if (rest.length > 0) {
    console.error(`ogma ${cmd}: unrecognized arguments: ${rest.join(' ')}`);
    console.error('No command takes arguments yet; refusing rather than silently ignoring them.');
    return 1;
  }
  if (!power.handler) {
    console.error(`ogma ${cmd}: not built yet — arrives in batch ${power.batch}.`);
    console.error('OGMA ships complete; unbuilt powers refuse to pretend.');
    return 1;
  }
  return power.handler(process.cwd());
}

// exitCode, not process.exit: exit() discards queued stdout on pipes.
process.exitCode = main(process.argv);
