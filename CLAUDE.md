# OGMA — build conventions

OGMA ships complete or not at all. This repo goes public only when every power
works and the benchmark passes; until then everything here is local.

## Non-negotiables

1. **Receipts law.** A fact without a verifiable code citation does not enter
   the Ogham. `lib/schema.js` enforces it; never weaken the validator to make a
   build pass.
2. **The CLI is zero-LLM.** `bin/` and `lib/` are deterministic: scaffold,
   validate, verify, certify. Model work (reading code, writing prose) happens
   in the skill layer, never in the binary.
3. **Honest stubs.** An unbuilt command prints its batch number and exits 1. It
   never simulates output. A power is built when its `handler` lands in the
   `POWERS` table — there is no separate flag to flip early.
3b. **Witness rulings come only from the skill layer.** The CLI enforces their
   presence, verdict, and freshness; it never writes one. Every fact carries a
   ruling; a LIVE fact's ruling is CONFIRMED at its verified commit. Anything
   less demotes the fact rather than rendering.
4. **No absorbed tools or client projects in this repo.** No client names and
   no names of the tools OGMA absorbed or competes with — as identity, anywhere:
   code, comments, docs, fixtures. Benchmarks run against public open-source
   fixture repos only. Boundary: ecosystem vocabulary used as **detection or
   rationale data** (framework file names, dependency names, path conventions —
   the things a terrain scan or a path rule must name to work at all) is
   allowed and is not identity.
5. **Renderers read the Ogham, never the repo.** If a renderer needs something
   that is not in the Ogham, the fix is in ingest, not a side-channel read.
6. **Classification discipline.** Business and guide output carries LIVE facts
   only — DEAD, HALF-BUILT and UNCLEAR are all excluded, and `rendersTo()` is
   the single rule, never a paragraph. Only `tech` output shows the doubt.
   HALF-BUILT and UNCLEAR always carry a ledger reference. The gate re-checks
   both; so should you before committing.
7. **Watch never renumbers.** Fact and feature IDs are stable across refreshes;
   watch updates in place.

## Layout

```
bin/ogma.js        CLI entry — command table doubles as the build-status board
lib/schema.js      Ogham validators + constants (single source of schema truth)
lib/init.js        The init command (in lib so the bench tests it directly)
lib/terrain.js     The Eyes — deterministic repo scan into terrain.json (pure core + git shell)
lib/verify.js      The receipt verifier — citation integrity at a pinned commit (zero-dep, literal word-boundary match)
lib/graph.js       The Nerves — WASM tree-sitter symbol/call indexer + query layer (trace, reachability)
lib/witness.js     Witness bookkeeping — excerpt derivation + input_hash recompute (rulings come from the skill layer only)
lib/ingest.js      The read's bookend — schemas, facts<->terrain both ways, receipts, witness binding; writes the manifest
lib/render.js      The Voices — deterministic renderers (prd/tech/guides/questions) + the fact-ID annotation syntax
docs/ogham-schema.md  The data model — update it in the same commit as any schema change
skill/SKILL.md     The agent-facing skill (junctioned into the user's skills dir)
benchmarks/run.js  Schema + hostile-shape + init + CLI bench (npm test); gate fixtures join in Batch 5
```

## Verify before claiming

Run `npm test` after any change — it covers the validators (including hostile
shapes), init and terrain against real temp dirs, and CLI process behavior. A
schema change without a matching `docs/ogham-schema.md` edit in the same commit
is a defect. Each batch closes with the inline audit-redo cycle (re-read
adversarially against spec + done-check, fix, re-audit to zero). The
independent blind review fires ONCE, on the finished product before ship —
never on a draft (house rule CHI-R140, 2026-08-06).
