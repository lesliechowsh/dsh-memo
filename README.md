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

## Benchmark targets

LongMemEval-S (retrieval hit@k/MRR) primary, LoCoMo secondary. Results will be published in this README once available.

## License

MIT — see `LICENSE`.
