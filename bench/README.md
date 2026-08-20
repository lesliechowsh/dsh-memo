# Benchmark — LongMemEval-S retrieval

Reproduction guide for the numbers quoted in the root README.

## Data

The [LongMemEval](https://arxiv.org/abs/2410.10813) S variant (500 questions,
54-session haystacks each). HuggingFace is the official host; on networks
where it is unreachable, the mirror works:

```sh
mkdir -p ~/bench && cd ~/bench
curl -L -o longmemeval_s.json \
  https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
# 278,025,796 bytes
```

## Run

```sh
node bench/run.cjs            # full 500 questions
LIMIT=10 node bench/run.cjs   # quick smoke run
```

Requires Node 22+ (uses the built-in `node:sqlite` FTS5 engine — the same
engine class and default unicode61 tokenizer as DSH's official session-query
backend).

## Environment (the run that produced the published numbers)

- Node.js v26.4.0 (built-in `node:sqlite`)
- SQLite 3.53.0 (FTS5, unicode61 tokenizer)
- Linux 6.1.145 (Android/Termux), aarch64, 4 cores
- No network or model calls: pure deterministic retrieval — rerunning the
  harness with the same dataset bytes reproduces the exact numbers.

## Protocol

The harness reproduces the retrieval pipeline the shipped `memo_search` runs,
with the official backend's (dsh-session-query-sqlite) semantics, not an
idealized variant:

1. **Phrase step** — the whole question as one quoted FTS5 phrase (the
   backend's inert-phrase semantics), returning the top `limit` (default 10)
   sessions containing the verbatim question.
2. **Tokenized step** — each question token (at most 8, length ≥ 2) as its own
   quoted-phrase search, keeping the top `max(limit, 8)` sessions per term in
   backend order; terms are merged and ranked by matched-term count with
   time-desc tiebreak, sliced to `limit`.
3. Phrase hits are listed first, then tokenized hits, deduplicated, sliced to
   `limit` — the same order and truncation the product ships.

Backend ranking semantics (reimplemented in JS because the dataset exposes
message text, not the backend's event rows):

- The backend indexes one FTS5 document per **event** (message). Discovery
  uses the same class of query — a session is a candidate if any of its
  events matches the quoted phrase.
- Per session, one representative event wins (`event_rank = 1`) by
  `match_count DESC, document_length ASC, time DESC, seq DESC`, where
  `match_count` = contiguous occurrences of the phrase in that event's text
  and `document_length` = that event's codepoint length.
- Sessions rank by the representative event's
  `match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC`.
- Time proxy: session datetime parsed from `haystack_dates` plus the
  in-session message index — LongMemEval messages carry no timestamps.

Other protocol facts:

- Gold = the question's `answer_session_ids` present in the haystack.
- Metrics: hit@1 / hit@5 / hit@10 over sessions, MRR, with a
  per-question-type breakdown.

Results (full run): hit@1 36.4% · hit@5 68.4% · hit@10 80.0% · MRR 0.4991.
