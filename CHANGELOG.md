# Changelog

All notable changes to dsh-memo. Versions follow the npm release
history; benchmark numbers are measured on [LongMemEval-S and
LoCoMo10](bench/README.md) with the harnesses in this repo.

## 0.10.0 — 2026-08-21

- **Install now enables session search.** DSH ships full-text session
  search opt-in (base composition: `openAt: never`), so on every default
  deployment `memo_search`'s session side failed with
  `SESSION_QUERY_SEARCH_DISABLED` — the flagship feature was broken out of
  the box and we only found out when a real user tested a real deployment
  (our bench harnesses exercise the algorithm, not the platform). The
  package now carries `cordis.patch.yml`, applied automatically when
  installed as a profile bundle, overriding the platform row to
  `openAt: first-search` (in-memory index; durable `path` override and
  opt-out documented in the README). Added to the npm `files` whitelist.
- **New release rule** (AGENTS.md): every release must be smoke-tested in a
  real default deployment — fresh `dsh plugin add` + real `memo_search`
  against real sessions — not just bench.

## 0.9.0 — 2026-08-21

- **Multi-snippet evidence** — the top-3 hit sessions now each carry up to 3
  matching events (`sessions[i].events`, via `searchEvents`), so the agent
  reads the actual passage instead of one bestMatch line. Pure post-ranking
  enrichment: the ranking path is byte-identical to 0.8.0, so every
  published benchmark number stays valid without a re-run (noted in
  bench/README). Cost: +3 backend calls per search (23 → 26), disclosed in
  both READMEs. Skipped for `sessionId`-scoped searches, where the result
  rows already are events.
- `docs/landscape.md` published — a dated research snapshot of how Mem0 /
  Zep / LangMem / Letta present themselves (install friction, benchmark
  provenance, honesty of disclosure), with sources; explicitly labeled not a
  benchmark.

## 0.8.0 — 2026-08-20

- **df-proxy IDF weighting** — the first variant in the whole series to pass
  the S + M direction-consistency check. analyze.cjs showed discovery is
  near-perfect (99.6% of gold sessions already in some per-phrase top-10) and
  the loss was in the merge ranking; term idf ×4 + pair length × max(idf),
  with df estimated per query by capped-50 counts (8 extra backend calls,
  length-weight fallback). Measured: LongMemEval-S hit@1 74.8% → 78.2%,
  MRR 0.812 → 0.847; LoCoMo10 hit@1 53.2% → 60.2%, MRR 0.651 → 0.718; M
  segments all positive (see bench/README).
- `bench/analyze.cjs` published — miss decomposition (no-anchor /
  discovered-cut / merge-cut / near-miss) and oracle ceilings over the same
  phrase set.

## 0.7.3 — 2026-08-20

- LongMemEval-CN cross-lingual re-measured with the shipped 0.7.0 tokenizer
  (cn.cjs gained an A2 variant): hit@1 33.6% → **44.4%**, every question type
  up. Mechanism: for mixed queries with a single untranslated Latin token,
  the pre-0.7.0 tokenizer produced ≤1 tokens and skipped the weighted step;
  the CJK runs now push the token count above 1, so the Latin token actually
  gets queried. Pure-Chinese queries over English sessions still cannot match
  (translation remains the gap).

## 0.7.2 — 2026-08-20

- `bench/exp5.cjs` / `exp5-m.cjs` published: stemming experiment using the
  authoritative `stemmer` package (validated 0/23531 on Porter's official
  vocabulary). S2 gained +1.2 hit@1 on S but the M direction check was noise
  (hit@1 identical in all three segments) — not shipped. Falsifier outcome
  recorded in bench/README.

## 0.7.1 — 2026-08-20

- CJK detection unified: the tokenizer now uses `\p{Script=Han}` (same as
  the cjkWarning check); previously it scanned `\u3400-\u9fff` (starts in
  Ext-A) — the two disagreed on rare characters.
- `findDuplicate` documented as O(n) per write (fine at current scale;
  a size/mtime-invalidated index is the future fix).
- `bench/exp4.cjs` / `exp4-m.cjs` published: the final lexical ceiling sweep
  (STOP ablation, phrase-order loosening, IDF weighting) with the honest
  conclusion — S-scale gains failed the M direction-consistency check, so
  nothing shipped. Falsifier outcome recorded in bench/README.

## 0.7.0 — 2026-08-20

- **Chinese query support** — the tokenizer now extracts contiguous Han runs
  (len ≥ 2) as weighted query phrases, matching the backend unicode61 index's
  own token granularity. Before this, CJK queries produced zero tokens and
  the weighted step was skipped entirely. Result: a Chinese session is found
  when any run of the question appears verbatim. Word-level recall inside a
  run still needs an upstream tokenizer change; `cjkWarning` says so.
- **New** `bench/zh.cjs` — a self-built deterministic Chinese functional
  regression set (clearly labeled NOT a benchmark): pre-0.7.0 0/11, 0.7.0
  10/11 hit@1, with one ceiling control missed by both.

## 0.6.0 — 2026-08-20

- **LongMemEval-M anti-overfitting check** — the shipped pipeline, unchanged,
  run once on the M variant (500 NEW questions, ~500-session pools, ~10× the
  S pool size): hit@1 52.6% · hit@5 76.6% · hit@10 82.8% · MRR 0.626
  (≈ 260× the 0.2% random baseline). The per-type rank order is identical to
  S — the expected signature of a real algorithm, not one tuned to S. New
  streaming harness `bench/run-m.cjs` with segment support (M_START/M_LIMIT).
- Docs: M results added to the benchmark sections (EN/ZH) with the honest
  caveat that our M hit@5 76.6% and the paper's M-scale Recall@k numbers are
  near but not the same protocol — still no parity claim.

## 0.5.0 — 2026-08-20

Three bugs found by code review — two made features fail outright — fixed and
re-measured:

- **Fixed** the 8-token query window: query-head stopwords ("what did we
  decide about the…") crowded out content words and even out-weighted them
  in the merge. Tokenization is now content-word-first, stopwords fill
  leftover slots. LongMemEval-S hit@1 54.6% → **74.8%** (MRR 0.636 →
  0.812); LoCoMo10 hit@1 43.7% → **53.2%** (MRR 0.568 → 0.651).
  Weak types: assistant-quoted hit@1 17.9% → 51.8%, preference 26.7% →
  33.3%, temporal 46.6% → 75.9%.
- **Fixed** empty tokens matching every note: a pure-Chinese query
  tokenized to zero tokens and `noteMatches` fell back to
  `text.includes("")` — returning the entire notes store. Empty tokens now
  match nothing.
- **Fixed** note append corruption: a hand-edited `notes.jsonl` missing its
  trailing newline had the next record concatenated onto the last line,
  silently losing both. Appends now insert the missing newline.
- **New** honest CJK handling: `memo_search` returns a `cjkWarning` for
  Chinese queries (the backend's unicode61 index treats contiguous CJK runs
  as single tokens; index-side fix belongs upstream).
- **Benchmarks** — LongMemEval-CN cross-lingual harness (`cn.cjs`): Chinese
  questions over the original English haystacks, hit@1 33.6% entirely from
  untranslated Latin tokens; translation is the gap, not tokenization.
  Deterministic time-aware retrieval measured in `exp3.cjs` and **rejected
  with published evidence**: hard `since` filtering hurts (temporal hit@1
  75.9% → 69.9%), soft/dual variants are neutral — matching the paper's own
  weak-model finding.

## 0.4.2 — 2026-08-20

- Docs: "Trust: the evidence trail" section — own-measured numbers, published
  rejected experiments, open self-corrections, stated scope, no strawman
  baselines; positioning statement and repo description updated.

## 0.4.1 — 2026-08-20

- Docs: Tools section expanded into a per-tool reference (parameter tables,
  return shapes, ordering and error semantics for `memo_search`, duplicate
  semantics for `memo_remember`, `memo_stats` output); README status line is
  now a policy ("no breaking API changes inside the 0.x line") instead of a
  version fact that drifts between releases.

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
