# Benchmarks

Runner: `benchmarks/run.js` (`npm test`). Grows with each batch; hardens at ship (Batch 8).

- **Schema bench** — LIVE (Batch 0): validators reject every planted violation
  class (missing receipt, bad classification, empty does/happens/sees,
  unledgered HALF-BUILT, ghost references, duplicate IDs, wrong worst-of-facts)
  and accept the clean fixtures.
- **Receipt verifier bench** — planned (Batch 2): planted fake citations (wrong
  file, wrong line beyond drift window, absent symbol) are all rejected; valid
  citations pass.
- **Gate bench** — planned (Batch 5): each of the seven checks fails on a
  fixture built to violate exactly that check, and passes on the clean fixture.
- **End-to-end fixture** — planned (Batch 8): a small public open-source repo;
  the full pipeline runs and the emitted certificate is published with the
  release. Fixtures are never client material and never authored by the same
  session that wrote the code under test.
