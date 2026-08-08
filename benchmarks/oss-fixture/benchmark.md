# OSS-fixture benchmark — vercel/ms

The published proof run: OGMA's full pipeline executed against a public
open-source repository, ending in a passing certificate, plus the witness
catch-rate measurement the README's Witness row points at.

- **Fixture:** [`vercel/ms`](https://github.com/vercel/ms) (MIT), a widely
  used duration-conversion library — small enough for a complete, honest
  read; real enough to exercise every stage.
- **Fixture commit:** `4ff48cec099f0514c3e9bbca18706c9c21122bfb`
- **Run date:** 2026-08-07 · certificate regenerated 2026-08-08 with the
  ten-check binary (adds `freshness` + certified document byte-binding)
- **Witness checker:** one fresh-context blind subagent per statement
  (Claude), shown ONLY the statement and the excerpts derived by
  `lib/witness.js` — never the reader's reasoning, never the rest of the
  file.

## Pipeline result

`init → terrain → graph → read protocol (sweeps, classification, blind
witness) → ingest → prd/explain/guides/questions → map → gate`

**Certificate: PASS, 10/10 checks** — [certificate.json](certificate.json).
The tenth check, `freshness`, proves the manifest sits at HEAD and rebuilds
every renderer-owned document to byte-compare it against what shipped; the
certificate records each certified document with its sha256. The Ogham: 1
module, 3 features, 10 facts (9 LIVE, 1 UNCLEAR), 1 open ledger question.
The UNCLEAR fact and its question are the honesty ledger working:
the fixture's unknown-unit guard sits behind a pattern that admits only known
units, so the read filed the reachability doubt instead of narrating it away
([facts-duration.json](facts-duration.json), `FACT-duration-010` / `Q-001`).
The fixture is a library (`service` surface), so the guides audience is
exempt and the certificate's coverage detail records the exemption.

Rendered business output: [sample-prd.md](sample-prd.md) — zero technical
vocabulary (lint-enforced), every claim annotated with the fact id that owns
it.

## Witness catch rate — seeded false statements

Method (pinned in `docs/ogham-schema.md`, "The riskiest assumption"): seed
statements KNOWN to be false, each carrying a receipt that **verifies
deterministically** (the citation is real; the sentence lies), run the blind
witness pass, count what survives. A lie is caught when the ruling is
REFUTED or UNSUPPORTED — under the protocol a non-CONFIRMED ruling can never
sit on a LIVE fact, so either verdict blocks the lie from business and guide
readers. Packets: [lie-packets.json](lie-packets.json); per-lie rulings with
the witnesses' verbatim reasoning: [lie-verdicts.json](lie-verdicts.json).

**Result: 10/10 caught** (9 REFUTED, 1 UNSUPPORTED), across ten distinct
failure classes:

| Lie class | Seeded statement (abridged) | Ruling |
|---|---|---|
| boundary | "longer than 99 characters is rejected" (code rejects >100) | REFUTED |
| inverted outcome | "no match throws an error" (code returns NaN) | REFUTED |
| fabricated guard | "negative durations are rejected" (pattern accepts `-?`) | REFUTED |
| wrong constant | "a year is exactly 365 days" (code: 365.25) | REFUTED |
| wrong direction | "units checked smallest to largest" (largest first) | REFUTED |
| wrong rounding | "always rounded down" (Math.round) | REFUTED |
| wrong threshold | "plural s beyond one unit" (threshold is 1.5) | REFUTED |
| fabricated fallback | "non-finite returns zero" (it throws) | REFUTED |
| inverted rule | "capitals not matched" (pattern is case-insensitive) | REFUTED |
| fabricated step | "strict entry re-checks at run time" (pure pass-through) | UNSUPPORTED |

The boundary lie is the instructive one: the code's own error message
("between 1 and 99") AGREES with the lie, and the witness still refuted it
from the actual condition (`> 100`). A documentation-trusting checker fails
that case; a code-witnessing one does not.

## True-statement control (false-positive rate)

The same protocol ran on the 9 true LIVE statements of the real read:
**8/9 CONFIRMED first pass, 0/9 falsely refuted** (first-pass history in
[lie-verdicts.json](lie-verdicts.json) under `true_statement_control`). The
one non-confirmed first-pass ruling (UNSUPPORTED) was the witness being
RIGHT: the statement claimed full-word units but the cited excerpts did not
show the word table. One receipt expansion later it confirmed — the loop the
protocol prescribes, doing what it prescribes.

## What this run also caught in OGMA itself

Dogfooding found a real defect: the symbol-table refinement rejected a
receipt citing `const mo = y / 12` at its definition, because the graph knew
`mo` only as a reference-site argument (the indexer never records variable
declarations) and the "must appear in the window" tightening fired against a
provably incomplete occurrence list. Fixed in `lib/verify.js` (the
refinement now requires a definition entry), pinned by a bench check, and
verified by mutation. An honest benchmark that finds nothing is usually not
looking.

## Reproducing

```
git clone https://github.com/vercel/ms && cd ms
git checkout 4ff48cec099f0514c3e9bbca18706c9c21122bfb
ogma init && ogma terrain && ogma graph
# ... the read protocol (skill/SKILL.md), then:
ogma ingest && ogma prd && ogma explain && ogma guides && ogma questions && ogma map && ogma gate
```

The deterministic stages reproduce byte-for-byte. The witness rulings are
model judgment and can vary — that is exactly why the catch rate is measured
and published instead of assumed.
