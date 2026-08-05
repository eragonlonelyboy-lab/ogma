# OGMA

**One Graph, Many Audiences.**

Every doc generator trusts the model. OGMA is the one that checks.

OGMA reads a codebase once into a receipt-backed model — the **Ogham**, named
for the script the Celtic god of eloquence carved so knowledge could persist —
then renders that one model for every audience:

- **Engineers** get implementation notes: module chains, safe vs. risky change points
- **Business readers** get a feature-first PRD in plain language — zero technical vocabulary, enforced by lint, not by hope
- **End users** get click-by-click guides per app surface
- **Everyone** gets a dashboard and an open-questions ledger where ambiguity is filed with an ID instead of papered over

## Why it's different

| | OGMA |
|---|---|
| **Receipts** | Every fact carries a file:line citation, verified by deterministic code — not by a model |
| **Witness** | Every fact's statement is truth-checked by a blind judge against the cited code itself. The miss rate will be measured on seeded false statements and published with each release — **that benchmark is not built yet, so today there is no number and this row is a design commitment, not a result** |
| **Certificate** | Nothing ships until nine deterministic checks pass; the result is a machine-checkable `certificate.json` |
| **Evidence classification** | LIVE / DEAD / HALF-BUILT / UNCLEAR before anything is written up. Dead code never becomes a "feature" in your PRD |
| **One graph** | The PRD, the impl notes, and the user guide cannot cite different code — every claim in every audience traces to the same fact and the same citation |
| **Honesty ledger** | What the code can't answer becomes a tracked question, never a hallucinated paragraph |
| **Local-first** | OGMA's CLI is local and never calls a model; the Ogham never leaves your machine. The reading is done by your own agent — wherever you run it |
| **Surgical refresh** | New commits invalidate only the receipts they touch; only stale facts re-read; output re-certifies |

## Status

**In development — pre-release.** The data model and CLI skeleton exist; the
pipeline does not yet. `ogma --help` reports the honest per-power status.
This repo goes public only when the whole pipeline works and the benchmark
certificate passes.

```
npm install    # nothing to install yet beyond node >= 18
node bin/ogma.js --help
```

## License

MIT © Lee Jun Ying
