# Benchmark — session-retrieval evaluation

Reproduction guide for the numbers quoted in the root README. Two datasets:
LongMemEval-S (primary) and LoCoMo10 (secondary, cross-dataset validation).

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

## Run

```sh
node bench/run.cjs            # LongMemEval-S, full 500 questions
LIMIT=10 node bench/run.cjs   # LongMemEval-S smoke
node bench/locomo.cjs         # LoCoMo10, full 1986 questions
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

## Protocol (both harnesses)

The harnesses reproduce the retrieval pipeline the shipped `memo_search` runs,
with the official backend's (dsh-session-query-sqlite) semantics, not an
idealized variant:

1. **Phrase step** — the whole question as one quoted FTS5 phrase (the
   backend's inert-phrase semantics), returning the top `limit` (default 10)
   sessions containing the verbatim question.
2. **Weighted token/pair step** — each question token (at most 8, length ≥ 2)
   plus each consecutive token pair, each as its own quoted-phrase search,
   keeping the top `max(limit, 8)` sessions per phrase in backend order.
   Sessions are merged by summed phrase weights — token length, pair string
   length — with time-desc tiebreak, sliced to `limit`. The weights are a
   local rarity proxy: longer content words and verbatim pairs discriminate
   better than common short words, and the official API exposes no document
   frequency to weight by.
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
  (`dia_id`).
- Metrics: hit@1 / hit@5 / hit@10 over sessions, MRR, with a per-type /
  per-category breakdown.
- The retrieval variant shipped in 0.4.0 was selected by these measurements
  on LongMemEval-S and validated on LoCoMo10 as the held-out cross-dataset
  check; no separate tuning split exists for variant selection.

## Results

LongMemEval-S (full run): hit@1 54.6% · hit@5 75.0% · hit@10 82.8% · MRR 0.6363.
LoCoMo10 (full run): hit@1 43.7% · hit@5 73.7% · hit@10 87.3% · MRR 0.5678.

## Experiment log (variant selection evidence)

`exp.cjs` and `exp2.cjs` are the harnesses that produced the variant decision
behind the 0.4.0 algorithm. Summary of the measured variants (LongMemEval-S,
same protocol otherwise):

| Variant | hit@1 | hit@5 | hit@10 | MRR | Verdict |
|---|---|---|---|---|---|
| V0 matched-term count (0.3.x) | 36.2% | 68.4% | 80.0% | 0.498 | replaced |
| V1 tokens + bigrams, equal weight | 5.2% | 22.8% | 40.8% | 0.135 | rejected — common pairs swamp the merge |
| V2 token-length weights | 46.6% | 74.8% | 84.8% | 0.586 | kept as component |
| V3 tokens + pairs ×2 | 50.8% | 72.4% | 81.0% | 0.600 | superseded by V6 |
| V4 wider per-term page (2× API) | 39.4% | 67.0% | 78.6% | 0.509 | rejected — costs 2× calls, gains little |
| **V6 token-length + pair-length weights (shipped)** | **54.6%** | **75.0%** | **82.8%** | **0.636** | **shipped in 0.4.0** |

Cost note: the shipped variant issues up to 15 backend queries per
`memo_search` (8 tokens + 7 pairs) instead of 8 — roughly 2× the backend
calls of 0.3.x, for a hit@1 gain of +18.4pp on LongMemEval-S and +18.6pp on
LoCoMo10.
