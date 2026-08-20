# Benchmark — session-retrieval evaluation

Reproduction guide for the numbers quoted in the root README. Three
evaluations: LongMemEval-S (primary), LoCoMo10 (secondary, cross-dataset),
LongMemEval-CN (cross-lingual — Chinese questions over English sessions).

## Data

### LongMemEval-S

The [LongMemEval](https://arxiv.org/abs/2410.10813) S variant (500 questions,
54-session haystacks each). HuggingFace is the official host; on networks
where it is unreachable, the mirror works:

```sh
mkdir -p ~/bench && cd ~/bench
curl -L -o longmemeval_s.json \
  https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
# 278,025,796 bytes
```

### LongMemEval-M (scale / anti-overfitting)

The M variant: 500 new questions with ~500-session haystacks each (~2.5 GB;
file name `longmemeval_m`, 2,745,274,681 bytes):

```sh
curl -L -o ~/bench/longmemeval_m.json \
  https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_m
```

```sh
node bench/run-m.cjs               # full 500 questions (~35 min on 4 cores)
M_START=0 M_LIMIT=100 node bench/run-m.cjs   # segmented runs; add segment
                                             # hit/mrr counts to merge
```

The M harness streams the file (never parses it whole — the first scanner
design double-counted braces and crashed at the V8 string limit; the fix is
documented in the file header).

The LoCoMo benchmark's in-tree 10-conversation release (1986 QA samples with
evidence turn ids), from the official repo:

```sh
curl -L -o ~/locomo10.json \
  https://raw.githubusercontent.com/snap-research/LoCoMo/master/data/locomo10.json
# 2,805,274 bytes
```

### LongMemEval-CN (cross-lingual)

The [shiliu-memory/longmemeval-cn](https://huggingface.co/datasets/shiliu-memory/longmemeval-cn)
archive ships Chinese translations of the 500 questions plus 识流's own
answer-evaluation results (CC BY 4.0 for the translations; upstream MIT for
the original questions — see its NOTICE.txt). It does **not** ship translated
haystacks, so this harness pairs the Chinese questions with the original
English haystacks from `longmemeval_s.json` via the `question_id` mapping:

```sh
curl -L -o ~/lmcn_results.jsonl \
  https://hf-mirror.com/datasets/shiliu-memory/longmemeval-cn/resolve/main/results.jsonl
# 216,228 bytes
```

## Run

```sh
node bench/run.cjs            # LongMemEval-S, full 500 questions
LIMIT=10 node bench/run.cjs   # LongMemEval-S smoke
node bench/locomo.cjs         # LoCoMo10, full 1986 questions
node bench/cn.cjs             # LongMemEval-CN cross-lingual, 500 questions
```

Requires Node 22+ (built-in `node:sqlite` FTS5 — the same engine class and
default unicode61 tokenizer as DSH's official session-query backend).

## Environment (the runs that produced the published numbers)

- Node.js v26.4.0 (built-in `node:sqlite`)
- SQLite 3.53.0 (FTS5, unicode61 tokenizer)
- Linux 6.1.145 (Android/Termux), aarch64, 4 cores
- No network or model calls during evaluation: pure deterministic retrieval —
  rerunning the harnesses with the same dataset bytes reproduces the exact
  numbers.

## Protocol (all harnesses)

The harnesses reproduce the retrieval pipeline the shipped `memo_search` runs,
with the official backend's (dsh-session-query-sqlite) semantics, not an
idealized variant:

1. **Phrase step** — the whole question as one quoted FTS5 phrase (the
   backend's inert-phrase semantics), returning the top `limit` (default 10)
   sessions containing the verbatim question.
2. **Weighted token/pair step** — the question is tokenized
   content-word-first: stopwords only fill the remaining slots of the
   8-token window (before 0.5.0, query-head stopwords such as "what did we
   decide about the…" crowded out discriminative words and even out-weighted
   them in the merge). Each token plus each consecutive token pair becomes
   its own quoted-phrase search, keeping the top `max(limit, 8)` sessions per
   phrase in backend order; sessions are merged by summed phrase weights —
   token length, pair string length — with time-desc tiebreak, sliced to
   `limit`. The weights are a local rarity proxy: the official API exposes no
   document frequency to weight by.
3. Phrase hits are listed first, then weighted hits, deduplicated, sliced to
   `limit` — the same order and truncation the product ships.

Backend ranking semantics (reimplemented in JS because the datasets expose
message text, not the backend's event rows):

- The backend indexes one FTS5 document per **event** (message / turn).
  Discovery uses the same class of query — a session is a candidate if any of
  its events matches the quoted phrase.
- Per session, one representative event wins (`event_rank = 1`) by
  `match_count DESC, document_length ASC, time DESC, seq DESC`, where
  `match_count` = contiguous occurrences of the phrase in that event's text
  and `document_length` = that event's codepoint length.
- Sessions rank by the representative event's
  `match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC`.
- Time proxy: LongMemEval — session datetime parsed from `haystack_dates`
  plus the in-session message index (messages carry no timestamps); LoCoMo10 —
  real per-session date strings ("1:56 pm on 8 May, 2023") plus in-session
  turn order.

Other protocol facts:

- Gold: LongMemEval — the question's `answer_session_ids` present in the
  haystack; LoCoMo10 — the sessions containing the answer's evidence turns
  (`dia_id`); CN — same as LongMemEval, via the `question_id` mapping.
- Metrics: hit@1 / hit@5 / hit@10 over sessions, MRR, with a per-type /
  per-category breakdown.
- Retrieval variants shipped in 0.4.0/0.5.0 were selected on LongMemEval-S
  and validated on LoCoMo10 as the held-out cross-dataset check; no separate
  tuning split exists for variant selection.
- These hit@k numbers (54-session S-scale, session granularity) are **not**
  comparable to the LongMemEval paper's Recall@k on its 500-session M scale,
  nor to end-to-end QA accuracy numbers reported by agent systems (Chronos,
  MemPalace etc.). The README states this scope explicitly.

### Reading the numbers (statistical context)

- **Random baselines**: LongMemEval-S pools have 54 sessions, so random
  hit@1 ≈ 1/54 ≈ 1.9% (Memo 74.8% → ≈40×); LoCoMo10 pools average ≈27
  sessions, so random hit@1 ≈ 1/27 ≈ 3.7% (Memo 53.2% → ≈14×). Random
  hit@10 on LoCoMo10 is already ≈ 37%, which is why the README points to
  hit@1 as the informative metric there.
- **Pool-size caveat**: Memo's hit@5 on the S scale (54-session pools) is
  numerically near the paper's dense retrievers on the M scale (500-session
  pools, Recall@k protocol) — but a ~10× smaller pool and a looser hit@k
  protocol make direct comparison invalid. No claim of parity with dense or
  vector/graph retrievers is made anywhere.
- **English-specific assumption**: the token/pair length weighting rests on
  the English regularity "long word ≈ content word". It does not transfer to
  Chinese; a Chinese-session evaluation would need its own weighting (and is
  blocked on upstream CJK tokenization anyway — see below).

## Results (shipped 0.8.0 pipeline)

- LongMemEval-S: hit@1 78.2% · hit@5 92.4% · hit@10 97.4% · MRR 0.8469.
- LongMemEval-M (anti-overfitting, 5×100 segmented): hit@1 54.6% · hit@5
  78.6% · hit@10 83.8% · MRR 0.6452 — random hit@1 ≈ 0.2%, so ≈ 273×
  random; every segment positive vs the 0.7.x algorithm.
- LoCoMo10: hit@1 60.2% · hit@5 87.2% · hit@10 93.5% · MRR 0.7183.
- LongMemEval-CN cross-lingual (see below): hit@1 44.6% with the shipped
  0.7.0 tokenizer (33.6% before CJK runs were added — they unblock the
  weighted step for mixed queries). All gains come from untranslated Latin
  tokens; pure-Chinese queries over English sessions cannot match, and no
  tokenizer change fixes that (the gap is translation).

## Why 0.8.0 changed the weighting (analyze.cjs evidence)

`analyze.cjs` decomposes misses with per-question diagnostics. On S:

- Discovery is near-perfect: 99.6% of gold sessions are already inside some
  per-phrase top-10 under the SAME phrase set. The loss is in the MERGE
  ranking, not in discovery.
- Miss causes (rank 0, n=24): near-miss 22 (gold at merged rank 11-31),
  no-anchor 1, discovered-cut 1, merge-cut 0. On this dataset the
  "lexical floor" narrative (gold shares no words with the question) is
  wrong for all but one question.
- Oracle ceilings over the same phrase set: perfect ranking of discovered
  sessions → 99.8% hit@1; IDF rerank of the top-10 lists (true df, harness
  oracle) → 97.6%. The product-feasible proxy version (0.8.0) measures
  78.2% — the oracle's remaining gap involves recipe details that differ
  from the product pipeline and is recorded as unexplained headroom, not
  quoted as reachable.
- LongMemEval-CN cross-lingual (see below): hit@1 44.4% with the shipped
  0.7.0 tokenizer (33.6% before CJK runs were added — they unblock the
  weighted step for mixed queries). All gains come from untranslated Latin
  tokens; pure-Chinese queries over English sessions cannot match, and no
  tokenizer change fixes that (the gap is translation).

## Chinese / CJK status (honest)

The official backend indexes with FTS5 `unicode61`, which treats contiguous
CJK runs as single tokens; there is no CJK segmentation or n-gram indexing.
Measured consequences:

- Chinese **sessions** are searchable only by exact verbatim runs — character
  or word-level recall does not exist. This is an index-side limitation of
  the upstream `session-query` backend, not something a plugin can fix
  without re-indexing (which would break Memo's "re-indexes nothing" core
  promise).
- Since 0.7.0, `memo_search` extracts the query's Han runs (len ≥ 2) as
  weighted phrases — matching the backend's own token granularity — so
  sessions sharing ANY verbatim run of a Chinese question are recalled.
  `cjkWarning` still reports the remaining limit (no sub-run tokens).
- The CN cross-lingual harness makes the translation gap measurable:
  variant A (pre-0.7.0 tokenizer) reaches 33.6% hit@1 purely via Latin
  tokens left untranslated in the questions; variant A2 (the shipped 0.7.0
  tokenizer) reaches 44.4% — the CJK runs unblock the weighted step for
  single-Latin-token mixed queries; variant B (CJK-only tokenizer) scores
  0.0% because Chinese runs cannot match English text. A Chinese-session evaluation corpus does not exist publicly yet
  (checked longmemeval-cn, MemLong, LoCoMo); once one exists — or once the
  upstream backend gains CJK-aware tokenization — the harness pattern here
  applies directly.
- Upstream tracking: `deepseek-ai/deepseek-harness` has issues disabled;
  the limitation is documented here until an upstream channel accepts it.

## Experiment log: final ceiling sweep (exp4) — falsifier outcome

`exp4.cjs` (S) / `exp4-m.cjs` (M segments) swept the last lexical axes:
STOP-list ablation, phrase-order loosening, and IDF weighting.

- STOP: A2 (+15 stopwords: ever/whether/discuss/last/week/have/has/had/will/
  your/my/me/our/their/some) moved S hit@1 74.8% → 75.6% (assistant-quoted
  51.8% → 60.7%). **Not shipped** — the premise (long questions crowded by
  query-head stopwords) does not transfer to the short queries agents
  actually issue, and benchmark gains are not the target anymore.
- Phrase-order loosening: a complete no-op on S (verbatim whole-question
  hits are too rare to occupy the phrase slot). Not shipped.
- IDF weighting (corpus-estimated document frequency): S hit@1 +4.4pp with
  the capped-50 proxy equal to oracle — but the M direction check was
  INCONSISTENT (3×50-question segments, proxy vs base hit@1: +34 / 0 / −4).
  **Not shipped.** The falsifier worked: S-scale gains failed the M
  direction-consistency test, exactly what the M harness exists for.

These experiments are kept as reproducible evidence; no variant shipped.
The benchmark epistemology (falsifier vs compass) is documented in the
project's AGENTS.md.

## Experiment log: stemming (exp5) — falsifier outcome

`exp5.cjs` (S) / `exp5-m.cjs` (M segments) tested stem-phrase expansion using
the authoritative `stemmer` npm package v2.0.1 (Titus Wormer, MIT; embedded
with attribution and validated against Martin Porter's official 23,531-word
vocabulary — 0 mismatches; the hand-rolled attempt was discarded after four
debug rounds in favor of the existing wheel).

- S1 (stems added without dedup): worse (hit@1 74.8% → 73.8%).
- S2 (deduped stems): S hit@1 76.0% (+1.2), MRR 0.8187 (+0.007), but hit@5
  −0.8 and preference −3.3.
- M direction check (3×50-question segments): hit@1 identical to base in all
  three segments; MRR deltas −0.001 / +0.000 / +0.007 — noise.

**Not shipped.** The S-scale gain did not survive the M check; recorded as
evidence that the shipped pipeline already covers this dataset's lexical
variation.

## Chinese functional regression (NOT a benchmark)

No public Chinese multi-session memory-retrieval corpus exists (checked:
longmemeval-cn ships questions+results only, MemLong's data repo is gone,
LoCoMo is English), so benchmark-level Chinese numbers stay blocked. Instead
`zh.cjs` is a self-built, deterministic, embedded regression set — 10
hand-written sessions, 11 multi-run queries whose gold sessions contain one
verbatim run each, plus one ceiling control with no verbatim run anywhere:

```sh
node bench/zh.cjs
```

Result: pre-0.7.0 tokenizer 0/11; the 0.7.0 CJK-run tokenizer 10/11 hit@1
(the ceiling control misses in both, demonstrating the run-granularity
limit). Same bytes, same numbers — but treat it as a functional test, never
as a published benchmark.

## Experiment log (variant selection evidence)

`exp.cjs` / `exp2.cjs` produced the 0.4.0 weighted-merge decision.
`exp3.cjs` tested deterministic time-aware retrieval after re-reading
LongMemEval §5.4 (its query-expansion gains are round-granularity,
index-side, and model-dependent — with Llama 3.1 8B expansion *hurts*).

Summary of measured variants (LongMemEval-S, same protocol otherwise):

| Variant | hit@1 | hit@5 | hit@10 | MRR | Verdict |
|---|---|---|---|---|---|
| V0 matched-term count (0.3.x) | 36.2% | 68.4% | 80.0% | 0.498 | replaced |
| V1 tokens + bigrams, equal weight | 5.2% | 22.8% | 40.8% | 0.135 | rejected — common pairs swamp the merge |
| V2 token-length weights | 46.6% | 74.8% | 84.8% | 0.586 | kept as component |
| V3 tokens + pairs ×2 | 50.8% | 72.4% | 81.0% | 0.600 | superseded by V6 |
| V4 wider per-term page (2× API) | 39.4% | 67.0% | 78.6% | 0.509 | rejected — costs 2× calls, gains little |
| V6 token + pair length weights (0.4.x) | 54.6% | 75.0% | 82.8% | 0.636 | shipped in 0.4.0 |
| **V6 + content-word-first window (0.5.0)** | **74.8%** | **89.8%** | **95.2%** | **0.812** | **shipped in 0.5.0** — the 0.4.x window let query-head stopwords crowd out content words |
| T1 date-word expansion (exp3) | 74.8% | 89.8% | 95.2% | 0.812 | no-op — date words are already window tokens |
| T2h hard `since` filter (exp3) | 72.4% | 87.0% | 92.0% | 0.785 | **rejected — wrong windows silently drop gold** (temporal subset 75.9 → 69.9 hit@1) |
| T2s soft time boost (exp3) | 74.8% | 89.8% | 95.2% | 0.812 | neutral — rejected (cost without gain) |
| T2m dual-path merge (exp3) | 74.2% | 89.4% | 94.6% | 0.805 | slightly negative — rejected |

Conclusion recorded here for honesty: deterministic time-aware expansion does
not pay on top of the 0.5.0 baseline; the paper's gains require index-side
date indexing and a temporal model, both outside Memo's architecture.

Cost note: the shipped variant issues up to 26 backend queries per
`memo_search` (8 token-df estimates + 8 tokens + 7 pairs + 3 evidence calls
for the top-3 hit sessions) instead of 8 — roughly 3× the backend calls of
0.3.x. The df estimates use capped-50 counts; if they fail, the pipeline
falls back to length weights. The 3 evidence calls (0.9.0) run strictly
after ranking and only add per-hit `events` — ranking is untouched, so all
numbers in this file remain valid for 0.9.0.

Latency blind spot (0.11.0, do not regress): these harnesses use an instant
in-process backend, so they measure recall but NEVER latency. A real
deployment measurement found DSH's session-query backend reconciles its
entire live corpus on every call (35-47 s/call on a phone-class device,
query-independent) — the shipped 27-call pipeline froze the host for
minutes. The shipped plugin now degrades defensively under a slow backend
(0.11.0); the ranking path these numbers measure is the full pipeline and
runs unchanged on healthy backends. The real-deployment smoke test must
include a latency check from now on.
