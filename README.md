# Memo

[中文文档](./README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](LICENSE)

Session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents — built directly on the official `sessionQuery` service, so every session you ever had is searchable memory. Local-first, zero infrastructure, no vector database.

## Tools

| Tool | What it does |
|---|---|
| `memo_search(query)` | Search every past session in this workspace plus your memo notes — snippets, titles, time filtering |
| `memo_remember(text, tags)` | Write one durable note: facts, decisions, preferences that survive across sessions |
| `memo_stats()` | Corpus overview: session count, recent titles, note count |

## Install

```sh
dsh plugin --profile web add dsh-memo@latest
```

Restart `dsh web`. The three `memo_*` tools appear in your agent's tool list.

Manual profile install (deployments without the `dsh plugin` subcommand):

1. `cd "$DSH_HOME/profiles/web" && npm install dsh-memo`
2. Append to the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: memo
         name: 'dsh-memo'
   ```

3. Restart `dsh web`.

## Where notes live

`memo_remember` appends to `$DSH_HOME/memo/notes.jsonl` — plain JSONL you can edit, back up, or delete freely.

## Design & research grounding

Memo sits cleanly on the memory taxonomy of [Memory for Large Language Models](https://arxiv.org/abs/2607.25380) (Zhoubian, Zhang, Kharlamov & Tang — THUNLP · Tsinghua / NUS), which characterizes memory along three orthogonal axes:

| Axis | Memo |
|---|---|
| Representation | **Explicit** — independently addressable JSONL logs and notes, decoupled from model computation |
| Update dynamics | **Online** — DSH appends every message, tool call, and result as it happens; `memo_remember` writes distilled notes |
| Persistence | **Long-term** — survives context windows, sessions, and process restarts |

Writing (`memo_remember`) and reading (`memo_search` retrieval with snippets, titles, and time filters) follow the survey's memory-operation view; consolidation and compression are the next milestone.

## Benchmark

Measured on [LongMemEval-S](https://arxiv.org/abs/2410.10813) (500 questions, 54-session haystacks per question), session-level retrieval with SQLite FTS5/BM25 — the same engine class as DSH's official session search:

| Query mode | hit@1 | hit@5 | hit@10 | MRR |
|---|---|---|---|---|
| Whole-question phrase (raw DSH semantics) | 0.2% | 0.2% | 0.2% | 0.002 |
| **Memo retrieval (phrase-first + tokenized merge)** | **86.6%** | **97.0%** | **98.8%** | **0.911** |

The gap is why Memo exists: the raw search API treats a query as one exact phrase, which question-style queries almost never match. `memo_search` fixes this by merging phrase hits with per-term matches ranked by matched-term count. For reference, the hybrid BM25+vector baseline reported by comparable tools is ~95% R@5 on the same benchmark.

Full protocol and harness: `bench/run.cjs` in the repository.

## License

MIT — see `LICENSE`.
