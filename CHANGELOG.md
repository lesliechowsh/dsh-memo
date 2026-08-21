# Changelog

All notable changes to dsh-memo. Versions follow the npm release
history; benchmark numbers are measured on [LongMemEval-S and
LoCoMo10](bench/README.md) with the harnesses in this repo.

## 0.13.2 — 2026-08-22

- **Full README review (docs-only).** Fixed nine stale/contradictory spots
  left over from the A-prime migration: the architecture diagram and
  benchmark protocol line still said FTS5; Requirements still demanded the
  platform search index be open; "does not re-index" contradicted the
  persisted index; M numbers quoted 76.6%/52.6% instead of the measured
  78.6%/54.6%; the CJK limitation was attributed to the backend tokenizer
  when it is now Memo's own choice; the tools signature missed
  `snippetChars`; roadmap gained the 0.12.x/0.13.0 items; bench/README and
  CONTRIBUTING still described the 26-call FTS cost and the FTS-enabling
  patch. Also fixed: session hits from the weighted step were all labeled
  `mode: "phrase"` — they are now `"terms"` when the phrase step missed.

## 0.13.1 — 2026-08-22

- **Tool descriptions reviewed (writing-for-agents).** memo_search states the
  index boundary ("your current conversation is in your context and stays out
  of the index"), limit becomes "max session hits" (the old "per source" was
  wrong), snippetChars tightens to one line. memo_remember now states its
  one indispensable job — a fact or decision made in this conversation that
  must survive (the only immediate channel) — instead of a generic facts
  list. No behavior changes.

## 0.13.0 — 2026-08-22

- **`snippetChars`: the context knob belongs to the caller.** After the
  0.12.2 fixed-bump mistake and its 0.12.3 revert, snippet length becomes a
  `memo_search` parameter — default 240, clamped to 80-2000, applied to hit
  and evidence snippets alike. The agent decides how much context to pay
  for; the tool never grows snippets on its own. This is the general shape
  for agent-facing tools: presentation knobs are caller-owned, bounded, and
  default to the cheapest setting.

## 0.12.3 — 2026-08-22

- **Snippet length reverted to 240 (0.12.2's 1000/600 bump rolled back).**
  The bump was tuned to one observed case (the SSH test), and that case
  wanted the full turns — no fixed snippet size satisfies it. Snippet
  length does not affect ranking, so the benchmark falsifier never covered
  it, and n=1 is not a real-usage ruler. New standing rule: presentation
  parameters (snippet length, evidence count, result shape) are tuned only
  by a dogfood tally over several real queries — "could the returned
  snippet answer the query?" — never by a single case. The 0.12.2 patch
  simplification and notes repositioning stand; only the snippet size
  reverts.

## 0.12.2 — 2026-08-22

- **Clue sufficiency.** Hit snippets grow from 240 to 1000 characters and
  evidence snippets to 600 — real use showed the agent shelling out to
  bash/read to fetch full text after a correct hit (the SSH test); the
  bigger fragment answers directly and removes that fallback. This is the
  "make discovery excellent" direction, not a reader feature.
- **Bundle patch simplified to the plugin row only.** The
  session-query-sqlite override that enabled the platform FTS is removed —
  Memo makes zero FTS calls and should not reconfigure a platform feature
  upstream ships opt-in deliberately. Install docs (EN/ZH) rewritten to
  match.
- **Notes repositioned.** memo_remember's indispensable job is now stated
  precisely: the current conversation is not indexed (it is in context), so
  a decision made *now* that must survive into future sessions has exactly
  one immediate channel — the note. Everything that must be present in
  every session belongs in workspace instructions instead. Usage data on
  this deployment (1 test note ever) means notes stay a supporting tool,
  not a headline.

## 0.12.1 — 2026-08-21

- **Boot-safe persisted index.** 0.12.0 re-read the whole corpus at every
  startup (527 MB synchronously — the Web UI was unusable for minutes after
  each restart; boot-availability rule). The index now persists to
  `$DSH_HOME/memo/index.json` and boots LOAD it in seconds, then refresh in
  the background with work-scaled pauses between reads.
- **Workspace-instruction pollution fixed (dogfood finding, verified).**
  Every session log carries the injected AGENTS.md/system-reminder blocks as
  `user/message` events, and the A-prime engine indexed them like real
  conversation — any AGENTS.md vocabulary hit every session ("冯骥" surfaced
  sessions whose only match was the injected principles line) and df/IDF
  statistics were distorted by the every-session AGENTS.md text. Invisible
  to bench (no injected prompts in benchmark corpora) — caught only by
  real-use testing. Fix: `user/message` texts starting with
  `<system-reminder` are skipped at index time; the phantom hits are gone.
- **Live sessions are skipped** — the current conversation is already in
  the agent's context (maintainer practice: search targets cross-session,
  older content).
- **Giant-session policy.** A giant session's readSession is a multi-minute
  synchronous server-side block (the read clones every event server-side —
  verified against the backend source) that no plugin-side chunking can
  split. Sessions with a raw event count over 20,000 are indexed once and
  not re-read on later boots; their content stays searchable up to the last
  index. Cheaper sessions refresh on boot, throttled.

## 0.12.0 — 2026-08-21

- **A-prime engine: session search without FTS calls.** The FTS backend
  reconciles the whole live corpus on every call (measured 35-47 s/call on
  this phone-class deployment, query-independent), which made the FTS path
  unusable regardless of call count. memo_search now reads the corpus
  through the official exact-read APIs (listSessions/readSession — the
  backend-independent tier, 85-527 ms per session read) and answers from a
  process-local inverted index over conversation events. Corpus slice
  (measured on a 27-session / 527 MB deployment): 90.5% of bytes are
  assistant/chunk streaming deltas and ~3% tool machinery; the indexed
  slice is user/message + assistant/message + compaction/summary +
  session/title (~29 MB). Source-verified in dsh-agent-loop that every
  chunk folds into its assistant/message (sourceEventSeqs), so nothing is
  lost. Ranking unchanged and validated by exp6/exp6-m: LongMemEval-S
  hit@1 78.2% · hit@5 92.4% · MRR 0.8469; LongMemEval-M five segments
  54.6% · 78.6% · 0.6457 — numerically equal to the FTS-era numbers.
  Freshness (deliberate, per maintainer practice — search targets
  cross-session older content): the index builds once at startup in the
  background (results during the build disclose `indexing` progress), new
  sessions are indexed lazily once they appear in listSessions, and
  sessions that grew are re-read at restart. The 0.11.0 latency guard is
  retired with the FTS path (no FTS calls remain).

## 0.11.0 — 2026-08-21

- **Adaptive latency guard.** Measured on a real deployment with a timing
  probe: DSH's session-query backend reconciles its entire live corpus on
  EVERY `searchSessions`/`searchEvents` call — 35-47 s per call on a
  phone-class device, independent of the query — so the 27-call pipeline
  froze the host for minutes (two overlapping calls were observed at ~5 min,
  104% CPU). The guard times the first (phrase) call: over 4 s, the weighted
  step and evidence are skipped (phrase results only) and the next 5 minutes
  of searches skip the session side entirely; every backend call also runs
  against a 10 s total budget. Every degraded result carries a `degraded`
  field. Notes search is unaffected. On healthy backends the full pipeline
  runs unchanged — benchmark numbers stay valid. This is a defensive floor,
  not a fix: the constant per-call cost is upstream's (reconcile-per-call
  with no throttle and no count fast path); plugin-side call pruning cannot
  remove it. Root cause and measurements recorded in AGENTS.md.

## 0.10.2 — 2026-08-21

- Bundle-patch fix completing install-enables-search (see 0.10.0).

## 0.10.1 — 2026-08-21

- Bundle-patch manifest declaration fix (see 0.10.0).

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

## 0.7.3 — 2026-08-20

- LongMemEval-CN cross-lingual re-measured with the shipped 0.7.0 tokenizer
  (cn.cjs gained an A2 variant): hit@1 33.6% → **44.4%**, every question type
  up. Mechanism: for mixed queries with a single untranslated Latin token,
  the pre-0.7.0 tokenizer produced ≤1 tokens and skipped the weighted step;
  the CJK runs now push the token count above 1, so the Latin token actually
  gets queried. Pure-Chinese queries over English sessions still cannot match
  (translation remains the gap).

## 0.7.2 — 2026-08-20

- Experiment-only release, no user-visible change (stemmer variant
  recorded in bench/README).

## 0.7.1 — 2026-08-20

- CJK detection unified: the tokenizer now uses `\p{Script=Han}` (same as
  the cjkWarning check); previously it scanned `\u3400-\u9fff` (starts in
  Ext-A) — the two disagreed on rare characters.
- `findDuplicate` documented as O(n) per write (fine at current scale;
  a size/mtime-invalidated index is the future fix).

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
  S — the expected signature of a real algorithm, not one tuned to S.
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
  search (≈2× of 0.3.x).
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
- `bench/` now ships the LoCoMo10 harness (`locomo.cjs`).

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
