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

## Protocol

- One FTS5 document per haystack **session** (the unit `memo_search` returns).
- Query = the question text; gold = the question's `answer_session_ids`
  present in the haystack.
- Mode A: whole-question phrase — the raw semantics of the official search
  API (it quotes the query as one inert FTS5 phrase).
- Mode B: tokenized OR + bm25 ranking — what `memo_search` ships
  (phrase-first, then per-term matches merged by matched-term count).
- Metrics: hit@1 / hit@5 / hit@10 over sessions, MRR.

Results (full run): A = hit@5 0.2% · B = hit@5 97.0%, MRR 0.911.
