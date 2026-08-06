---
name: ogma
description: "OGMA — One Graph, Many Audiences. Read a codebase once into a receipt-backed model (the Ogham), then render it per audience: implementation notes for engineers, a feature-first PRD for business readers, click-by-click guides for end users. Every fact carries a verified code citation; every output ships with a deterministic certificate. STATUS: the READ half is live (init, terrain, graph, ingest + the read protocol); renderers, watch, push, and the gate are still unbuilt and refuse to fake a run."
---

# OGMA — One Graph, Many Audiences

> **Build status: the READ half is live.** `ogma init`, `ogma terrain`,
> `ogma graph`, and `ogma ingest` work; the read protocol below is in force.
> Renderers, watch, push, and the gate are not built yet — `ogma --help`
> reports per-power status honestly. Do not simulate an unbuilt power.

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

Nothing is "done" until `ogma gate` passes nine deterministic checks and emits
a certificate — including that every fact holds a witness ruling and every
**LIVE** fact holds a fresh CONFIRMED one. A non-confirmed ruling demotes its
fact into the ledger; that is a legal, certifiable end state, not a failure.
The gate also refuses to certify an Ogham that is not bound to the repository's
current HEAD. When the code moves, `ogma watch` invalidates only the receipts
the diff touched and refreshes only those facts — then re-certifies.

## The contract with the host agent

The CLI is deterministic and never calls a model. The reading and the prose are
the host agent's work, done under this skill's rules; the proving is the CLI's.
The split is the product: judgment where judgment belongs, receipts everywhere.

## Layout

- `docs/ogham-schema.md` — the full data model (facts, receipts, ledger, certificate)
- `bin/ogma.js` — the CLI (`ogma --help` reports per-power build status honestly)
- `lib/schema.js` — validators; a fact without a receipt does not enter the Ogham
