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
status:     beta — no breaking API changes inside the 0.x line; see CHANGELOG
support:    GitHub Issues
```

> **For** DSH users who need their agent to answer "what did we decide three days ago?" — **Memo is** a zero-infrastructure memory plugin that **turns the session corpus DSH already records into searchable memory**. Unlike external memory frameworks, it re-indexes nothing, stores nothing outside your machine, runs on the official `sessionQuery` backend — and publishes every benchmark number with the experiment trail that produced it.

DeepSeek Harness already records every session, message, and tool call. Memo turns that corpus into searchable memory your agent can actually use: ask about anything from any past session, and get the evidence back in one tool call.

## Quick example

> You: *"Did we ever discuss Dieter Rams?"*
> Agent calls `memo_search("Dieter Rams")` →

```json
{
  "sessions": [
    {
      "sessionId": "session-49924467-9cd1-414a-9998-f207782c72ad",
      "title": "Weniger theme design",
      "snippet": "…'DESIGN DIETER RAMS' is a registered trademark, and the Rams Foundation actively manages the name and estate…",
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

> Agent: *"Yes — we researched it in the Weniger theme project: 'DESIGN DIETER RAMS' is a registered trademark, so the product was renamed Weniger…"*

## Why Memo

- **Zero infrastructure** — no vector database, no embedding API, no background indexer. One plugin row, that's it.
- **The official corpus is the source of truth** — Memo re-indexes nothing; it queries DSH's own `sessionQuery` (FTS5) service. What DSH recorded is what you can recall.
- **Local-first** — every byte stays on your machine: sessions stay in DSH's store, notes are one human-readable JSONL file.
- **Honest numbers** — retrieval quality is measured on LongMemEval-S and LoCoMo10 with harnesses that reproduce the shipped algorithm, and published warts and all (see [Benchmark](#benchmark)). No cherry-picked baselines.

External memory frameworks (Mem0, Letta, etc.) embed and re-store your data in infrastructure they manage; Memo keeps DSH's own store as the single source of truth and adds nothing to operate. If you need cross-app memory outside DSH, those tools are the better fit.

## Trust: the evidence trail

The differentiator is not a claim — it's that every claim can be checked:

- **Every number is the shipped product's own.** The benchmark harnesses in [`bench/`](bench/README.md) reproduce the exact pipeline `memo_search` runs — page sizes, ranking, truncation — not an idealized variant. Rerun them with the same dataset bytes and you get the same numbers; the environment is recorded.
- **Rejected experiments are published.** The variant log shows the dead ends, not just the winner: equal-weight bigrams collapsed hit@1 to 5.2%, a wider per-term page wasn't worth 2× the API calls. You can see what was tried and why it lost.
- **Mistakes are corrected in the open.** CHANGELOG records the self-corrections: session ids read from the wrong field (0.3.0), titles silently nulled (0.3.1), benchmark numbers re-measured **down** when the harness was found to over-collect candidates (0.3.1), then **up** when the algorithm actually improved (0.4.0). No quietly rewritten history.
- **Scope is stated, not implied.** Session localization is not end-to-end answer accuracy; the weak question types are named; the 2× backend-call cost of the 0.4.0 algorithm is disclosed up front.
- **No strawman baselines.** You will never find a comparison row for a process this product does not run, or a third-party self-reported figure presented as a reference.

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

### `memo_search`

Search every past session in the workspace plus your memo notes.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | required | Search terms; matched against session text and memo notes. |
| `limit` | number | 10 (cap 50) | Max hits per source. |
| `sessionId` | string | — | Limit the search to one session (searches its events). |
| `since` | number | — | Only hits after this epoch-ms time. |
| `tags` | string | — | Comma-separated tags; a note must carry at least one to be returned. |

Returns:

```json
{
  "sessions": [
    {
      "sessionId": "session-49924467-…",
      "title": "Weniger theme design",   // null when the session has no title snapshot
      "snippet": "…matching text…",
      "time": 1787078839061,              // epoch ms of the matching event
      "source": "event",
      "mode": "phrase"                    // "phrase" = verbatim question hit, "terms" = weighted token/pair hit
    }
  ],
  "notes": [
    { "time": 1787212144789, "text": "…", "tags": ["release"] }
  ],
  "limit": 10
}
```

- `sessions` are ordered phrase-first, then by weighted token/pair score;
  `notes` are the most recent matches, newest last.
- When the deployment's session-query index is closed or the service is
  missing, the result carries an `error` string instead of fabricated hits.

### `memo_remember`

Write one durable note — facts, decisions, preferences that survive across
sessions and appear in `memo_search` results.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | required | The note — one concrete fact, decision, or preference. |
| `tags` | string | — | Comma-separated tags. |

Returns `{ ok, note, path }`; if a note with identical text already exists,
nothing is appended and the result is `{ ok: true, duplicate: true, note }`
with the existing note. Notes are one JSONL record per line at
`$DSH_HOME/memo/notes.jsonl`.

### `memo_stats`

Corpus overview — no parameters.

```json
{
  "sessions": 19,
  "recent": [{ "id": "session-…", "cwd": "…", "createdAt": 1787…, "title": "…" }],
  "notes": 4
}
```


## How it works

```
                       ┌─────────────────────────────────────────┐
  memo_search(query) ─▶│  1. phrase step   whole query, quoted    │
                       │     FTS5 phrase → top 10 sessions        │
                       │  2. weighted step  ≤8 tokens + pairs,    │
                       │     top 10 each, merged by summed        │
                       │     weights (token/pair length),         │
                       │     time-desc tiebreak                   │
                       │  3. phrase first, then weighted, dedup   │
                       └───────────────┬──────────────────────────┘
                                       │ official sessionQuery (FTS5)
                                       ▼
        DSH session corpus (live + persisted events)     notes.jsonl
                                       │                            │
                                       ▼                            ▼
                    sessions + titles + snippets          matched notes
```

- **Reads the official corpus** — DSH's `sessionQuery` service is the single source of truth; Memo re-indexes nothing, duplicates nothing.
- **Two-layer recall** — phrase-first exact matches, then each question token and consecutive token pair matched as its own phrase, merged by summed weights (token length, pair length — a local rarity proxy). Question-style queries work, not just keywords.
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

Re-writing the same text returns the existing note instead of duplicating it.
Find notes by tag:

```
memo_search(query: "naming", tags: "convention")
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

Measured on two datasets under the exact pipeline `memo_search` ships — phrase-first plus weighted token/pair merge, with the official backend's page-size truncation and representative-event ranking — reproduced in the harnesses over the same FTS5 engine class the backend uses. Full protocol, environment, and the variant-selection experiment log: [`bench/`](bench/README.md).

**LongMemEval-S** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813), 500 questions, 54-session haystacks per question):

**hit@1 54.6% · hit@5 75.0% · hit@10 82.8% · MRR 0.636**

| Question type | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 59.4% | 80.5% | 0.691 |
| temporal-reasoning | 133 | 46.6% | 74.4% | 0.587 |
| knowledge-update | 78 | 83.3% | 97.4% | 0.893 |
| single-session-user | 70 | 70.0% | 88.6% | 0.784 |
| single-session-assistant | 56 | 17.9% | 26.8% | 0.220 |
| single-session-preference | 30 | 26.7% | 53.3% | 0.378 |

**LoCoMo10** ([snap-research/LoCoMo](https://github.com/snap-research/LoCoMo), 1986 questions over 10 very long conversations, cross-dataset check):

**hit@1 43.7% · hit@5 73.7% · hit@10 87.3% · MRR 0.568**

**Scope:** these measure session localization — whether the gold session appears in the top-k — not end-to-end answer accuracy, which is a separate roadmap item. The retrieval algorithm shipped in 0.4.0 was selected on LongMemEval-S and validated on LoCoMo10; assistant-quoted and preference-type questions remain the weakest types.

## Roadmap

- [x] LoCoMo10 secondary benchmark
- [x] Tag search and note deduplication
- [x] Recall for weak types — weighted token/pair merge (0.4.0): assistant-quoted hit@1 1.8% → 17.9%, preference hit@1 16.7% → 26.7%
- [ ] End-to-end QA (retrieval + answer) on a 100-question subset — needs model-quota approval
- [ ] Further recall work on assistant-quoted and preference questions (they remain the frontier)

## Support & contributing

- Questions and bug reports: [GitHub Issues](https://github.com/lesliechowsh/dsh-memo/issues)
- Reproduce the benchmark or add a new one: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md) — Memo never sends data off your machine; its only network-free dependency is the local DSH session store.

## License

MIT — see `LICENSE`.
