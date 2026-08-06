// The receipt verifier — the deterministic half of the Nerves. Answers one
// question with zero judgment: does this citation point at real code in this
// repo at this commit? File retrievable, line in range, symbol present as a
// whole word within the drift window. It cannot tell whether the STATEMENT
// about that code is true — that is the witness pass's job; this proves the
// evidence exists where the fact says it does.
//
// Zero-LLM, zero-dependency. Symbol matching is a LITERAL word-boundary scan,
// never a constructed RegExp: a symbol is repo-derived text, and compiling it
// would hand pattern syntax (and catastrophic backtracking) to the repo.
'use strict';

const { spawnSync } = require('child_process');
const {
  validateReceipt, isCommitish, safe, RECEIPT_DRIFT_WINDOW
} = require('./schema');

// Upper bound on a source file the verifier will read. A receipt into a file
// past this verifies as failed with its own named reason — never silently
// passed, never an unbounded read.
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

// Identifier characters for the word-boundary rule: Unicode letters, digits,
// underscore, dollar — the union of what mainstream languages allow in names.
// A symbol occurrence is a match only when the characters on BOTH sides are
// absent or non-identifier: "limit" must not verify against
// "validateDailyLimit" — a receipt that matches substrings is a receipt that
// verifies against the wrong code. (A constant single-char pattern; the ban
// on RegExp applies to the SYMBOL, which stays a literal needle.)
const IDENT_CHAR = /[\p{L}\p{N}_$]/u;
function isIdentChar(ch) {
  return IDENT_CHAR.test(ch);
}

// Literal whole-word search of `needle` in `haystack`. No RegExp over needle.
function containsWord(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = at + needle.length >= haystack.length ? '' : haystack[at + needle.length];
    // The boundary rule only applies on sides where the symbol itself is
    // identifier-shaped: "operator==" ends in '=', and requiring a
    // non-identifier char after '=' is automatic, while requiring one after
    // a trailing 'e' in "save" is the actual substring guard.
    const beforeOk = before === '' || !isIdentChar(before) || !isIdentChar(needle[0]);
    const afterOk = after === '' || !isIdentChar(after) || !isIdentChar(needle[needle.length - 1]);
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
}

// Split content into lines without inventing a phantom final line from a
// trailing newline. Normalizes CRLF so a checked-out-on-win32 blob and its
// POSIX twin verify identically.
function toLines(content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Verify one receipt against file content. readFile(path) -> string | null |
// { toolarge: true }. Returns { ok: true } or { ok: false, reason, detail } —
// reasons are a closed set so the gate can aggregate them:
//   invalid-receipt | missing-file | file-too-large | bad-line | symbol-not-found
function verifyReceipt(receipt, readFile) {
  const structural = [];
  validateReceipt(receipt, structural, 'receipt');
  if (structural.length > 0) {
    return { ok: false, reason: 'invalid-receipt', detail: structural[0] };
  }
  const content = readFile(receipt.file);
  if (content === null || content === undefined) {
    return { ok: false, reason: 'missing-file', detail: `${safe(receipt.file, 200)} is not in the repo at this commit` };
  }
  if (typeof content === 'object' && content.toolarge) {
    return { ok: false, reason: 'file-too-large', detail: `${safe(receipt.file, 200)} exceeds ${MAX_SOURCE_BYTES} bytes — receipt cannot be verified` };
  }
  const lines = toLines(content);
  const end = receipt.end_line === undefined ? receipt.line : receipt.end_line;
  if (receipt.line > lines.length) {
    return { ok: false, reason: 'bad-line', detail: `line ${receipt.line} cited, file has ${lines.length} lines` };
  }
  // The drift window: code moves a few lines between writes; ±N tolerates
  // that without letting the citation float anywhere in the file. end_line
  // past EOF clamps — the window's job is tolerance, not range validation
  // (structural bounds were already checked).
  const lo = Math.max(1, receipt.line - RECEIPT_DRIFT_WINDOW);
  const hi = Math.min(lines.length, end + RECEIPT_DRIFT_WINDOW);
  const window = lines.slice(lo - 1, hi).join('\n');
  if (!containsWord(window, receipt.symbol)) {
    return {
      ok: false, reason: 'symbol-not-found',
      detail: `"${safe(receipt.symbol, 80)}" not found as a whole word in ${safe(receipt.file, 200)}:${lo}-${hi}`
    };
  }
  return { ok: true };
}

// Verify a batch. Caches file reads: a module's receipts cluster in the same
// files, and re-reading one file per receipt would turn the gate quadratic.
function verifyReceipts(receipts, readFile) {
  const cache = new Map();
  const cachedRead = (p) => {
    if (!cache.has(p)) cache.set(p, readFile(p));
    return cache.get(p);
  };
  const results = [];
  let failed = 0;
  const list = Array.isArray(receipts) ? receipts : [];
  for (const r of list) {
    const v = verifyReceipt(r, cachedRead);
    if (!v.ok) failed++;
    results.push(v);
  }
  // A non-array batch is an upstream defect and must never read as verified.
  return { total: list.length, failed, ok: Array.isArray(receipts) && failed === 0, results };
}

// Git-backed reader at a pinned commit. Returns the closed contract verifyReceipt
// expects. Commit is validated before it touches argv; the path arrives from a
// validated receipt and rides in the same argument as the commit, never in an
// option position.
function makeGitReader(cwd, commit) {
  if (!isCommitish(commit)) throw new Error('makeGitReader: commit must be hex commit id (7-64 chars)');
  return (file) => {
    const probe = spawnSync('git', ['-C', cwd, 'cat-file', '-s', `${commit}:${file}`], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return null;
    const size = Number(probe.stdout.trim());
    if (Number.isFinite(size) && size > MAX_SOURCE_BYTES) return { toolarge: true };
    const r = spawnSync('git', ['-C', cwd, 'show', `${commit}:${file}`],
      { encoding: 'utf8', maxBuffer: MAX_SOURCE_BYTES + 1024 });
    if (r.error || r.status !== 0) return null;
    return r.stdout;
  };
}

module.exports = { verifyReceipt, verifyReceipts, makeGitReader, containsWord, toLines, MAX_SOURCE_BYTES };
