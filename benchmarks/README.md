# Benchmarks

Runner: `benchmarks/run.js` (`npm test`). Grows with each batch; hardens at ship (Batch 8).

- **Schema bench** — LIVE (Batch 0): validators reject every planted violation
  class (missing receipt, missing or stale witness ruling, bad classification,
  empty does/happens/sees, unledgered HALF-BUILT, ghost references, duplicate
  IDs, wrong worst-of-facts) and accept the clean fixtures.
- **Path bench** — LIVE (Batch 0), both directions: real framework paths
  (Next.js route groups and dynamic segments, SvelteKit `+page`, scoped
  packages, spaces, non-ASCII) must be **citable**, and dangerous shapes
  (traversal, absolute, UNC, drive letter, control bytes, bidi overrides, git
  pathspec magic, `.git`/`.ogma` at any depth in any case) must be **rejected**.
  A path rule that only tests the reject side is how whole ecosystems go
  silently undocumented under a passing certificate.
- **Contract bench** — LIVE (Batch 0): the `out/` document set, the witness
  input-hash canonical form, and commit-identity/HEAD-binding helpers behave as
  the schema doc specifies, so Batch 5 wires tested functions rather than prose.
- **Hostile-input bench** — LIVE (Batch 0): validators report and never throw;
  error output is capped; attacker text never reaches a terminal unescaped;
  `init` refuses symlinked components and an invalid or unparseable config.
- **Witness catch-rate bench** — planned (Batch 3, blocks ship): the spec names
  this as the cheapest test of the product's riskiest assumption, and it was
  missing from this plan while README.md described it as already measured. Seed
  N statements known to be false, each with a valid receipt, into a fixture
  Ogham; run the witness pass; publish the catch rate with the release. A poor
  catch rate is a publishable result, not a reason to withhold the number.
- **Receipt verifier bench** — planned (Batch 2): planted fake citations (wrong
  file, wrong line beyond drift window, absent symbol) are all rejected; valid
  citations pass.
- **Gate bench** — planned (Batch 5): each of the ten checks fails on a
  fixture built to violate exactly that check, and passes on the clean fixture.
- **End-to-end fixture** — planned (Batch 8): a small public open-source repo;
  the full pipeline runs and the emitted certificate is published with the
  release. Fixtures are never client material and never authored by the same
  session that wrote the code under test.
