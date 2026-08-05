# Benchmarks

Arrives with the gate (Batch 5) and hardens at ship (Batch 8).

Planned coverage:

- **Schema bench** — validators reject every planted violation class (missing
  receipt, bad classification, empty does/happens/sees, unledgered HALF-BUILT,
  orphan feature, renumbered ID).
- **Receipt verifier bench** — planted fake citations (wrong file, wrong line
  beyond drift window, absent symbol) are all rejected; valid citations pass.
- **Gate bench** — each of the seven checks fails on a fixture built to violate
  exactly that check, and passes on the clean fixture.
- **End-to-end fixture** — a small public open-source repo; the full pipeline
  runs and the emitted certificate is published with the release. Fixtures are
  never client material and never authored by the same session that wrote the
  code under test.

Runner: `benchmarks/run.js` (`npm test`).
