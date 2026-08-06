# The Ogham — data model

The Ogham is OGMA's internal model of a codebase: the One Graph that every output renders from. It lives inside the target project at `.ogma/ogham/`, as plain JSON — agent-readable, git-diffable, no database.

Two laws:
1. **A fact without a receipt does not enter the Ogham.** Every claim carries at least one code citation, re-verified deterministically.
2. **Every fact carries a witness ruling, and a LIVE fact's ruling is a fresh CONFIRMED one.** Receipts prove the citation is real; the witness pass checks the *statement* against the cited code (see The witness pass). Non-LIVE facts keep their last ruling — a REFUTED ruling is precisely why a fact stops being LIVE — and only LIVE facts render to business and guide readers.

Renderers read the Ogham and never the repo, so every audience retells the same facts.

## The riskiest assumption (named, with its cheapest test)

The product rests on one assumption: **a statement pinned to code and then blind-checked against that code is materially more trustworthy than an unchecked one.** Receipts alone do NOT make a statement true — a false sentence with a valid citation passes citation checks. The witness pass exists to close that gap, and the witness is itself a model whose rulings can be wrong.

Cheapest test (run in the benchmark, result published with every release): seed N statements known to be false, each with a valid receipt, into a fixture Ogham; run the witness pass and the gate; publish the catch rate. If the catch rate is poor, the certificate must say so rather than imply blanket truth.

## Layout on disk

All paths everywhere in the Ogham are **repo-relative POSIX paths from `manifest.repo_root`** — no absolute paths, no `..`, no backslashes, no drive letters (enforced by `lib/schema.js`).

```
.ogma/
  config.json          # project settings (see config schema)
  ogham/
    manifest.json      # repo identity, cut-off commit, counts, schema version
    terrain.json       # surfaces, modules, entry points, language stats
    graph/index.json   # symbol table + call sites (see graph/index.json section below)
    raised.json        # flag IDs raised during reading, written BEFORE ledger authoring
    facts/<module>.json  # one file per module: features + facts + receipts + witness rulings
    ledger.json        # open questions: ambiguity never silently resolved
  out/                 # rendered artifacts (created by renderers per enabled audience)
  certificate.json     # latest gate result
```

## manifest.json

```json
{
  "ogham_version": 1,
  "project": "acme-wallet",
  "repo_root": ".",
  "cutoff_commit": "a1b2c3d",
  "generated_at": "2026-08-05T12:00:00Z",
  "counts": { "surfaces": 2, "modules": 14, "features": 63, "facts": 212, "ledger_open": 7 }
}
```

`cutoff_commit` is **the commit the Ogham is current as of** — not a floor. It must equal repo HEAD for the gate to certify (see `head_commit` under certificate.json).

This was specified as a floor and separately required to equal HEAD, which cannot both hold once a single commit lands: keep the floor and the certificate becomes permanently unobtainable, advance it to HEAD and the floor is decorative. The resolution keeps the field's binding job and moves per-fact currency onto the facts, where `watch` already works:

- `cutoff_commit` advances to HEAD on every completed `watch`.
- A fact keeps the older `verified_at_commit` it was actually read at. That is expected and legal — re-reading unchanged code would prove nothing.
- `status` carries the currency claim: `fresh` asserts no commit since `verified_at_commit` touched this fact's receipts; `watch` sets `stale` on the ones it did touch.
- Only `fresh` LIVE facts render to business and guide readers (`rendersTo`). A stale fact is not wrong, it is unverified since the code moved, and those two audiences cannot evaluate that. `tech` output still shows it, marked.

So the three questions are answered separately and each by a field that can actually answer it: *is the Ogham pointed at this repo* (`cutoff_commit` vs HEAD), *when was this fact read* (`verified_at_commit`), *is that reading still good* (`status`).

## terrain.json

```json
{
  "surfaces": [
    { "id": "user-app", "kind": "frontend", "root": "apps/mobile", "entry_points": ["apps/mobile/src/main.tsx"] }
  ],
  "modules": [
    { "id": "payments", "name": "Payments", "surface_ids": ["user-app"], "roots": ["apps/mobile/src/payments"], "summary": "Paying bills and sending money" }
  ],
  "languages": { "ts": 61234, "cs": 40210 }
}
```

A **surface** is a distinct deployable a person or system runs. `kind`: `frontend` | `admin-web` | `worker` | `service`. Interactive kinds (`frontend`, `admin-web`) get user guides; non-interactive kinds (`worker`, `service`) are exempt from the `guides` audience, and the certificate's coverage detail records the exemption. A **module** is a business area a stakeholder would name — not a code community. Module `roots` sit under their surface's `root`; all are repo-relative. Surface `root` and module `roots` additionally accept `"."` — a single-app repo is its own surface, and forcing a fake subdirectory on the most common repo shape would be worse than the special case. Receipt paths never accept `"."`: a citation names a file. A module with no features must carry an `empty_reason` string in its facts file.

**Provenance.** `ogma terrain` (the Eyes, `lib/terrain.js`) writes the first draft of this file from a deterministic scan of the tree **at HEAD** (`git ls-tree` / `git show`, never the working tree — untracked files are not part of any certified state). Scan-authored module summaries say so in their text (`Auto-detected … Not yet refined by ingest.`); ingest replaces them with stakeholder language. Re-running the scan **merges**: existing surfaces and modules are kept verbatim (refinements always win), only genuinely new candidates are appended, and only `languages` — purely derived data — is refreshed. A directory becomes a module candidate at **2+ code files**; files that clear no threshold are counted and reported in the scan output, never silently dropped.

**ID grammar** (enforced by the gate's `integrity` check): features `FEAT-<module>-<slug>`, facts `FACT-<module>-<seq>`, questions `Q-<seq>` — all matching `[A-Za-z0-9-]+`, unique across the whole Ogham.

## graph/index.json — the Nerves

Machine-written by `ogma graph` (`lib/graph.js`), validated by `validateGraphIndex`. The symbol table + call sites for every supported tracked file **at HEAD**, parsed by a WebAssembly engine (pure install, no compiler, no network):

```json
{
  "graph_version": 1,
  "commit": "a1b2c3d",
  "files": [
    { "path": "src/handlers.ts", "language": "ts",
      "symbols": [{ "name": "payHandler", "kind": "function", "line": 1, "end_line": 3 }],
      "calls":   [{ "name": "checkLimits", "line": 2, "from": "payHandler" }] }
  ],
  "skipped": { "unsupported": 3, "too_large": 0, "parse_failed": 0, "unreadable": 0 }
}
```

Languages v1: js/jsx, ts, tsx, py, cs, go, java. `calls` carries both real call sites and **reference edges** (a bare identifier passed as an argument — how a route registration hands over its handler; without that edge no route→handler→rule chain exists). `from` is the innermost enclosing symbol, `null` at top level; queries map `null` to the single node `(top)`. Resolution is **by name** — structural, not semantic; two same-named symbols merge in the call graph, which is a documented limit the classifier's ledger absorbs, never silently. Skipped files are counted by reason, never silently absent. Query layer: `definitionsOf` / `callersOf` / `trace` (deterministic shortest chain, `null` when no chain exists) / `reachableFrom` (the raw LIVE/DEAD signal for Batch 3) / `impactOf` (transitive reverse reachability — what breaks when this changes). Symbol names obey the same symbol-shape rule receipts use; every path must be citable.

## Witness excerpts — the derivation rule

The excerpts a witness is shown, and the bytes `witness.input_hash` binds, are **derived, not chosen**: one block per entry in the fact's `receipts` (path-hop receipts are NOT included), the cited file at the fact's `verified_at_commit` (HEAD when absent), lines `line..end_line` inclusive with **no drift widening** — the judge sees exactly what is cited, not the neighborhood — newlines normalized to `\n`, no other transformation. `lib/witness.js` (`deriveExcerpts`, `factInputHash`) is the executable form of this rule; `ogma ingest` recomputes the hash from it, so a ruling whose statement, receipts, or cited code do not reproduce the stored hash is rejected as forged or stale. This paragraph and that file change together.

## ingest — the deterministic bookend

`ogma ingest` never reads code into prose (the CLI is zero-LLM); it proves a completed read is structurally whole: every Ogham file validates; facts↔terrain reconcile in **both** directions (an orphaned facts file, or a terrain module with no facts file, is documentation silently missing); ids are globally unique; every `ledger_refs` and raised id resolves; every receipt (fact, path-hop, and ledger-question) verifies against the repo — graph-backed when the graph is current for that fact's commit, text-backed otherwise; and every witness `input_hash` recomputes. A stale graph refuses with the fix named. On success it writes `manifest.json` bound to HEAD; on any finding it names everything and writes nothing. LIVE facts whose whole path is unreachable in the graph are surfaced as warnings — a contradiction signal for judgment, not a verdict.

## facts/<module>.json — the atoms

```json
{
  "module": "payments",
  "features": [
    {
      "id": "FEAT-payments-pay-bill",
      "name": "Pay a bill",
      "classification": "LIVE",
      "does": "User selects a saved bill, enters an amount, confirms.",
      "happens": "The amount is checked against the daily limit and the balance, then the payment is sent.",
      "sees": "A success screen with a reference number and the updated balance.",
      "fact_ids": ["FACT-payments-001"]
    }
  ],
  "facts": [
    {
      "id": "FACT-payments-001",
      "feature_id": "FEAT-payments-pay-bill",
      "kind": "rule",
      "statement": "A payment above the daily limit is rejected with a limit message.",
      "classification": "LIVE",
      "receipts": [ { "file": "src/payments/service.ts", "line": 88, "end_line": 95, "symbol": "validateDailyLimit" } ],
      "path": {
        "entry": "POST /payments",
        "chain": [ { "hop": "service.validateDailyLimit", "receipt": { "file": "src/payments/service.ts", "line": 88, "symbol": "validateDailyLimit" } } ],
        "exit": "201 + reference"
      },
      "witness": { "verdict": "CONFIRMED", "checked_at_commit": "a1b2c3d", "checker": "blind-witness-v1", "input_hash": "<witnessInputHash(statement, excerpts) — canonical form below>" },
      "verified_at_commit": "a1b2c3d",
      "status": "fresh",
      "ledger_refs": []
    }
  ]
}
```

Field rules (all enforced by `lib/schema.js` unless marked gate):

- `kind`: `behavior` | `rule` | `limit` | `state` | `integration`
- `classification` (severity order `LIVE < DEAD < HALF-BUILT < UNCLEAR`):
  - **LIVE** — reachable from a real entry point, wired end to end
  - **DEAD** — code exists, nothing references it
  - **HALF-BUILT** — partially wired, ends nowhere
  - **UNCLEAR** — cannot be determined from code
- **Render filtering is per-FACT, and the rule is `rendersTo(fact, audience)` in `lib/schema.js`, not prose:** business (`prd`) and guide output carry **LIVE facts only**; `tech` output carries every fact with its classification and ledger reference, because engineers are the audience that needs the doubt. So DEAD, HALF-BUILT and UNCLEAR facts are all excluded from business and guide output, whatever their feature's rollup says. A feature's `classification` is **computed** — worst of the facts it owns — and the validator rejects a stored value that disagrees with the recompute. A LIVE feature therefore contains only LIVE facts; a feature dragged down by one doubtful fact surfaces that in its rollup instead of hiding it.
- **Feature narration follows the facts it owns:** a feature with ≥1 LIVE fact carries `does`/`happens`/`sees` (its non-LIVE facts are simply excluded from business/guide render — a mostly-working feature stays narrated, its rollup classification surfaces the doubt). A feature with **zero** LIVE facts carries `why_not_narrated` instead — narrating an experience no user can have would be fabrication.
- **The feature↔fact link must agree in both directions:** every id in `fact_ids` is a fact whose `feature_id` points back, and every fact pointing at a feature is listed in its `fact_ids`. A feature owning zero facts is an orphan (error).
- Every fact has **≥1 receipt** — including DEAD/HALF-BUILT/UNCLEAR facts, whose receipts point at the code that raised the doubt.
- `path` is required for LIVE facts of kind `behavior`/`rule`; **every chain hop carries its own receipt**, making "each hop receipted" checkable rather than prose.
- `witness` — the truth ruling (see The witness pass). **One rule, stated once:** every fact carries a ruling, and a **LIVE** fact's ruling must be `CONFIRMED` with `witness.checked_at_commit` naming the same commit as the fact's `verified_at_commit`. A non-CONFIRMED ruling demotes the fact rather than sitting on a LIVE one. Both the validator and the gate enforce exactly this.
- `verified_at_commit` + `status` (`fresh` | `stale`) — watch marks facts stale by receipt invalidation and refreshes only those. Required on LIVE facts: freshness is not checkable without it. Commit-ish fields are compared by **abbreviation-aware equality** (one is a prefix of the other, both ≥7 hex chars), because git legitimately writes the same commit as a 7-char id in one field and a 40-char id in another.
- `ledger_refs`: `string[]` of `ledger.questions[].id`. Required non-empty for HALF-BUILT/UNCLEAR.
- Facts are voice-neutral. Renderers produce the tech / business / guide retellings at render time and embed fact IDs in the output for gate traceability.

## Receipt — exact verification semantics

```json
{ "file": "src/payments/service.ts", "line": 88, "end_line": 95, "symbol": "validateDailyLimit" }
```

- `file` — contained, repo-relative POSIX path, checked by a **deny-list**. The rule rejects only what is dangerous: `.`/`..`/empty segments, absolute and UNC paths, drive letters, backslash, >4096 chars, control bytes, C1 bytes and bidi overrides (terminal and path spoofing), the characters git or win32 read as syntax (`< > : " | ? *`), a segment starting with `-` (argv option position), a segment ending in `.` or a space (win32 aliases two paths onto one file), and **any segment named `.git` or `.ogma` at any depth, in any case** — a citation may never point at version control or OGMA's own state.

  Everything else a real repository contains is citable, deliberately: `app/[id]/page.tsx`, `src/routes/+page.svelte`, `app/(marketing)/layout.tsx`, `packages/@scope/pkg/src/index.ts`, names carrying spaces or non-ASCII letters. An allow-list of "portable" characters was tried and was worse — it made whole ecosystems uncitable, so those files were silently left undocumented while the certificate still read PASS. Win32 reserved device names (`CON`, `NUL`, `COM1`) are **not** rejected: OGMA reads only through `git show <commit>:<path>` and never opens the working-tree file, so they are ordinary names here.
- `line` — 1-indexed, `end_line` optional (≥ line); the receipt's **range** is `[line, end_line ?? line]`
- `symbol` — identifier-shaped, ≤200 chars (validator-enforced shape)
- **Verification (zero-LLM):** read `git show <verified_at_commit>:<file>` — never the working tree, so a dirty tree cannot fake or break a receipt. Every commit-ish field (`verified_at_commit`, `witness.checked_at_commit`, `manifest.cutoff_commit`) is validated as hex `[0-9a-f]{7,64}` **because it reaches git's argv**: an unvalidated value like `--output=<path>` would sit in an option position and let git create or truncate a file. Readers must additionally pass `--end-of-options` and never place data-derived strings in option positions. The symbol must appear as a **literal word-boundary match** (never a constructed RegExp from data) within the range widened by ±`RECEIPT_DRIFT_WINDOW` (5 — an untested default, tuned when Batch 2 lands).
- **Invalidation (watch):** a commit touching `file` within the widened range marks the fact `stale`.
- Known false-positive risk, stated: a short symbol can word-boundary-match an unrelated occurrence in the window. The witness pass is the backstop; the bench measures it.

## The witness pass

The witness pass runs **before** a fact is written to disk, not after. A statement is drafted, pinned to receipts, and witnessed; only then does it enter `facts/<module>.json`. That ordering is what lets the validator demand a ruling on every fact — a half-witnessed Ogham is never a legal state on disk.

A **blind checker** — given ONLY the fact's `statement` and the freshly read code at its receipts, never the ingest reasoning — rules:

- **CONFIRMED** — the cited code supports the statement
- **REFUTED** — the cited code says otherwise
- **UNSUPPORTED** — the cited code doesn't show this

Non-CONFIRMED facts loop: re-read the code, rewrite the statement from it, re-witness — at most 3 passes, then the fact is **reclassified UNCLEAR, keeps its last ruling, and enters the ledger**. That is a legal, certifiable end state: the gate's `witness` check requires a fresh CONFIRMED ruling **on every LIVE fact** and *some* ruling on every fact — it does not demand CONFIRMED of facts the pipeline has already demoted to doubt. Certificate detail reports both populations (e.g. "198/198 LIVE CONFIRMED; 14 non-LIVE carry rulings + ledger refs").

The ruling is stored on the fact with provenance: `checker` (who/what judged) and `input_hash`. The CLI cannot re-judge, but it deterministically enforces presence, verdict, freshness (`checked_at_commit` names the same commit as the fact's `verified_at_commit`), and — at gate time — that `input_hash` matches a recomputed hash of the current statement + cited code, so a ruling cannot be quietly reused after either changed.

### `input_hash` — the exact canonical form

Without a stated canonical form this field is unbuildable: two honest runs hash differently, the recompute can never match, and the anti-reuse check becomes decoration. `witnessInputHash(statement, excerpts)` in `lib/schema.js` is the single implementation.

1. Normalize every newline (`\r\n` and bare `\r`) to `\n`. Trim the statement; leave excerpt code otherwise untouched.
2. Render each excerpt as `<file>:<line>-<end_line>` (with `end_line` defaulting to `line`), a newline, then the code.
3. **Sort the rendered excerpt blocks** as strings, so citation order cannot change the digest.
4. Join `["ogma-witness-v1", statement, ...sortedBlocks]` with the separator line `\n--\n`.
5. sha256 the UTF-8 bytes; store the lowercase hex digest.

The version tag `ogma-witness-v1` is part of the hashed input. If the canonical form ever changes, bump it — every old ruling then fails the gate loudly instead of matching by accident. Unusable input (empty statement, no excerpts, a non-citable path, a non-integer line) **throws** rather than hashing: a digest over garbage still looks like a valid digest.

**Trust boundary, stated plainly:** the witness field is written by the skill layer, and a dishonest or careless host agent could write CONFIRMED without running the pass. The hash check makes that harder (the ruling is bound to exact inputs); it cannot make it impossible. The published seeded-false-statement catch rate is the external evidence that the pass actually discriminates. The witness is model judgment and can be wrong — measured, not assumed.

## raised.json

During reading, every doubt raised gets an ID appended here **before** ledger authoring:

```json
{ "raised": ["Q-001", "Q-002", "Q-003"] }
```

The gate's `ledger` check is `raised ⊆ ledger`. Honest scope: both files are written by the same agent in the same run, so this is a **sequencing check** — it catches a doubt flagged during reading and then lost before ledger authoring. It cannot catch a doubt never recorded at all.

## ledger.json

```json
{
  "questions": [
    {
      "id": "Q-003",
      "module": "payments",
      "question": "Refund flow has a service and tests but no route registers it. Shipped elsewhere, or unfinished?",
      "classification_context": "HALF-BUILT",  // optional; one of the four classifications — which doubt-state raised this
      "receipts": [ { "file": "src/payments/refund.ts", "line": 12, "symbol": "RefundService" } ],
      "status": "open",
      "owner": null,
      "raised_at": "2026-08-05",
      "resolved_note": null
    }
  ]
}
```

`status`: `open` | `answered` | `wont-fix`.

## The out/ contract

Four of the nine gate checks (`coverage`, `leaklint`, `readability`, and the render half of `integrity`) read rendered documents. Which documents, named how, is therefore part of the schema and not a renderer's private business — an unspecified filename is a check that silently reads nothing and passes.

`outDocuments(config, terrain)` in `lib/schema.js` returns the exact set a run must produce, as paths relative to `.ogma/out/`, sorted:

| Document | Written when | Contents |
|---|---|---|
| `questions.md` | always | the open-questions ledger |
| `map.md` | always | the dashboard |
| `prd.md` | `audiences.prd` | the feature-first PRD, LIVE facts only |
| `tech/<module>.md` | `audiences.tech` | implementation notes, one per terrain module, all classifications |
| `guides/<surface>.md` | `audiences.guides` | click-by-click guide, one per **interactive** surface (`frontend`, `admin-web`) |

Rules that make the set checkable:

- Every path matches `[A-Za-z0-9-]+(/[A-Za-z0-9-]+)*\.md` — validated by `isSafeOutPath`. Module and surface ids are attacker-reachable through a hand-edited `terrain.json`, so an id failing the **ID grammar** is skipped rather than interpolated into a path; a traversal can never become a destination.
- The set is exhaustive in both directions: a document listed here and missing fails `coverage`; a file in `out/` that is not listed here fails `integrity`.
- `worker` and `service` surfaces produce no guide, and the certificate's `coverage` detail records the exemption rather than counting it as a gap.

**The fact-ID annotation** (the traceability syntax three gate checks parse): a rendered claim line ends with `<!-- fact:FACT-x -->`; a feature heading ends with `<!-- feature:FEAT-x -->`. That HTML-comment form is the ENTIRE syntax — one regex (`ANNOTATION_RX` in `lib/render.js`) defines it, `parseAnnotations` reads it, and `stripAnnotations` is the single implementation the leak lint and the readability check use to remove annotations before scanning prose. Annotations are invisible in rendered markdown, so business and guide readers never see them; the gate uses them to prove every rendered claim traces to a fact and no fact id is orphaned. Renderers (`lib/render.js`) are deterministic assemblers of prose authored at ingest — they read only the Ogham (no git, no repo access), gate every audience through `rendersTo`, and require a manifest (a passed `ogma ingest`) before anything renders.

## The leak lint

Business (`prd`) and guide output must contain zero technical vocabulary. The base banned-term list ships in `lib/schema.js` (`LEAKLINT_BASE`, ~35 terms: endpoint, api, dto, middleware, …); `config.leaklint_extra` **adds** terms. Matching: case-insensitive, word-boundary, on prose only — text inside inline code spans and fenced code blocks is exempt. The base list is a curated default, extended as real leaks are found.

## Readability

Check 8 scores narrative prose with **Flesch-Kincaid grade level, computed per rendered document; every document must be ≤ `config.readability_max_grade`** (default 10) — no averaging, one hard document hides inside a passing mean. Scored: paragraph text in rendered business/guide output. Excluded: headings, tables, code blocks, list markers, and fact-ID annotations. Sentence boundary: `.`, `!`, `?` followed by whitespace. Certificate detail reports the worst document, not the mean.

## certificate.json

```json
{
  "ogham_version": 1,
  "project": "acme-wallet",
  "cutoff_commit": "a1b2c3d",
  "checked_at": "2026-08-05T12:30:00Z",
  "head_commit": "a1b2c3d",
  "audiences_enabled": ["prd", "tech", "guides"],
  "checks": [
    { "id": "coverage",   "pass": true, "detail": "14/14 modules rendered in every enabled audience" },
    { "id": "receipts",   "pass": true, "detail": "241/241 receipt objects verified (fact + path-hop + ledger receipts), 0 broken" },
    { "id": "witness",    "pass": true, "detail": "198/198 LIVE facts CONFIRMED at their verified commit; 14 non-LIVE carry rulings + ledger refs; input hashes match" },
    { "id": "leaklint",   "pass": true, "detail": "0 banned terms in business/guide outputs" },
    { "id": "complete",   "pass": true, "detail": "60/60 features with LIVE facts carry does/happens/sees; 3/3 without carry why_not_narrated" },
    { "id": "ledger",     "pass": true, "detail": "raised ⊆ ledger: 7/7" },
    { "id": "orphans",    "pass": true, "detail": "0 orphan features; 0 empty modules lacking empty_reason" },
    { "id": "readability","pass": true, "detail": "worst document grade 9.1 (max 10), Flesch-Kincaid per document" },
    { "id": "integrity",  "pass": true, "detail": "Ogham bound to HEAD a1b2c3d; IDs unique across modules; all ledger_refs resolve; out/ matches the document contract" }
  ],
  "verdict": "PASS"
}
```

`verdict` is `PASS` only when all nine pass. Check scope is the enabled audience set, recorded in the certificate so a PASS is interpretable. An **orphan feature** is a feature owning zero facts. Renderers stamp a badge (verdict + counts + commit) into document headers.

**`head_commit` and the binding rule.** The gate reads the repo's current HEAD and records it. `integrity` fails unless `oghamIsBound(manifest.cutoff_commit, head_commit)` holds. Without this, nothing anywhere compares the Ogham to the repository it claims to describe: every fact stays internally consistent, every receipt still verifies against the commit it was written at, and a months-old Ogham certifies `PASS` over code that has moved on. When it fails, the fix is `ogma watch`, which refreshes the stale facts and re-certifies.

## config.json

```json
{
  "version": 1,
  "project": "acme-wallet",
  "audiences": { "prd": true, "tech": true, "guides": true },
  "destination": { "kind": null, "asked": false },
  "language": "en",
  "leaklint_extra": [],
  "readability_max_grade": 10
}
```

`version` is the **config** schema version (`CONFIG_VERSION`), deliberately independent of `ogham_version`. `destination.kind` is `null` until the ask-once flow runs, then one of the allowlisted kinds (`markdown-only`, `confluence`, `notion`, `jira`). OGMA always keeps the local markdown fleet regardless of destination. Deep validation (audience booleans, kind allowlist, grade bounds) is enforced — users hand-edit this file.

## Invariants

Per-record and per-file — enforced by `lib/schema.js` (validators report, never throw). One validator per Ogham file: `validateModuleFile`, `validateManifest`, `validateTerrain`, `validateRaised`, `validateLedgerEntry`, `validateConfig`.

1. Every fact: ≥1 receipt, valid classification, `feature_id` resolving in its module, bidirectional feature↔fact agreement.
2. Every feature owning ≥1 LIVE fact: all of does/happens/sees; every feature owning none: `why_not_narrated`.
3. Every module file: `features`/`facts` present as arrays; zero features requires `empty_reason`.
4. Every HALF-BUILT/UNCLEAR fact: ≥1 `ledger_refs` entry (string IDs).
5. Feature classification equals worst-of-owned-facts; in-file ID uniqueness.
6. LIVE behavior/rule facts carry `path`; **any** fact carrying a `path` has every hop receipted and validated, LIVE or not — the demotion lifecycle leaves paths on non-LIVE facts, and an unvalidated hop receipt is the receipt nobody ever verifies.
7. Every fact carries a witness ruling; a LIVE fact's ruling is CONFIRMED at its `verified_at_commit`.
8. `manifest`: schema version, a hex `cutoff_commit`, an ISO-8601 UTC `generated_at`, non-negative counts. `terrain`: id grammar and uniqueness on surfaces and modules, known surface kinds, contained roots and entry points, every module `surface_ids` resolving. `raised`: unique ids matching the ID grammar. `graph`: version, null-or-hex commit, citable unique paths, symbol-shaped names, line bounds, non-negative skip counts.

Global cross-file — enforced by the gate's `integrity` check: the Ogham is bound to repo HEAD; ID uniqueness across modules; every `ledger_refs` id resolves in `ledger.json`; `out/` matches the document contract; non-LIVE facts absent from business/guide renders.

Process rules (not machine-checkable in one snapshot, stated as discipline): watch updates facts in place and never renumbers IDs.

## The gate and the certificate

`ogma gate` (`lib/gate.js`) runs nine checks and writes `.ogma/certificate.json` on PASS **and** on FAIL — an honest failing certificate is the product working. Pass conditions, pinned (this prose and the code change together):

1. **coverage** — every document `outDocuments(config, terrain)` expects exists under `out/`, and (when `prd` is enabled) `prd.md` carries a `## <name>` section for every terrain module. Guide exemptions for non-interactive surfaces are recorded in the detail, never counted as gaps.
2. **receipts** — every receipt on every fact (including path hops) verifies at that fact's own commit; ledger-question receipts verify at HEAD.
3. **witness** — every fact carries a ruling; LIVE means CONFIRMED; every `input_hash` recomputes from statement + derived excerpts.
4. **leaklint** — no banned technical vocabulary in `prd.md` or `guides/*.md`, measured on narrative text (annotations stripped, code spans and fences removed, headings dropped), case-insensitive whole-word. `config.leaklint_extra` entries are **literal terms, never regex source** — a regex here would hand pattern syntax and catastrophic backtracking to a config file.
5. **complete** — LIVE features narrate does/happens/sees; unnarrated features carry `why_not_narrated`.
6. **ledger** — every raised id resolves; every HALF-BUILT/UNCLEAR fact resolves to a real ledger question.
7. **orphans** — every module file passes `validateModuleFile` whole (bidirectional feature↔fact links, worst-of-facts rollups, empty_reason).
8. **readability** — Flesch-Kincaid grade per document (`prd.md`, each `guides/*.md`), on the same narrative text leaklint measures, each ≤ `config.readability_max_grade`. Syllables: vowel-group runs minus a silent trailing `e`, minimum 1. One population, one grade per document — not per line, not per section.
9. **integrity** — the Ogham is bound to HEAD (`cutoff_commit`), ids are globally unique, and every `<!-- fact:… -->` / `<!-- feature:… -->` annotation in every rendered document resolves to a record in the Ogham — an annotation nothing owns is a fabricated claim wearing a receipt.

The certificate schema (`validateCertificate`) refuses dishonest shapes structurally: a topline `pass` that contradicts its rows, or a certificate quietly one check short, does not validate and is never written.

## Assumptions and limits (v1, stated not hidden)

- Receipts verify **citation integrity, not statement truth**; the witness pass covers truth and is itself fallible — its measured catch rate ships with every release.
- The ±5 drift window and the ~35-term leaklint base are untested defaults; both are tuned against real data in later batches.
- Symbol matching is structural (word-boundary text match), not semantic; tree-sitter indexing in Batch 2 narrows but does not eliminate false positives. The implemented rule (`lib/verify.js`): a receipt verifies when its file is retrievable at the pinned commit, its cited line exists, and its symbol occurs as a whole word (Unicode letters/digits/`_`/`$` are the boundary class) within the ±5 drift window; failures come back as a closed reason set (`invalid-receipt` | `missing-file` | `file-too-large` | `bad-line` | `symbol-not-found`) so the gate can aggregate them. The symbol is never compiled into a RegExp. CRLF and LF blobs verify identically. Files over 16 MB fail with their own reason rather than being read. With a graph index supplied, verification upgrades to **symbol-table-backed**: when the graph knows the symbol in that file, a real occurrence (definition or call site) must sit inside the window — a comment mention no longer verifies. The refinement only tightens; a symbol the graph cannot know (variables, config keys, unsupported languages) still verifies by text.
- "Local-first" means: OGMA's CLI is local and never calls a model, and the Ogham never leaves the machine. The *reading* is done by whatever host agent the user runs — if that agent is a hosted model, code goes wherever that agent sends it. OGMA adds no network calls of its own.
- Cross-audience consistency means every audience **cites the same facts and the same code** — renderers cannot introduce a claim without a fact ID. It does not mean the three prose retellings are semantically compared to each other.
- Commit identity is **prefix equality on abbreviated hex**, so two genuinely different commits sharing a 7-character prefix would compare equal. Git itself has this exposure and lengthens abbreviations as a repo grows; OGMA does not currently lengthen. Writers should store full 40-character ids where they can.
- The path deny-list is a judgment about what is dangerous, and judgments can be wrong in both directions: a character class nobody anticipated could still be harmful, and a rejected shape could turn out to be a real file. The bench tests both directions on purpose — a path rule tested only on the reject side is how the previous allow-list passed every test while silently making whole ecosystems uncitable.
- Path containment is enforced on the **string**. A path with no `..` can still be an in-repo symlink pointing outside; reading only through `git show <commit>:<file>` avoids this. Any future reader that touches the working tree must `realpath` and prefix-check against `repo_root` instead of trusting the string.
