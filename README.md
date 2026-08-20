# Memo

[中文文档](./docs/README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](LICENSE)
[![status](https://img.shields.io/badge/status-beta-8B7E5A)](CHANGELOG.md)

**Your agent's memory of everything it ever did — across every session, with zero infrastructure.**

```yaml
project:    dsh-memo
domain:     agent memory / session retrieval
audience:   DSH (DeepSeek Harness) users who want their agent to remember
interfaces: three model tools — memo_search / memo_remember / memo_stats
runtime:    DSH host plugin (Node), no extra services, no vector DB
storage:    the official DSH session corpus + one plain JSONL notes file
status:     beta — API stable since 0.3, benchmarked, see CHANGELOG
support:    GitHub Issues
```

> **For** DSH users who need their agent to answer "what did we decide three days ago?" — **Memo is** a zero-infrastructure memory plugin that **turns the session corpus DSH already records into searchable memory**. Unlike external memory frameworks, it re-indexes nothing, stores nothing outside your machine, and runs on the official `sessionQuery` backend.

DeepSeek Harness already records every session, message, and tool call. Memo turns that corpus into searchable memory your agent can actually use: ask about anything from any past session, and get the evidence back in one tool call.

## Quick example

> You: *"我们之前聊过 Dieter Rams 的事吗？"*
> Agent calls `memo_search("Dieter Rams")` →

```json
{
  "sessions": [
    {
      "sessionId": "session-49924467-9cd1-414a-9998-f207782c72ad",
      "title": "Weniger 主题设计",
      "snippet": "…「DESIGN DIETER RAMS」是已注册商标，Rams Foundation 积极管理其姓名与遗产…",
      "time": 1787078839061,
      "seq": 391234,
      "source": "event",
      "mode": "phrase"
    }
  ],
  "notes": [],
  "limit": 10
}
```

> Agent: *"有——我们在 Weniger 主题项目里调研过：'DESIGN DIETER RAMS' 是注册商标，所以产品改名为 Weniger……"*

## Why Memo

- **Zero infrastructure** — no vector database, no embedding API, no background indexer. One plugin row, that's it.
- **The official corpus is the source of truth** — Memo re-indexes nothing; it queries DSH's own `sessionQuery` (FTS5) service. What DSH recorded is what you can recall.
- **Local-first** — every byte stays on your machine: sessions stay in DSH's store, notes are one human-readable JSONL file.
- **Honest numbers** — retrieval quality is measured on LongMemEval-S with a harness that reproduces the shipped algorithm, and published warts and all (see [Benchmark](#benchmark)). No cherry-picked baselines.

External memory frameworks (Mem0, Letta, etc.) embed and re-store your data in infrastructure they manage; Memo keeps DSH's own store as the single source of truth and adds nothing to operate. If you need cross-app memory outside DSH, those tools are the better fit.

## Requirements

- **DeepSeek Harness** with the `sessionQuery` service in the composition (shipped in the standard `web` profile).
- The deployment's session-query index must be open — if it is configured with `openAt: "never"`, session search is disabled and `memo_search` reports it honestly instead of guessing.
- Notes need `$DSH_HOME` resolvable at tool-execution time (standard on every DSH deployment).
- No other services, no API keys, no network calls.

## Install

```sh
dsh plugin --profile web add dsh-memo@latest
```

Restart `dsh web` — the three `memo_*` tools appear in your agent's tool list.

<details>
<summary>Deployments without the <code>dsh plugin</code> subcommand (manual)</summary>

1. `cd "$DSH_HOME/profiles/web" && npm install dsh-memo`
2. Append to the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: memo
         name: 'dsh-memo'
   ```

3. Restart `dsh web`.

</details>

Uninstall: `dsh plugin --profile web remove dsh-memo`.

## Tools

| Tool | What it does |
|---|---|
| `memo_search(query, limit?, sessionId?, since?)` | Search every past session plus your memo notes — snippets, titles, time filtering |
| `memo_remember(text, tags?)` | Write one durable note: facts, decisions, preferences that survive across sessions |
| `memo_stats()` | Corpus overview: session count, recent titles, note count |

## How it works

```
                       ┌─────────────────────────────────────────┐
  memo_search(query) ─▶│  1. phrase step   whole query, quoted    │
                       │     FTS5 phrase → top 10 sessions        │
                       │  2. term step     ≤8 tokens, top 10 each │
                       │     merged by matched-term count,        │
                       │     time-desc tiebreak                   │
                       │  3. phrase first, then terms, dedup, 10  │
                       └───────────────┬──────────────────────────┘
                                       │ official sessionQuery (FTS5)
                                       ▼
        DSH session corpus (live + persisted events)     notes.jsonl
                                       │                            │
                                       ▼                            ▼
                    sessions + titles + snippets          matched notes
```

- **Reads the official corpus** — DSH's `sessionQuery` service is the single source of truth; Memo re-indexes nothing, duplicates nothing.
- **Two-layer recall** — phrase-first exact matches, then per-term matches merged by matched-term count. Question-style queries work, not just keywords.
- **Notes are plain JSONL** at `$DSH_HOME/memo/notes.jsonl` — human-readable, editable, portable.

## Usage

### Recall anything from any session

Ask naturally — the agent reaches for `memo_search` when the answer depends on history:

> "Did we ever discuss SSH-based coding agents? What did we conclude?"

Filter by time or session when you know the neighborhood:

```
memo_search(query: "benchmark", since: 1787000000000)
memo_search(query: "theme tokens", sessionId: "session-49924467-…")
```

### Write durable notes

```
memo_remember(text: "Product naming: dsh- prefix + snake_case memo_* tools. No real-person names (Dieter Rams lesson).", tags: "naming,convention")
```

### Check the corpus

```
memo_stats()  →  { sessions: 19, notes: 4, recent: […] }
```

## Design & research grounding

Memo sits cleanly on the memory taxonomy of [Memory for Large Language Models](https://arxiv.org/abs/2607.25380) (Zhoubian, Zhang, Kharlamov & Tang — THUNLP · Tsinghua / NUS), which characterizes memory along three orthogonal axes:

| Axis | Memo |
|---|---|
| Representation | **Explicit** — independently addressable JSONL logs and notes, decoupled from model computation |
| Update dynamics | **Online** — DSH appends every message, tool call, and result as it happens; `memo_remember` writes distilled notes |
| Persistence | **Long-term** — survives context windows, sessions, and process restarts |

Writing (`memo_remember`) and reading (`memo_search`) follow the survey's memory-operation view; consolidation and compression are on the roadmap.

## Benchmark

Measured on [LongMemEval-S](https://arxiv.org/abs/2410.10813) (500 questions, 54-session haystacks per question), session-level retrieval under the exact pipeline `memo_search` ships — phrase-first plus per-term matched-count merge, with the official backend's page-size truncation and representative-event ranking — reproduced in the harness over the same FTS5 engine class the backend uses. Full protocol and environment: [`bench/`](bench/README.md).

**Overall: hit@1 36.4% · hit@5 68.4% · hit@10 80.0% · MRR 0.499**

| Question type | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 38.3% | 76.7% | 0.551 |
| temporal-reasoning | 133 | 33.8% | 69.9% | 0.486 |
| knowledge-update | 78 | 55.1% | 89.7% | 0.701 |
| single-session-user | 70 | 52.9% | 77.1% | 0.635 |
| single-session-assistant | 56 | 1.8% | 17.9% | 0.073 |
| single-session-preference | 30 | 16.7% | 43.3% | 0.279 |

**Scope:** this measures session localization — whether the gold session appears in the top-k — not end-to-end answer accuracy, which is a separate roadmap item. The weak types (assistant-quoted answers, preferences) are the known frontier.

## Roadmap

- [ ] LoCoMo secondary benchmark
- [ ] End-to-end QA (retrieval + answer) on a 100-question subset
- [ ] Better recall for preference-type questions
- [ ] Tag search and note deduplication

## Support & contributing

- Questions and bug reports: [GitHub Issues](https://github.com/lesliechowsh/dsh-memo/issues)
- Reproduce the benchmark or add a new one: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md) — Memo never sends data off your machine; its only network-free dependency is the local DSH session store.

## License

MIT — see `LICENSE`.
