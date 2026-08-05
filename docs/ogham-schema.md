# The Ogham — data model

The Ogham is OGMA's internal model of a codebase: the One Graph that every output renders from. It lives inside the target project at `.ogma/ogham/`, as plain JSON — agent-readable, git-diffable, no database.

Two laws:
1. **A fact without a receipt does not enter the Ogham.** Every claim carries at least one code citation, re-verified deterministically.
2. **A LIVE fact without a fresh CONFIRMED witness ruling does not render.** Receipts prove the citation is real; the witness pass checks the *statement* against the cited code (see The witness pass). Non-LIVE facts keep their last ruling — a REFUTED ruling is precisely why a fact stops being LIVE.

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
    graph/             # symbol/edge index — shape defined in Batch 2 (docs/graph-schema.md, not yet written)
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

`cutoff_commit` is the **floor**: the oldest commit any part of the Ogham may describe. Per-fact freshness lives on the facts themselves (`verified_at_commit`), because watch refreshes facts individually.

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

A **surface** is a distinct deployable a person or system runs. `kind`: `frontend` | `admin-web` | `worker` | `service`. Interactive kinds (`frontend`, `admin-web`) get user guides; non-interactive kinds (`worker`, `service`) are exempt from the `guides` audience, and the certificate's coverage detail records the exemption. A **module** is a business area a stakeholder would name — not a code community. Module `roots` sit under their surface's `root`; all are repo-relative. A module with no features must carry an `empty_reason` string in its facts file.

**ID grammar** (enforced by the gate's `integrity` check): features `FEAT-<module>-<slug>`, facts `FACT-<module>-<seq>`, questions `Q-<seq>` — all matching `[A-Za-z0-9-]+`, unique across the whole Ogham.

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
      "witness": { "verdict": "CONFIRMED", "checked_at_commit": "a1b2c3d", "checker": "blind-witness-v1", "input_hash": "<sha256 of statement + code excerpt>" },
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
- **Render filtering is per-FACT:** DEAD facts never appear in business (`prd`) or guide output, whatever their feature's rollup says. A feature's `classification` is **computed** — worst of the facts it owns — and the validator rejects a stored value that disagrees with the recompute. A LIVE feature therefore contains only LIVE facts; a feature dragged down by one doubtful fact surfaces that in its rollup instead of hiding it.
- **Feature narration follows the facts it owns:** a feature with ≥1 LIVE fact carries `does`/`happens`/`sees` (its non-LIVE facts are simply excluded from business/guide render — a mostly-working feature stays narrated, its rollup classification surfaces the doubt). A feature with **zero** LIVE facts carries `why_not_narrated` instead — narrating an experience no user can have would be fabrication.
- **The feature↔fact link must agree in both directions:** every id in `fact_ids` is a fact whose `feature_id` points back, and every fact pointing at a feature is listed in its `fact_ids`. A feature owning zero facts is an orphan (error).
- Every fact has **≥1 receipt** — including DEAD/HALF-BUILT/UNCLEAR facts, whose receipts point at the code that raised the doubt.
- `path` is required for LIVE facts of kind `behavior`/`rule`; **every chain hop carries its own receipt**, making "each hop receipted" checkable rather than prose.
- `witness` — the truth ruling (see below). The gate refuses facts without a CONFIRMED ruling at the current `verified_at_commit`.
- `verified_at_commit` + `status` (`fresh` | `stale`) — watch marks facts stale by receipt invalidation and refreshes only those.
- `ledger_refs`: `string[]` of `ledger.questions[].id`. Required non-empty for HALF-BUILT/UNCLEAR.
- Facts are voice-neutral. Renderers produce the tech / business / guide retellings at render time and embed fact IDs in the output for gate traceability.

## Receipt — exact verification semantics

```json
{ "file": "src/payments/service.ts", "line": 88, "end_line": 95, "symbol": "validateDailyLimit" }
```

- `file` — contained repo-relative POSIX path (validator rejects `..`, absolute, backslash, drive letter, NUL, >4096 chars)
- `line` — 1-indexed, `end_line` optional (≥ line); the receipt's **range** is `[line, end_line ?? line]`
- `symbol` — identifier-shaped, ≤200 chars (validator-enforced shape)
- **Verification (zero-LLM):** read `git show <verified_at_commit>:<file>` — never the working tree, so a dirty tree cannot fake or break a receipt. The symbol must appear as a **literal word-boundary match** (never a constructed RegExp from data) within the range widened by ±`RECEIPT_DRIFT_WINDOW` (5 — an untested default, tuned when Batch 2 lands).
- **Invalidation (watch):** a commit touching `file` within the widened range marks the fact `stale`.
- Known false-positive risk, stated: a short symbol can word-boundary-match an unrelated occurrence in the window. The witness pass is the backstop; the bench measures it.

## The witness pass

After facts are inscribed, a **blind checker** — given ONLY the fact's `statement` and the freshly read code at its receipts, never the ingest reasoning — rules:

- **CONFIRMED** — the cited code supports the statement
- **REFUTED** — the cited code says otherwise
- **UNSUPPORTED** — the cited code doesn't show this

Non-CONFIRMED facts loop: re-read the code, rewrite the statement from it, re-witness — at most 3 passes, then the fact is **reclassified UNCLEAR, keeps its last ruling, and enters the ledger**. That is a legal, certifiable end state: the gate's `witness` check requires a fresh CONFIRMED ruling **on every LIVE fact** and *some* ruling on every fact — it does not demand CONFIRMED of facts the pipeline has already demoted to doubt. Certificate detail reports both populations (e.g. "198/198 LIVE CONFIRMED; 14 non-LIVE carry rulings + ledger refs").

The ruling is stored on the fact with provenance: `checker` (who/what judged) and `input_hash` (sha256 of the exact statement + code excerpt shown). The CLI cannot re-judge, but it deterministically enforces presence, verdict, freshness (`checked_at_commit` = the fact's `verified_at_commit`), and — at gate time — that `input_hash` matches a recomputed hash of the current statement + cited code, so a ruling cannot be quietly reused after either changed.

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
    { "id": "integrity",  "pass": true, "detail": "IDs unique across modules; all ledger_refs resolve" }
  ],
  "verdict": "PASS"
}
```

`verdict` is `PASS` only when all nine pass. Check scope is the enabled audience set, recorded in the certificate so a PASS is interpretable. An **orphan feature** is a feature owning zero facts. Renderers stamp a badge (verdict + counts + commit) into document headers.

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

Per-record and per-module-file — enforced by `lib/schema.js` (validators report, never throw):

1. Every fact: ≥1 receipt, valid classification, `feature_id` resolving in its module, bidirectional feature↔fact agreement.
2. Every feature owning ≥1 LIVE fact: all of does/happens/sees; every feature owning none: `why_not_narrated`.
3. Every module file: `features`/`facts` present as arrays; zero features requires `empty_reason`.
4. Every HALF-BUILT/UNCLEAR fact: ≥1 `ledger_refs` entry (string IDs).
5. Feature classification equals worst-of-owned-facts; in-file ID uniqueness.
6. LIVE behavior/rule facts carry `path` with per-hop receipts.

Global cross-file — enforced by the gate's `integrity` check: ID uniqueness across modules; every `ledger_refs` id resolves in `ledger.json`; DEAD facts absent from business/guide renders.

Process rules (not machine-checkable in one snapshot, stated as discipline): watch updates facts in place and never renumbers IDs.

## Assumptions and limits (v1, stated not hidden)

- Receipts verify **citation integrity, not statement truth**; the witness pass covers truth and is itself fallible — its measured catch rate ships with every release.
- The ±5 drift window and the ~35-term leaklint base are untested defaults; both are tuned against real data in later batches.
- Symbol matching is structural (word-boundary text match), not semantic; tree-sitter indexing in Batch 2 narrows but does not eliminate false positives.
- "Local-first" means: OGMA's CLI is local and never calls a model, and the Ogham never leaves the machine. The *reading* is done by whatever host agent the user runs — if that agent is a hosted model, code goes wherever that agent sends it. OGMA adds no network calls of its own.
- Cross-audience consistency means every audience **cites the same facts and the same code** — renderers cannot introduce a claim without a fact ID. It does not mean the three prose retellings are semantically compared to each other.
