# Changelog

All notable changes to dsh-memo. Versions follow the npm release
history; benchmark numbers are measured on [LongMemEval-S](bench/README.md)
with the harness in this repo.

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
