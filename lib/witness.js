// Witness bookkeeping — the deterministic half of the witness pass. The
// RULING comes only from the skill layer (a blind judge reading statement +
// code); this module owns everything about a ruling that can be recomputed:
// which excerpts the judge must be shown, and the hash binding the ruling to
// those exact bytes. Without a pinned derivation rule the input_hash is
// decorative — two honest runs would hash differently and a forged hash could
// never be detected. This file IS the derivation rule; docs/ogham-schema.md
// states it in prose, and the two must change together.
'use strict';

const { witnessInputHash } = require('./schema');

// The excerpts a witness is shown for one fact: one block per receipt, the
// cited file AT THE FACT'S VERIFIED COMMIT, lines line..end_line inclusive
// (NO drift widening — the judge sees exactly what is cited, not the
// neighborhood), newlines normalized to \n, no other transformation.
// readFile(path) -> string | null; the caller pins it to the right commit.
// Returns { excerpts } or { error } — a fact whose cited lines cannot be
// produced has no witnessable input, and that is a finding, not a crash.
function deriveExcerpts(receipts, readFile) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { error: 'no receipts — nothing to witness' };
  }
  const excerpts = [];
  for (const r of receipts) {
    if (!r || typeof r.file !== 'string') return { error: 'receipt has no file' };
    const content = readFile(r.file);
    if (typeof content !== 'string') {
      return { error: `cited file ${r.file} is not retrievable at the fact's commit` };
    }
    const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const end = r.end_line === undefined ? r.line : r.end_line;
    if (!Number.isInteger(r.line) || r.line < 1 || r.line > lines.length) {
      return { error: `cited line ${r.line} does not exist in ${r.file} (${lines.length} lines)` };
    }
    excerpts.push({
      file: r.file, line: r.line, end_line: end,
      code: lines.slice(r.line - 1, Math.min(end, lines.length)).join('\n')
    });
  }
  return { excerpts };
}

// The hash a fact's witness ruling must carry: statement + derived excerpts,
// canonicalized by schema.witnessInputHash. Same closed-result contract.
function factInputHash(statement, receipts, readFile) {
  const d = deriveExcerpts(receipts, readFile);
  if (d.error) return { error: d.error };
  try {
    return { hash: witnessInputHash(statement, d.excerpts) };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { deriveExcerpts, factInputHash };
