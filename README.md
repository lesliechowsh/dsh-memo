# Memo

[中文文档](./README.zh.md)

**Status: WIP (0.0.1 placeholder)** — the functional plugin lands in the first release; this package currently reserves the name.

Session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents — built directly on the official `sessionQuery` service, so every session you ever had is searchable memory:

- **`memo_search(query)`** — cross-session full-text recall with snippets, titles, and time filtering.
- **`memo_remember(text, tags)`** — distilled notes (decisions, preferences, facts) kept apart from raw logs.
- **`memo_stats()`** — corpus overview: session count, recent titles, note count.

Zero infrastructure, local-first, no vector database. Benchmark targets: LongMemEval-S (retrieval hit@k/MRR), LoCoMo.

## License

MIT — see `LICENSE`.
