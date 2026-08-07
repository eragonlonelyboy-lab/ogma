// ogma watch — surgical currency. When commits land, the Ogham does not go
// back to zero: this command diffs each fact's verified commit against HEAD,
// marks stale ONLY the facts whose cited code the diff touched, and advances
// the manifest to HEAD. The re-reading of stale facts is the skill layer's
// work (judgment); deciding WHICH facts need it is deterministic and lives
// here. The mechanism is receipt invalidation: a receipt cites file:line
// ranges, so a diff hunk overlapping a cited range (widened by the same ±N
// drift window verification uses) invalidates the fact that cited it.
//
// Two laws this command keeps:
//   - Watch never renumbers. Fact and feature IDs are stable; the ONLY field
//     watch writes on a fact is `status`.
//   - Cannot-prove-currency means stale, never skip-and-pass. A fact whose
//     verified_at_commit git can no longer diff (rebased away, shallow clone)
//     is marked stale with that reason — silence is not freshness.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./schema');

const MAX_REPORTED = 50;

// Parse `git diff -U0` output into old-side intervals: [{ start, count }].
// count 0 is a pure insertion after old line `start`. Only hunk headers are
// read; the patch body is never interpreted.
function parseHunkIntervals(diffText) {
  const intervals = [];
  for (const line of String(diffText).split('\n')) {
    if (!line.startsWith('@@ ')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (!m) continue;
    intervals.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return intervals;
}

// Does any hunk touch the widened receipt range [lo, hi]?
// Deletions/modifications: plain interval overlap on the old side. Pure
// insertions after old line a land between a and a+1, so they change the
// cited span when a is inside [lo-1, hi] — conservative on the boundary,
// because over-invalidating re-reads a fact and under-invalidating certifies
// a stale one.
function hunksTouch(intervals, lo, hi) {
  for (const { start, count } of intervals) {
    if (count === 0) {
      if (start >= lo - 1 && start <= hi) return true;
    } else if (start <= hi && start + count - 1 >= lo) {
      return true;
    }
  }
  return false;
}

// Widened range of one receipt — the same window verification tolerates.
function widenedRange(receipt) {
  const end = receipt.end_line === undefined ? receipt.line : receipt.end_line;
  return { lo: Math.max(1, receipt.line - S.RECEIPT_DRIFT_WINDOW), hi: end + S.RECEIPT_DRIFT_WINDOW };
}

function readJson(p) {
  try { return { value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { error: e.message }; }
}

function cmdWatch(cwd, log = console.log) {
  try {
    const ogham = path.join(cwd, '.ogma', 'ogham');
    const manifestPath = path.join(ogham, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      log('No ogham/manifest.json — watch needs a completed read. Run `ogma ingest` first.');
      return 1;
    }

    const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.error || head.status !== 0) { log('ogma watch failed: not a git repository with commits.'); return 1; }
    const headCommit = head.stdout.trim();

    const manifestRead = readJson(manifestPath);
    if (manifestRead.error) { log(`ogma watch failed: manifest.json unreadable: ${S.safe(manifestRead.error, 200)}`); return 1; }
    const manifest = manifestRead.value;
    const mErrors = [];
    S.validateManifest(manifest, mErrors);
    if (mErrors.length) {
      log(`ogma watch failed: manifest.json is not valid: ${mErrors.slice(0, 3).join('; ')}`);
      return 1;
    }

    if (S.sameCommit(manifest.cutoff_commit, headCommit)) {
      log(`Ogham is current at ${headCommit.slice(0, 12)} — nothing moved, nothing to do.`);
      return 0;
    }

    // --- load facts files ----------------------------------------------------
    const factsDir = path.join(ogham, 'facts');
    const factFiles = fs.existsSync(factsDir)
      ? fs.readdirSync(factsDir).filter(f => f.endsWith('.json')).sort()
      : [];
    const docs = []; // { file, doc }
    for (const f of factFiles) {
      const read = readJson(path.join(factsDir, f));
      if (read.error) { log(`ogma watch failed: facts/${f} unreadable: ${S.safe(read.error, 200)}`); return 1; }
      const vErrors = [];
      S.validateModuleFile(read.value, vErrors);
      if (vErrors.length) {
        log(`ogma watch failed: facts/${f} is not valid (${vErrors.length} finding(s), first: ${vErrors[0]}). Fix and re-run ingest first.`);
        return 1;
      }
      docs.push({ file: f, doc: read.value });
    }

    // --- diff caches, per verified commit ------------------------------------
    // Facts cluster at a handful of commits; one name-only diff per commit and
    // one -U0 diff per (commit, file) keeps this linear in touched files.
    const changedFilesAt = new Map();   // commit -> Set(paths) | { error }
    const hunksAt = new Map();          // `${commit}\0${file}` -> intervals
    const changedFiles = (commit) => {
      if (!changedFilesAt.has(commit)) {
        // -c core.quotepath=false: git otherwise octal-escapes non-ASCII
        // names, which would never string-match a receipt's path — and a
        // missed match here is a stale fact certified fresh.
        const r = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', commit, headCommit, '--'],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        changedFilesAt.set(commit, (r.error || r.status !== 0)
          ? { error: (r.stderr || 'git diff failed').trim() }
          : new Set(r.stdout.split('\n').filter(Boolean)));
      }
      return changedFilesAt.get(commit);
    };
    const hunksFor = (commit, file) => {
      const key = `${commit}\0${file}`;
      if (!hunksAt.has(key)) {
        const r = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', commit, headCommit, '--', file],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        hunksAt.set(key, (r.error || r.status !== 0) ? { error: true } : parseHunkIntervals(r.stdout));
      }
      return hunksAt.get(key);
    };

    // --- invalidate ----------------------------------------------------------
    const staleReport = [];   // { id, module, reason }
    let touchedDocs = 0;
    let alreadyStale = 0;
    let checkedFacts = 0;

    for (const { file, doc } of docs) {
      let docChanged = false;
      for (const fact of Array.isArray(doc.facts) ? doc.facts : []) {
        checkedFacts++;
        if (fact.status === 'stale') { alreadyStale++; continue; } // still awaiting its re-read
        // A fact without verified_at_commit (legal on non-LIVE facts) is not
        // watched: ingest and the gate verify its receipts at HEAD on every
        // run, so moved code surfaces there deterministically. Skipping is
        // not skip-and-pass — the gate owns these, watch never did.
        const commit = S.isCommitish(fact.verified_at_commit) ? fact.verified_at_commit : null;
        if (commit === null) continue;
        const receipts = [
          ...(Array.isArray(fact.receipts) ? fact.receipts : []),
          ...(fact.path && Array.isArray(fact.path.chain)
            ? fact.path.chain.map(h => h && h.receipt).filter(Boolean) : [])
        ];
        let reason = null;
        const changed = changedFiles(commit);
        if (changed.error) {
          reason = `verified_at_commit ${commit.slice(0, 12)} cannot be diffed against HEAD (${S.safe(changed.error, 120)})`;
        } else {
          for (const r of receipts) {
            if (!changed.has(r.file)) continue;
            const hunks = hunksFor(commit, r.file);
            const { lo, hi } = widenedRange(r);
            if (hunks.error) { reason = `${r.file}: diff failed — currency cannot be proven`; break; }
            if (hunksTouch(hunks, lo, hi)) { reason = `${r.file}:${lo}-${hi} touched since ${commit.slice(0, 12)}`; break; }
          }
        }
        if (reason !== null) {
          fact.status = 'stale';
          docChanged = true;
          staleReport.push({ id: fact.id, module: doc.module, reason });
        }
      }
      // Watch writes exactly one field per invalidated fact: status. The
      // rewrite re-serializes the whole doc, but every id, receipt, ruling
      // and narration rides through untouched.
      if (docChanged) {
        fs.writeFileSync(path.join(factsDir, file), JSON.stringify(doc, null, 2) + '\n');
        touchedDocs++;
      }
    }

    // --- advance the manifest ------------------------------------------------
    // cutoff_commit answers "is the Ogham pointed at this repo"; per-fact
    // status now carries the currency claim, so the pointer advances even when
    // facts went stale — that is the designed split, not an oversight.
    const advanced = {
      ...manifest,
      cutoff_commit: headCommit,
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    };
    const aErrors = [];
    S.validateManifest(advanced, aErrors);
    if (aErrors.length) { log('ogma watch failed: produced an invalid manifest: ' + aErrors.slice(0, 3).join('; ')); return 1; }
    fs.writeFileSync(manifestPath, JSON.stringify(advanced, null, 2) + '\n');

    // --- report --------------------------------------------------------------
    log(`Watched ${String(manifest.cutoff_commit).slice(0, 12)} → ${headCommit.slice(0, 12)}: ${checkedFacts} fact(s) checked, ${touchedDocs} facts file(s) updated.`);
    for (const s of staleReport.slice(0, MAX_REPORTED)) log(`  stale  ${s.id} (${s.module}) — ${s.reason}`);
    if (staleReport.length > MAX_REPORTED) log(`  ... ${staleReport.length - MAX_REPORTED} more`);
    if (alreadyStale > 0) log(`  ${alreadyStale} fact(s) were already stale and still await their re-read.`);
    if (staleReport.length === 0 && alreadyStale === 0) {
      log('No cited code was touched — every fact stays fresh.');
    }
    log(`Manifest advanced to ${headCommit.slice(0, 12)}.`);
    if (staleReport.length > 0 || alreadyStale > 0) {
      log('Next: re-read each stale fact at HEAD (read protocol: re-author, re-witness,');
      log('set verified_at_commit + status fresh), then `ogma ingest`, re-render, `ogma gate`.');
    } else {
      log('Next: re-render (documents stamp the commit) and `ogma gate` to re-certify.');
    }
    return 0;
  } catch (e) {
    log(`ogma watch failed: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdWatch, parseHunkIntervals, hunksTouch, widenedRange };
