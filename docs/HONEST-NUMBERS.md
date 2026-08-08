# Honest numbers

Every Demiurge repo states what its numbers cannot prove, when the tool is the wrong tool, and the one honest test. This is OGMA's page.

## What the numbers are

- **260/260 benchmarks** (`npm test`): validators against hostile shapes, every CLI power end to end against real temporary git repos, mutation-tested checks (a check that survives the deletion of the rule it guards is decoration, so we delete rules and confirm the named check fails).
- **10/10 seeded lies caught, 0/9 true statements falsely refuted**: the witness protocol measured against a public OSS fixture (vercel/ms), with false statements planted behind valid receipts. Full method and raw verdicts: [benchmarks/oss-fixture/benchmark.md](../benchmarks/oss-fixture/benchmark.md).
- **PASS 10/10 certificate** on the same fixture, reproduced by the shipped binary, with document bytes bound by hash.

## What they cannot prove

- **The witness number is one fixture, one seeding, one model run.** It is a measured catch rate, not a guarantee. A different repo, a subtler lie, or a different judge model can score worse. That is why the number is measured per release and never assumed.
- **The leak lint is a word list.** Around 35 banned technical terms, checked whole-word on narrative text. It catches "endpoint" in your PRD; it does not make prose plain, and it passed a sentence about threads and mutexes without complaint. The README says "linted against a list", and that is all it means.
- **The readability grade is Flesch-Kincaid.** A proxy with known blind spots, not a comprehension test with humans.
- **The graph resolves symbols by name.** Two functions with the same name in different files can merge in the call graph. Receipt verification only tightens on graph knowledge, never loosens, so this costs precision in impact queries, not soundness in citations.
- **A CONFIRMED fact can still rot between watch runs.** Watch invalidates receipts on commit; it cannot see a truth that changed without touching the cited lines (config flipped elsewhere, a feature flag, an environment).
- **The certificate certifies process, not product quality.** PASS means every fact has a verified citation, a fresh binding, and a witness ruling. It does not mean the documentation is complete, well organized, or wise.

## When OGMA is the wrong tool

- Languages outside js, ts, py, cs, go, java: terrain works, the symbol graph does not cover you, and verification falls back to text matching.
- Documents that go beyond what code proves: vision, strategy, marketing. OGMA files what it cannot cite as open questions, which is the wrong shape for aspirational prose.
- A repo small enough that a README covers it. The protocol earns its overhead on codebases where docs drift, not on scripts.
- Teams that want zero agent involvement. The reading is agent work by design; only the checking path is deterministic.

## The one honest test

Run the pipeline on your own repo, then try to make OGMA lie:

1. `ogma init`, have your agent read the repo (skill included), `ogma gate` to a PASS.
2. Now forge: reword a fact's statement and keep its ruling, point a receipt at different code, hand-edit a rendered document, or commit and change the cited lines.
3. Run `ogma gate` again.

Every forgery class above is caught by a named check, because the gate re-derives from HEAD instead of trusting the ingest. An independent pre-release review planted five such forgeries after a clean ingest; all five were refused by name. If you find one that passes, that is a bug worth filing more than a star.
