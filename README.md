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
| **Witness** | Every fact's statement is truth-checked by a blind judge against the cited code itself. Measured on seeded false statements with valid receipts against a public OSS fixture: **10/10 lies caught, 0/9 true statements falsely refuted** ([full record + methodology](benchmarks/oss-fixture/benchmark.md)). The witness is model judgment and can be wrong — which is why this number is measured per release, never assumed |
| **Certificate** | Nothing ships until ten deterministic checks pass; the result is a machine-checkable `certificate.json` that also binds the certified document bytes |
| **Evidence classification** | LIVE / DEAD / HALF-BUILT / UNCLEAR before anything is written up. Dead code never becomes a "feature" in your PRD |
| **One graph** | The PRD, the impl notes, and the user guide cannot cite different code — every claim in every audience traces to the same fact and the same citation |
| **Honesty ledger** | What the code can't answer becomes a tracked question, never a hallucinated paragraph |
| **Local-first** | OGMA's CLI is local and never calls a model; the Ogham never leaves your machine. The reading is done by your own agent — wherever you run it |
| **Surgical refresh** | New commits invalidate only the receipts they touch; only stale facts re-read; output re-certifies |

## Status

**In development — pre-release.** Every power is built and benched: read
(`init`/`terrain`/`graph`/`ingest`), render (`prd`/`explain`/`guides`/
`questions`/`map`), certify (`gate`), stay current (`watch`), deliver
(`push`). The proof pass has run: a full pipeline execution against a public
OSS fixture ending in a **PASS 10/10 certificate**, and a published witness
catch rate — see [benchmarks/oss-fixture/benchmark.md](benchmarks/oss-fixture/benchmark.md).
What remains before release: independent review and the final ship gate.
`ogma --help` stays the honest per-power status board.

```
npm install    # node >= 18; parsers are pure-WASM installs, no compiler
node bin/ogma.js --help
npm test       # 227 checks: validators, hostile shapes, e2e against real git repos
```

## License

MIT © Lee Jun Ying
