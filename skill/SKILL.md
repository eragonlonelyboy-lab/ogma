---
name: ogma
description: "OGMA — One Graph, Many Audiences. Read a codebase once into a receipt-backed model (the Ogham), then render it per audience: implementation notes for engineers, a feature-first PRD for business readers, click-by-click guides for end users. Every fact carries a verified code citation; every output ships with a deterministic certificate. STATUS: in development — the pipeline is not active yet. Until the powers land, this skill only explains what OGMA will do and refuses to fake a run."
---

# OGMA — One Graph, Many Audiences

> **Build status: foundation only.** The Ogham schema and the CLI skeleton exist
> (`ogma init`, `ogma --help`). Ingest, renderers, watch, push, and the gate are
> not built yet. If a user asks for an OGMA run today, say plainly that the
> pipeline is not active and point at `ogma --help` for the honest status per
> power. Do not simulate an OGMA run by hand and present it as one.

## What OGMA is (when complete)

Point OGMA at a codebase. It reads once and inscribes one internal model — the
**Ogham** — where every fact carries **receipts** (file:line + symbol citations
verified by deterministic code) and a **witness ruling**: a blind judge, shown
only the sentence and the cited code, confirms or refutes each statement, and
non-confirmed facts loop through rewrite-and-recheck until they clear or drop
to the open-questions ledger. Then it renders that one model for every audience:

- **Engineers** — implementation notes: module chains, safe vs. risky change points
- **Business readers** — a feature-first PRD: what the user does, what happens, what they see; zero technical vocabulary, enforced by lint
- **End users** — click-by-click guides per surface
- **Everyone** — a dashboard, and an open-questions ledger where ambiguity is filed with an ID instead of papered over

Evidence discipline before anything is written up: every candidate feature is
classified **LIVE** (wired end to end), **DEAD** (unreferenced — never shown to
business readers), **HALF-BUILT** (partially wired — ledger, never narrated as
working), or **UNCLEAR** (ledger, with the specific question).

Nothing is "done" until `ogma gate` passes nine deterministic checks and emits
a certificate — including that every fact holds a witness ruling and every
**LIVE** fact holds a fresh CONFIRMED one. A non-confirmed ruling demotes its
fact into the ledger; that is a legal, certifiable end state, not a failure.
The gate also refuses to certify an Ogham that is not bound to the repository's
current HEAD. When the code moves, `ogma watch` invalidates only the receipts
the diff touched and refreshes only those facts — then re-certifies.

## The contract with the host agent

The CLI is deterministic and never calls a model. The reading and the prose are
the host agent's work, done under this skill's rules; the proving is the CLI's.
The split is the product: judgment where judgment belongs, receipts everywhere.

## Layout

- `docs/ogham-schema.md` — the full data model (facts, receipts, ledger, certificate)
- `bin/ogma.js` — the CLI (`ogma --help` reports per-power build status honestly)
- `lib/schema.js` — validators; a fact without a receipt does not enter the Ogham
