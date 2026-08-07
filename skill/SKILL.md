---
name: ogma
description: "OGMA — One Graph, Many Audiences. Read a codebase once into a receipt-backed model (the Ogham), then render it per audience: implementation notes for engineers, a feature-first PRD for business readers, click-by-click guides for end users. Every fact carries a verified code citation; every output ships with a deterministic certificate. STATUS: every power is live (init, terrain, graph, ingest, renderers, gate, map, watch, push); the OSS-fixture benchmark, published witness catch rate (10/10 lies caught, 0/9 false refutations) and independent review are done. What remains before public ship: the blind ship panel passing, and publication."
---

# OGMA — One Graph, Many Audiences

> **Build status: every power is live.** Read (`init`, `terrain`, `graph`,
> `ingest`), render (`prd`, `explain`, `guides`, `questions`, `map`), certify
> (`gate`), stay current (`watch`), and deliver (`push`) all work; the
> protocols below are in force. The OSS-fixture benchmark, the published
> witness catch rate (10/10 seeded lies caught, 0/9 true statements falsely
> refuted — `benchmarks/oss-fixture/`) and the independent maker-checker
> review are done. What remains before public ship: the blind ship panel
> passing on the finished tree, then publication. Do not simulate anything —
> every power is real, and `ogma --help` stays the honest status board.

## The read protocol (how a host agent inscribes an Ogham)

Deterministic scaffold first, judgment second, deterministic check last.

1. **Scaffold.** `ogma init` → `ogma terrain` → `ogma graph`. Then REFINE
   `terrain.json` by hand: real module names, stakeholder summaries (replace
   every `Auto-detected …` summary), correct surface kinds. Re-running the
   scan never clobbers refinements.
2. **Sweeps** — three passes per module, reading actual code (`git show`, the
   graph's `definitionsOf` as the worklist): frontend (what a user can do),
   backend (what actually happens, chains, rules, limits), API/contract (what
   crosses the boundary). Author facts into `facts/<module>.json`: one
   checkable statement each, receipts citing the code you just read
   (file:line:symbol), kind, feature grouping with does/happens/sees.
3. **Classify before you narrate.** The graph is the map, the code is the
   verdict: `reachableFrom`/`trace` from the entry points, then read the
   wiring. Wired end to end → LIVE (behavior/rule facts carry the `path`
   chain, every hop receipted). Defined but unreached → DEAD. Partially
   wired, stubbed, or TODO → HALF-BUILT + ledger question. Cannot determine →
   UNCLEAR + ledger question. Never narrate what no user can reach.
4. **The witness pass** — for every fact, a BLIND judge (fresh context, e.g.
   a subagent) is shown ONLY the statement and the excerpts derived by
   `lib/witness.js` (`deriveExcerpts` — the cited lines at the fact's commit,
   nothing more, never the sweep reasoning) and rules CONFIRMED / REFUTED /
   UNSUPPORTED. Store the ruling with `input_hash` from
   `factInputHash(statement, receipts, reader)` — ingest recomputes it, so a
   hand-written hash will not survive. Non-confirmed: re-read the code,
   rewrite the statement, re-witness — at most 3 passes, then demote to
   UNCLEAR with a ledger question. A LIVE fact must end CONFIRMED at its
   `verified_at_commit`.
5. **Close.** `ogma ingest` must exit 0 — it checks schemas, facts↔terrain in
   both directions, every receipt against the repo, and every witness
   binding, then writes the manifest. Fix everything it names and re-run to
   zero. An ingest that will not pass is a read that is not done.

## The watch protocol (when the code moves)

Run `ogma watch`. It diffs each fact's verified commit against HEAD, marks
stale ONLY the facts whose cited code the diff touched (fact receipts and
path-hop receipts both count), names each with its reason, and advances the
manifest. Then the surgical refresh — judgment work, done fact by fact:

1. For each stale fact: re-read the cited code at HEAD (`git show`), rewrite
   the statement if the behavior changed, fix receipts to the code's new
   location, re-witness blind (same rule as the read protocol), set
   `verified_at_commit` to HEAD and `status` to `fresh`. A fact whose code is
   gone is reclassified (DEAD, or ledgered) — never silently deleted, and IDs
   are NEVER renumbered.
2. `ogma ingest` to zero, re-render every enabled audience, `ogma map`, then
   `ogma gate` — renders produced before the watch may still carry
   since-staled facts, so re-rendering before the gate is part of the loop.

Never re-read fresh facts "while you're in there" — the diff decided the
worklist, and re-reading unchanged code proves nothing.

## The push protocol (delivering the fleet)

`ogma push` delivers the certified fleet to the destination the user chose.
The CLI enforces: consent recorded by the ask-once flow (never adopted from a
repo-supplied config), certificate present + passing + at HEAD, and — for
page-backed destinations — every write verified by reading it back before
push-state records it. First run: `ogma push` with nothing configured prints
what it detected and how to choose; the choice persists. Confluence needs
`CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` in the
environment — secrets never enter config or state. The local `out/` fleet
stays canonical regardless of destination; ask the user before the first push
to any external system, every time — the CLI's consent gate is not a
substitute for the conversation.

## What OGMA is (when complete)

Point OGMA at a codebase. It reads once and inscribes one internal model — the
**Ogham** — where every fact carries **receipts** (file:line + symbol citations
verified by deterministic code) and a **witness ruling**: a blind judge, shown
only the sentence and the cited code, confirms or refutes each statement, and
non-confirmed facts loop through rewrite-and-recheck until they clear or drop
to the open-questions ledger. Then it renders that one model for every audience:

- **Engineers** — implementation notes: module chains, safe vs. risky change points
- **Business readers** — a feature-first PRD: what the user does, what happens, what they see; zero technical vocabulary, enforced by lint
- **End users** — click-by-click guides per surface
- **Everyone** — a dashboard, and an open-questions ledger where ambiguity is filed with an ID instead of papered over

Evidence discipline before anything is written up: every candidate feature is
classified **LIVE** (wired end to end), **DEAD** (unreferenced — never shown to
business readers), **HALF-BUILT** (partially wired — ledger, never narrated as
working), or **UNCLEAR** (ledger, with the specific question).

Nothing is "done" until `ogma gate` passes ten deterministic checks and emits
a certificate — including that every fact holds a witness ruling and every
**LIVE** fact holds a fresh CONFIRMED one. A non-confirmed ruling demotes its
fact into the ledger; that is a legal, certifiable end state, not a failure.
The gate also refuses to certify an Ogham that is not bound to the repository's
current HEAD, a fact whose cited code moved since it was verified, or a
rendered document that no longer byte-matches the Ogham. When the code moves,
`ogma watch` invalidates only the receipts the diff touched and refreshes only
those facts — then re-certifies; skipping watch cannot help, because ingest
and the gate prove the same currency signal independently.

## The contract with the host agent

The CLI is deterministic and never calls a model. The reading and the prose are
the host agent's work, done under this skill's rules; the proving is the CLI's.
The split is the product: judgment where judgment belongs, receipts everywhere.

## Layout

- `docs/ogham-schema.md` — the full data model (facts, receipts, ledger, certificate)
- `bin/ogma.js` — the CLI (`ogma --help` reports per-power build status honestly)
- `lib/schema.js` — validators; a fact without a receipt does not enter the Ogham
