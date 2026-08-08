// Shared plumbing. Every helper here existed as two, three or four private
// copies across lib/ — and one of them (the guarded write) existed only in
// init/terrain while eight other write sites followed repo-planted symlinks.
// The fix for a defect class is one shared implementation, not a per-file
// patch; this file is where those single implementations live.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// JSON file -> { value } | { error }. Never throws.
function readJson(p) {
  try { return { value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { error: e.message }; }
}

// The one timestamp format OGMA writes: ISO-8601 UTC, seconds precision.
function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// lstat that refuses symlinks (junctions included — Node reports both as
// symbolic links). Returns the stat, or null when the path is absent.
// EACCES/ELOOP and friends propagate: a path that cannot be inspected must
// not be created over.
function refuseSymlink(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') return null; // absent is fine
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to touch ${p}: it is a symlink`);
  return st;
}

// The guarded write for EVERYTHING OGMA writes under .ogma/. A cloned repo
// can track .ogma/out (or any component below it) as a symlink and redirect
// writes outside the repo for anyone who runs a render/gate/map/watch/push
// without re-running init — so the refusal cannot live in init alone. This
// walks every component from .ogma down to the target, refuses links at each
// step, creates missing real directories, and only then writes. The
// check-then-write race is accepted: the threat is repo-planted links, not a
// concurrent local attacker.
function ogmaWrite(cwd, rel, data) {
  const parts = String(rel).split('/');
  let cur = path.join(cwd, '.ogma');
  const st = refuseSymlink(cur);
  if (st && !st.isDirectory()) throw new Error('cannot write under .ogma/: a file with that name already exists');
  if (!st) fs.mkdirSync(cur);
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    const s = refuseSymlink(cur);
    if (s && !s.isDirectory()) throw new Error(`cannot create ${parts.slice(0, i + 1).join('/')}/: a file with that name already exists`);
    if (!s) fs.mkdirSync(cur);
  }
  const target = path.join(cur, parts[parts.length - 1]);
  const ts = refuseSymlink(target);
  if (ts && !ts.isFile()) throw new Error(`cannot write ${rel}: a directory with that name already exists`);
  fs.writeFileSync(target, data);
}

// XML/HTML escaping — one implementation for the Confluence adapter and the
// dashboard alike (they were two identical private copies). Both quote forms
// are escaped so the output is safe in an attribute value, not only in element
// content — a future adapter that emits repo-derived text into an attribute
// must not become an injection point.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// HEAD commit at cwd, or an error — the one implementation ingest/watch/gate/
// push each wrapped in the same four-line spawnSync idiom. Callers keep their
// own failure action (a logged sentence, or an {error} return).
function gitHead(cwd) {
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.error || head.status !== 0) return { error: 'not a git repository with commits' };
  return { commit: head.stdout.trim() };
}

module.exports = { readJson, nowIso, refuseSymlink, ogmaWrite, escapeXml, gitHead };
