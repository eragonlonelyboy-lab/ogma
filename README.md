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
| **Certificate** | Nothing ships until seven deterministic checks pass; the result is a machine-checkable `certificate.json` |
| **Evidence classification** | LIVE / DEAD / HALF-BUILT / UNCLEAR before anything is written up. Dead code never becomes a "feature" in your PRD |
| **One graph** | The PRD, the impl notes, and the user guide cannot disagree — they render from the same model |
| **Honesty ledger** | What the code can't answer becomes a tracked question, never a hallucinated paragraph |
| **Local-first** | Runs in your own agent on your own machine. Your code never leaves |
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
