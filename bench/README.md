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
engine class as DSH's official session-query backend).

## Environment (the run that produced the published numbers)

- Node.js v26.4.0 (built-in `node:sqlite`)
- SQLite 3.53.0 (FTS5, unicode61 tokenizer)
- Linux 6.1.145 (Android/Termux), aarch64, 4 cores
- No network or model calls: pure deterministic retrieval — rerunning the
  harness with the same dataset bytes reproduces the exact numbers.

## Protocol

- One FTS5 document per haystack **session** (the unit `memo_search` returns).
- Query = the question text, tokenized into quoted OR terms (the same
  tokenized-merge semantics `memo_search` ships); ranked by BM25.
- Gold = the question's `answer_session_ids` present in the haystack.
- Metrics: hit@1 / hit@5 / hit@10 over sessions, MRR, with a per-question-type
  breakdown.

Results (full run): hit@1 86.6% · hit@5 97.0% · hit@10 98.8% · MRR 0.911.
