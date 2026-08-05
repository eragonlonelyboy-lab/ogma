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
   never simulates output. Flip `built: true` in `bin/ogma.js` only in the batch
   that actually lands the handler.
4. **No third-party tools or client projects in this repo.** No tool names, no
   client names — in code, comments, docs, or fixtures. Benchmarks run against
   public open-source fixture repos only.
5. **Renderers read the Ogham, never the repo.** If a renderer needs something
   that is not in the Ogham, the fix is in ingest, not a side-channel read.
6. **Classification discipline.** DEAD facts never reach business or guide
   output. HALF-BUILT and UNCLEAR always carry a ledger reference. The gate
   re-checks both; so should you before committing.
7. **Watch never renumbers.** Fact and feature IDs are stable across refreshes;
   watch updates in place.

## Layout

```
bin/ogma.js        CLI entry — command table doubles as the build-status board
lib/schema.js      Ogham validators + constants (single source of schema truth)
docs/ogham-schema.md  The data model — update it in the same commit as any schema change
skill/SKILL.md     The agent-facing skill (junctioned into the user's skills dir)
benchmarks/        Gate fixtures + runner (arrives with the gate)
```

## Verify before claiming

Run `node bin/ogma.js --help` and the benchmark runner after any change. A
schema change without a matching `docs/ogham-schema.md` edit in the same commit
is a defect. Test `init` in a temp dir, not inside this repo.
