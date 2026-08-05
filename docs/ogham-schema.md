# The Ogham — data model

The Ogham is OGMA's internal model of a codebase: the One Graph that every output renders from. It lives inside the target project at `.ogma/ogham/`, as plain JSON — agent-readable, git-diffable, no database.

The core law: **a fact without a receipt does not enter the Ogham.** Every claim about the system carries at least one verifiable code citation, and the gate re-verifies citations deterministically. Renderers read the Ogham and never the repo, so every audience retells the same facts.

## Layout on disk

```
.ogma/
  config.json          # project settings (see config schema below)
  ogham/
    manifest.json      # repo identity, cut-off commit, counts, schema version
    terrain.json       # surfaces, modules, entry points, language stats
    graph/             # index artifacts (symbols, edges) — built by ingest
    facts/<module>.json  # one file per module: features + facts + receipts
    ledger.json        # open questions: ambiguity never silently resolved
  out/                 # rendered artifacts (prd/, tech/, guides/, map/)
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

`cutoff_commit` is the commit the Ogham describes. Watch compares new commits against it.

## terrain.json

```json
{
  "surfaces": [
    { "id": "user-app", "kind": "frontend", "root": "apps/mobile", "entry_points": ["apps/mobile/src/main.tsx"] }
  ],
  "modules": [
    { "id": "payments", "name": "Payments", "surface_ids": ["user-app"], "roots": ["src/payments"], "summary": "Paying bills and sending money" }
  ],
  "languages": { "ts": 61234, "cs": 40210 }
}
```

A **surface** is a distinct app a person can open (user app, admin web, worker). A **module** is a business area a stakeholder would name — not a code community.

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
      "sees": "A success screen with a reference number and the updated balance; on failure, a reason and a retry option.",
      "fact_ids": ["FACT-payments-001", "FACT-payments-002"]
    }
  ],
  "facts": [
    {
      "id": "FACT-payments-001",
      "feature_id": "FEAT-payments-pay-bill",
      "kind": "rule",
      "statement": "A payment above the daily limit is rejected with a limit message.",
      "classification": "LIVE",
      "receipts": [
        { "file": "src/payments/service.ts", "line": 88, "symbol": "validateDailyLimit" }
      ],
      "path": { "entry": "POST /payments", "chain": ["controller.create", "service.validateDailyLimit", "service.send"], "exit": "201 + reference" },
      "ledger_refs": []
    }
  ]
}
```

Rules:
- `kind`: `behavior` | `rule` | `limit` | `state` | `integration`
- `classification` (feature = worst of its facts):
  - **LIVE** — reachable from a real entry point, wired end to end
  - **DEAD** — code exists, nothing references it (tech voice only; never in PRD or guides)
  - **HALF-BUILT** — partially wired, ends nowhere (ledger; never narrated as working)
  - **UNCLEAR** — cannot be determined from code (ledger, with the specific question)
- Every fact has **≥ 1 receipt** — including DEAD/HALF-BUILT/UNCLEAR facts, whose receipts point at the code that raised the doubt.
- `path` is required for LIVE facts of kind `behavior`/`rule`: entry → chain → exit, each hop receipted in the graph.
- Facts are voice-neutral. Renderers produce the tech / business / guide retellings at render time and embed fact IDs in the output for gate traceability.

## Receipt

```json
{ "file": "src/payments/service.ts", "line": 88, "symbol": "validateDailyLimit" }
```

- `file` — repo-relative path, must exist at `cutoff_commit`
- `line` — 1-indexed; the verifier tolerates a small drift window (±5) when re-checking
- `symbol` — function/class/route name that must appear at or near the cited line
- Verification is zero-LLM: file exists, symbol present in window. Watch invalidates receipts whose file+range a new commit touched.

## ledger.json

```json
{
  "questions": [
    {
      "id": "Q-003",
      "module": "payments",
      "question": "Refund flow has a service and tests but no route registers it. Shipped elsewhere, or unfinished?",
      "classification_context": "HALF-BUILT",
      "receipts": [ { "file": "src/payments/refund.ts", "line": 12, "symbol": "RefundService" } ],
      "status": "open",
      "owner": null,
      "raised_at": "2026-08-05",
      "resolved_note": null
    }
  ]
}
```

`status`: `open` | `answered` | `wont-fix`. A flag raised during reading that does not appear here fails the gate.

## certificate.json

```json
{
  "ogham_version": 1,
  "project": "acme-wallet",
  "cutoff_commit": "a1b2c3d",
  "checked_at": "2026-08-05T12:30:00Z",
  "checks": [
    { "id": "coverage",   "pass": true,  "detail": "14/14 modules rendered" },
    { "id": "receipts",   "pass": true,  "detail": "212/212 citations verified, 0 broken" },
    { "id": "leaklint",   "pass": true,  "detail": "0 banned terms in business/guide outputs" },
    { "id": "complete",   "pass": true,  "detail": "63/63 features carry does/happens/sees" },
    { "id": "ledger",     "pass": true,  "detail": "7/7 raised flags present in ledger" },
    { "id": "orphans",    "pass": true,  "detail": "0 orphan features, 0 empty modules" },
    { "id": "readability","pass": true,  "detail": "grade 8.2 avg on narrative sections (max 10)" }
  ],
  "verdict": "PASS"
}
```

`verdict` is `PASS` only when all seven pass. Renderers stamp a human-readable badge (verdict + counts + commit) into document headers.

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

`destination.kind`: `null` until the ask-once flow runs; then e.g. `confluence`, `notion`, `markdown-only`. OGMA always keeps the local markdown fleet regardless of destination.

## Invariants (enforced by `lib/schema.js`, re-checked by the gate)

1. Every fact: ≥1 receipt, valid classification, existing `feature_id`.
2. Every feature: ≥1 fact, all of does/happens/sees non-empty, belongs to an existing module.
3. Every module: ≥1 feature or an explicit `empty_reason`.
4. Every HALF-BUILT / UNCLEAR fact: ≥1 `ledger_refs` entry that exists in `ledger.json`.
5. DEAD facts never appear in business or guide renders.
6. IDs are unique across the Ogham and stable across refreshes (watch updates facts in place; it does not renumber).
