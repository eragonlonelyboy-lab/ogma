// ogma init — scaffold .ogma/ in a project. Idempotent and repairing:
// creates only what is missing, never overwrites what exists (the ledger in
// particular holds hand-curated human judgment and must survive a re-init).
// Refuses symlinked components so a hostile repo cannot redirect writes.
'use strict';

const fs = require('fs');
const path = require('path');
const { defaultConfig, validateConfig, validateLedgerFile, safe } = require('./schema');
const { refuseSymlink } = require('./util');

// Upper bounds on files OGMA will read at all. Settings are a few hundred
// bytes; a ledger is a human-curated question list, not a data dump.
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

function cmdInit(cwd, log = console.log) {
  const ogmaDir = path.join(cwd, '.ogma');
  const created = [];
  const kept = [];

  try {
    const st = refuseSymlink(ogmaDir);
    if (st && !st.isDirectory()) {
      throw new Error(`cannot create .ogma/: a file with that name already exists`);
    }

    for (const rel of ['', 'ogham', 'ogham/facts', 'ogham/graph', 'out']) {
      const dir = path.join(ogmaDir, rel);
      const dst = refuseSymlink(dir);
      if (dst) {
        if (!dst.isDirectory()) throw new Error(`cannot create ${rel || '.ogma'}/: a file with that name already exists`);
        if (rel === '') continue;
        kept.push(rel + '/');
        continue;
      }
      fs.mkdirSync(dir);
      created.push(rel === '' ? '.ogma/' : rel + '/');
    }

    const configPath = path.join(ogmaDir, 'config.json');
    const cfgSt = refuseSymlink(configPath);
    if (cfgSt) {
      if (!cfgSt.isFile()) throw new Error('cannot create config.json: a directory with that name already exists');
      // An existing config is kept, never overwritten — but "kept" must not mean
      // "trusted". A repo can ship its own .ogma/config.json, and reporting an
      // attacker-chosen destination as successfully initialized is how a later
      // push sends a whole codebase somewhere nobody chose. Validate or refuse.
      // A settings file is a few hundred bytes. Anything larger is not settings,
      // and reading it into memory to find that out is the bug.
      if (cfgSt.size > MAX_CONFIG_BYTES) {
        throw new Error(`config.json is ${cfgSt.size} bytes, over the ${MAX_CONFIG_BYTES}-byte limit — refusing to read it`);
      }
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        throw new Error(`config.json exists but cannot be read as settings: ${safe(e.message, 200)}`);
      }
      const cfgErrors = [];
      validateConfig(existing, cfgErrors);
      if (cfgErrors.length) {
        throw new Error(`config.json exists but is not valid, refusing to run on it: ${cfgErrors.slice(0, 5).join('; ')}`);
      }
      // Validation alone was not enough. `destination.asked: true` means "a
      // human answered the ask-once flow", and a repo can ship that claim with
      // a perfectly allowlisted kind. Then `push` delivers this codebase's
      // documentation somewhere nobody chose, and init said "Initialized".
      // Only this tool may record consent, so a config that arrived with the
      // repo may not carry it.
      const dest = existing.destination;
      if (dest.kind !== null || dest.asked === true) {
        throw new Error(
          'config.json exists and already names a delivery destination ' +
          `(kind=${safe(String(dest.kind), 40)}, asked=${dest.asked === true}). ` +
          'Consent to deliver is recorded by OGMA, never adopted from a file it did not write. ' +
          'Reset destination to {"kind": null, "asked": false}, or delete .ogma/config.json to start clean.'
        );
      }
      // The same rule covers the TARGETING half of the block. A shipped
      // kind:null/asked:false config carrying a pre-seeded confluence
      // space/parent is a redirect waiting for the operator's own consent
      // command to merge it — refusing only kind/asked refused the wrong
      // half of the config.
      if (dest.confluence !== undefined) {
        throw new Error(
          'config.json exists and already carries a confluence targeting block (space/parent). ' +
          'A delivery target is recorded by OGMA when you run `ogma push --to confluence --space ... --parent ...`, ' +
          'never adopted from a file it did not write. Delete destination.confluence, or delete .ogma/config.json to start clean.'
        );
      }
      kept.push('config.json');
    } else {
      const config = defaultConfig(path.basename(cwd));
      const errors = [];
      validateConfig(config, errors);
      if (errors.length) {
        throw new Error('refusing to write an invalid config: ' + errors.join('; '));
      }
      // wx: O_EXCL — fails rather than following a dangling symlink or racing another run
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
      created.push('config.json');
    }

    const ledgerPath = path.join(ogmaDir, 'ogham', 'ledger.json');
    const ledgerSt = refuseSymlink(ledgerPath);
    if (ledgerSt) {
      if (!ledgerSt.isFile()) throw new Error('cannot create ledger.json: a directory with that name already exists');
      // The ledger gets the same treatment config.json gets, and for a stronger
      // reason: this is the file holding hand-curated human judgment, so "kept"
      // must not mean "trusted". A 0-byte ledger from an interrupted write, an
      // unresolved merge conflict, or valid JSON of the wrong shape all reach
      // here without an attacker, and reporting "nothing touched" over one of
      // those hands the next reader a crash.
      if (ledgerSt.size > MAX_LEDGER_BYTES) {
        throw new Error(`ogham/ledger.json is ${ledgerSt.size} bytes, over the ${MAX_LEDGER_BYTES}-byte limit — refusing to read it`);
      }
      let ledger;
      try {
        ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      } catch (e) {
        throw new Error(`ogham/ledger.json exists but cannot be read as a ledger: ${safe(e.message, 200)}`);
      }
      const ledgerErrors = [];
      validateLedgerFile(ledger, ledgerErrors);
      if (ledgerErrors.length) {
        throw new Error(`ogham/ledger.json exists but is not a valid ledger, refusing to run on it: ${ledgerErrors.slice(0, 5).join('; ')}`);
      }
      kept.push('ogham/ledger.json');
    } else {
      fs.writeFileSync(ledgerPath, JSON.stringify({ questions: [] }, null, 2) + '\n', { flag: 'wx' });
      created.push('ogham/ledger.json');
    }
  } catch (e) {
    log(`ogma init failed: ${e.message}`);
    return 1;
  }

  if (created.length === 0) {
    log('Already initialized — nothing to do, nothing touched.');
  } else {
    log(`Initialized .ogma/ (created: ${created.join(', ')}${kept.length ? `; kept existing: ${kept.join(', ')}` : ''})`);
    log('  config.json          project settings (destination is asked once, later)');
    log('  ogham/               the One Graph — empty until ingest runs');
    log('  out/                 rendered artifacts land here');
  }
  return 0;
}

module.exports = { cmdInit };
