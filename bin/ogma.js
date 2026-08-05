#!/usr/bin/env node
// OGMA — One Graph, Many Audiences.
// Deterministic CLI. No model calls happen here, ever: the CLI scaffolds,
// validates, and (from Batch 5) certifies. Reading and writing prose is the
// skill layer's job; proving it is this binary's job.
'use strict';

const fs = require('fs');
const path = require('path');
const { defaultConfig, validateConfig, OGHAM_VERSION } = require('../lib/schema');

const VERSION = require('../package.json').version;

// Build status per power. A command that is not built yet says so and exits 1 —
// it never pretends. Statuses flip as batches land.
const POWERS = [
  { cmd: 'init',      batch: 0, built: true,  desc: 'Scaffold .ogma/ in the current project (config + Ogham skeleton)' },
  { cmd: 'ingest',    batch: 3, built: false, desc: 'Read the codebase into the Ogham (terrain -> graph -> sweeps -> facts with receipts)' },
  { cmd: 'map',       batch: 6, built: false, desc: 'Render the dashboard + canvas from the Ogham' },
  { cmd: 'explain',   batch: 4, built: false, desc: 'Render implementation notes for engineers' },
  { cmd: 'prd',       batch: 4, built: false, desc: 'Render the feature-first PRD for business readers' },
  { cmd: 'guides',    batch: 4, built: false, desc: 'Render click-by-click user guides per surface' },
  { cmd: 'questions', batch: 4, built: false, desc: 'Show the open-questions ledger' },
  { cmd: 'watch',     batch: 7, built: false, desc: 'Diff new commits, invalidate receipts, refresh only stale facts' },
  { cmd: 'push',      batch: 7, built: false, desc: 'Deliver rendered artifacts to the configured destination' },
  { cmd: 'gate',      batch: 5, built: false, desc: 'Run the seven checks and emit the certificate' }
];

function findOgmaDir(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, '.ogma');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function printHelp() {
  console.log(`OGMA v${VERSION} — One Graph, Many Audiences (Ogham schema v${OGHAM_VERSION})`);
  console.log('Reads a codebase once into a receipt-backed model, renders it per audience,');
  console.log('and certifies every output with a deterministic gate.\n');
  console.log('Usage: ogma <command> [options]\n');
  const pad = Math.max(...POWERS.map(p => p.cmd.length)) + 2;
  for (const p of POWERS) {
    const status = p.built ? '' : `  [not built yet — arrives in batch ${p.batch}]`;
    console.log(`  ${p.cmd.padEnd(pad)}${p.desc}${status}`);
  }
  console.log(`  version${' '.repeat(pad - 7)}Print the version`);
  console.log('\nDocs: docs/ogham-schema.md defines the model. In-development build: only init works.');
}

function cmdInit(cwd) {
  const ogmaDir = path.join(cwd, '.ogma');
  const configPath = path.join(ogmaDir, 'config.json');
  if (fs.existsSync(configPath)) {
    console.log(`Already initialized: ${configPath}`);
    return 0;
  }
  const projectName = path.basename(cwd);
  const config = defaultConfig(projectName);
  const errors = [];
  validateConfig(config, errors);
  if (errors.length) {
    console.error('Refusing to write an invalid config:');
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  fs.mkdirSync(path.join(ogmaDir, 'ogham', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(ogmaDir, 'ogham', 'graph'), { recursive: true });
  fs.mkdirSync(path.join(ogmaDir, 'out'), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(
    path.join(ogmaDir, 'ogham', 'ledger.json'),
    JSON.stringify({ questions: [] }, null, 2) + '\n'
  );
  console.log(`Initialized .ogma/ for "${projectName}"`);
  console.log('  config.json          project settings (destination is asked once, later)');
  console.log('  ogham/               the One Graph — empty until ingest runs');
  console.log('  out/                 rendered artifacts land here');
  return 0;
}

function main(argv) {
  const cmd = argv[2];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { printHelp(); return 0; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') { console.log(VERSION); return 0; }

  const power = POWERS.find(p => p.cmd === cmd);
  if (!power) {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    return 1;
  }
  if (!power.built) {
    console.error(`ogma ${cmd}: not built yet — arrives in batch ${power.batch}.`);
    console.error('OGMA ships complete; unbuilt powers refuse to pretend.');
    return 1;
  }
  if (cmd === 'init') return cmdInit(process.cwd());
  // Unreachable while init is the only built power; kept explicit for later batches.
  console.error(`ogma ${cmd}: no handler wired`);
  return 1;
}

process.exit(main(process.argv));
