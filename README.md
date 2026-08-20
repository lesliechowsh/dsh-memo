# Memo

[中文文档](./README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](LICENSE)

**Your agent's memory of everything it ever did — across every session, with zero infrastructure.**

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

> Agent: *"有——我们在 Weniger 主题项目里调研过：'DESIGN DIETER RAMS' 是注册商标，所以产品改名为 Weniger，还查了 Braun 的诉讼记录……"*

## Tools

| Tool | What it does |
|---|---|
| `memo_search(query, limit?, sessionId?, since?)` | Search every past session plus your memo notes — snippets, titles, time filtering |
| `memo_remember(text, tags?)` | Write one durable note: facts, decisions, preferences that survive across sessions |
| `memo_stats()` | Corpus overview: session count, recent titles, note count |

## How it works

- **Reads the official corpus** — DSH's `sessionQuery` service is the single source of truth; Memo re-indexes nothing, duplicates nothing.
- **Two-layer recall** — phrase-first exact matches, then per-term matches merged by matched-term count. Question-style queries work, not just keywords.
- **Notes are plain JSONL** at `$DSH_HOME/memo/notes.jsonl` — human-readable, editable, portable.

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

Measured on [LongMemEval-S](https://arxiv.org/abs/2410.10813) (500 questions, 54-session haystacks per question), session-level retrieval under the exact algorithm `memo_search` ships — phrase-first plus per-term matched-count merge — reproduced in the harness over the same FTS5 engine class the official backend uses. Full protocol and environment: [`bench/`](bench/README.md).

**Overall: hit@1 45.8% · hit@5 75.4% · hit@10 84.4% · MRR 0.582**

| Question type | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 48.9% | 87.2% | 0.641 |
| temporal-reasoning | 133 | 39.1% | 72.9% | 0.540 |
| knowledge-update | 78 | 80.8% | 93.6% | 0.872 |
| single-session-user | 70 | 60.0% | 92.9% | 0.737 |
| single-session-assistant | 56 | 3.6% | 16.1% | 0.082 |
| single-session-preference | 30 | 16.7% | 56.7% | 0.321 |

**Scope:** this measures session localization — whether the gold session appears in the top-k — not end-to-end answer accuracy, which is a separate roadmap item. The weak types (assistant-quoted answers, preferences) are the known frontier.

## Roadmap

- [ ] LoCoMo secondary benchmark
- [ ] End-to-end QA (retrieval + answer) on a 100-question subset
- [ ] Better recall for preference-type questions
- [ ] Tag search and note deduplication

## License

MIT — see `LICENSE`.
