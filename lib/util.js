// Shared plumbing. Every helper here existed as two, three or four private
// copies across lib/ — and one of them (the guarded write) existed only in
// init/terrain while eight other write sites followed repo-planted symlinks.
// The fix for a defect class is one shared implementation, not a per-file
// patch; this file is where those single implementations live.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

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

// The content digest of a certified document. The gate stamps it into
// certificate.documents and push re-computes it to refuse a document edited
// after certification — two sides of one contract, so one implementation: an
// encoding change in a private copy would silently turn every push into
// "changed after the gate ran".
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// The cap on how many findings a command prints before summarising. Shared so
// ingest and watch cannot drift on what "and N more" means.
const MAX_REPORTED = 50;

// The read counterpart of ogmaWrite. Writes have refused symlinks since the
// symlink class was closed; reads did not, and the asymmetry is the hole: a
// repo-planted junction at .ogma/ogham/facts sources the entire Ogham from
// outside the repository, and a link under .ogma/out sends the gate's walk
// across the operator's filesystem (a self-referential one produced a raw
// ELOOP instead of a named refusal). One guarded listing, used by every site
// that enumerates OGMA state.
// Returns sorted real-file names matching `suffix`; a symlinked directory is
// refused, and symlinked entries are skipped rather than followed.
function safeListFiles(dir, suffix = '.json') {
  refuseSymlink(dir);                       // throws on a linked directory
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(suffix))   // isFile() is false for a link
    .map(e => e.name)
    .sort();
}

// Recursive walk that never leaves the tree it was given: real directories
// only, so a planted link cannot redirect or cycle it.
function safeWalkFiles(dir, suffix = '.md', rel = '') {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;       // never followed, in either direction
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...safeWalkFiles(path.join(dir, e.name), suffix, childRel));
    else if (e.isFile() && e.name.endsWith(suffix)) found.push(childRel);
  }
  return found;
}

// OGMA state that arrived WITH the repository instead of being produced here.
// This is the whole trust boundary for a tool whose ordinary job is reading a
// repository it did not write: `.ogma/ogham/facts/*.json` is the content that
// ends up rendered, certified and pushed, and nothing in it carries a
// self-authenticating property. A committed certificate cannot lie (it would
// have to name the commit that contains it), but a committed FACT can — the
// witness input_hash is an unkeyed digest of statement + cited code, all of
// which a repo author holds, and the victim's own ingest run supplies the
// manifest that binds the Ogham to HEAD. So provenance is checked by asking
// git what it tracks, at every command that reads the Ogham, not only at the
// one that delivers it. init writes .ogma/.gitignore so an ordinary
// `git add -A` cannot produce this state by accident.
// Returns a sorted list of tracked paths under .ogma/ — empty when clean.
function trackedOgmaState(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'ls-files', '--', '.ogma/'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return [];   // not a repo: nothing is tracked
  return r.stdout.split('\n').filter(Boolean).sort();
}

// The one refusal wording, so ingest, gate and push cannot drift on what
// tracked state means or how an operator is told to fix it.
function refuseTrackedOgma(command, tracked, log) {
  const shown = tracked.slice(0, 5).join(', ') + (tracked.length > 5 ? `, and ${tracked.length - 5} more` : '');
  log(`ogma ${command} refused: ${tracked.length} OGMA state file${tracked.length > 1 ? 's are' : ' is'} tracked by this repository (${shown}).`);
  log('OGMA state is produced locally by this tool; state that arrived with a repository is never read as if this operator authored it — a committed fact file would otherwise be rendered, certified and delivered as verified truth.');
  log('Untrack it with `git rm --cached -r .ogma`, commit, then re-run the read. `.ogma/.gitignore` (written by `ogma init`) keeps it untracked.');
}

module.exports = {
  readJson, nowIso, refuseSymlink, ogmaWrite, escapeXml, gitHead,
  safeListFiles, safeWalkFiles, sha256, MAX_REPORTED,
  trackedOgmaState, refuseTrackedOgma
};
