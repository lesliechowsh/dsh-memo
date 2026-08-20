# Changelog

All notable changes to dsh-memo. Versions follow the npm release
history; benchmark numbers are measured on [LongMemEval-S and
LoCoMo10](bench/README.md) with the harnesses in this repo.

## 0.4.0 — 2026-08-20

- **Recall algorithm** — `memo_search` now searches each question token plus
  every consecutive token pair as its own quoted phrase and merges by summed
  weights (token length, pair string length — a local rarity proxy), instead
  of plain matched-term count. Selected on LongMemEval-S from five measured
  variants and validated on LoCoMo10; costs up to 15 backend queries per
  search (≈2× of 0.3.x). Experiment log in `bench/README.md`.
  - LongMemEval-S: hit@1 36.4% → **54.6%**, hit@5 68.4% → **75.0%**,
    MRR 0.499 → **0.636**.
  - LoCoMo10 (new secondary benchmark, 1986 questions):
    hit@1 43.7% · hit@5 73.7% · hit@10 87.3% · MRR 0.568.
  - Weak types: assistant-quoted hit@1 1.8% → 17.9%; preference 16.7% →
    26.7%.
- **New** `memo_search` `tags` filter — notes must carry at least one of the
  comma-separated tags.
- **New** `memo_remember` exact-duplicate skip — re-writing identical text
  returns the existing note instead of appending a copy.
- `bench/` now ships the LoCoMo10 harness and the variant-selection
  experiment harnesses (`locomo.cjs`, `exp.cjs`, `exp2.cjs`).

## 0.3.3 — 2026-08-20

- Docs: the Quick example in the English README is an English dialog.

## 0.3.2 — 2026-08-20

- README restructured against top-OSS practice (positioning, AI context
  block, why-memo, requirements, support/contributing/security); Chinese
  README moved to `docs/` so the npm page shows English; added
  CHANGELOG / CONTRIBUTING / SECURITY; dev-form `memo.host.js` dropped from
  the npm tarball.

## 0.3.1 — 2026-08-20

- **Fixed** session titles being silently nulled: `readTitleSnapshots` returns
  `SessionTitleObservation`s whose title lives at `value.title.title` (string
  and object shapes both handled).
- **Benchmark fidelity** — the harness now reproduces the official backend's
  page-size truncation (top 10 per step) and representative-event ranking
  (`match_count DESC, document_length ASC, time DESC, seq DESC`), re-read from
  `dsh-session-query-sqlite` source. Re-measured honestly:
  hit@1 36.4% · hit@5 68.4% · hit@10 80.0% · MRR 0.499
  (previous numbers over-collected per-term candidates).

## 0.3.0 — 2026-08-20

- **Fixed** cross-session recall: session ids were read from `hit.id` instead
  of `hit.header.id`, silently dropping every tokenized-merge result.
- **Fixed** `memo_stats` to read header fields; sessions now fold titles via
  `readTitleSnapshots`.
- **Changed** notes to append raw (never rewritten from parsed rows), so
  hand-edited or malformed lines survive; note matching tokenized.
- **Fixed** LICENSE attribution.
- Published honest benchmark numbers from a product-faithful harness instead
  of the BM25 variant: hit@5 75.4% · MRR 0.582.

## 0.2.x — 2026-08-20

- Tokenized-merge recall in `memo_search`: phrase-first exact matches plus
  per-term searches merged by matched-term count (question-style queries
  went from hit@5 0.2% to working; see benchmark history).
- Benchmark harness moved under `bench/` with a reproduction guide; published
  only the product's own measured numbers (per-type breakdown, no strawman
  baselines, no third-party comparisons); recorded the benchmark environment.
- Design grounded in the LLM memory survey (arXiv:2607.25380); README
  restructured (quick example first).

## 0.1.x — 2026-08-19/20

- Functional memo tools (`memo_search` / `memo_remember` / `memo_stats`) in
  the npm host-plugin form, with `$DSH_HOME` resolved via
  `shellEnv.collect(exec)` — no hardcoded paths.

## 0.0.1 — 2026-08-19

- Reserved the `dsh-memo` npm name (placeholder).
