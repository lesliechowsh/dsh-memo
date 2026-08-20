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

Memo's architecture maps directly onto the memory taxonomy of [A Survey on the Memory Mechanism of Large Language Model based Agents](https://arxiv.org/abs/2404.13501) (Zhang et al., THUNLP · Tsinghua):

| Survey dimension | Memo |
|---|---|
| Memory sources | Agent-generated: DSH logs every message, tool call, and result as it happens |
| Memory form | External memory — plain JSONL logs and notes; no vector database, no weight training |
| Memory writing | Automatic (the session log is the write path) plus manual distillation via `memo_remember` |
| Memory reading | Retrieval-based read-out: full-text search with snippets, titles, and time filters (`memo_search`) |
| Memory management | Raw full memory in v1; summarization, compression, and forgetting are on the roadmap |

## Benchmark targets

LongMemEval-S (retrieval hit@k/MRR) primary, LoCoMo secondary. Results will be published in this README once available.

## License

MIT — see `LICENSE`.
