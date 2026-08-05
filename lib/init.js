// ogma init — scaffold .ogma/ in a project. Idempotent and repairing:
// creates only what is missing, never overwrites what exists (the ledger in
// particular holds hand-curated human judgment and must survive a re-init).
// Refuses symlinked components so a hostile repo cannot redirect writes.
'use strict';

const fs = require('fs');
const path = require('path');
const { defaultConfig, validateConfig } = require('./schema');

function refuseSymlink(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') return null; // absent is fine
    throw e; // EACCES/ELOOP/etc: cannot inspect -> must not create over it
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to touch ${p}: it is a symlink`);
  return st;
}

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
