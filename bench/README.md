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

### LoCoMo10

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

## Results (shipped 0.5.0 pipeline)

- LongMemEval-S: hit@1 74.8% · hit@5 89.8% · hit@10 95.2% · MRR 0.8116.
- LoCoMo10: hit@1 53.2% · hit@5 80.4% · hit@10 91.1% · MRR 0.6508.
- LongMemEval-CN cross-lingual (see below): hit@1 33.6% — entirely from
  untranslated Latin tokens; pure-Chinese queries over English sessions
  cannot match, and no tokenizer change fixes that (the gap is translation).

## Chinese / CJK status (honest)

The official backend indexes with FTS5 `unicode61`, which treats contiguous
CJK runs as single tokens; there is no CJK segmentation or n-gram indexing.
Measured consequences:

- Chinese **sessions** are searchable only by exact verbatim runs — character
  or word-level recall does not exist. This is an index-side limitation of
  the upstream `session-query` backend, not something a plugin can fix
  without re-indexing (which would break Memo's "re-indexes nothing" core
  promise).
- `memo_search` therefore detects CJK in the query and returns a
  `cjkWarning` describing the limitation instead of pretending.
- The CN cross-lingual harness makes the translation gap measurable:
  variant A (shipped tokenizer) reaches 33.6% hit@1 purely via Latin tokens
  left untranslated in the questions (proper nouns, brands, numbers); variant
  B (CJK-run tokenizer) scores 0.0% because Chinese runs cannot match English
  text. A Chinese-session evaluation corpus does not exist publicly yet
  (checked longmemeval-cn, MemLong, LoCoMo); once one exists — or once the
  upstream backend gains CJK-aware tokenization — the harness pattern here
  applies directly.
- Upstream tracking: `deepseek-ai/deepseek-harness` has issues disabled;
  the limitation is documented here until an upstream channel accepts it.

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

Cost note: the shipped variant issues up to 15 backend queries per
`memo_search` (8 tokens + 7 pairs) instead of 8 — roughly 2× the backend
calls of 0.3.x.
