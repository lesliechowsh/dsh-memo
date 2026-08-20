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

## A note from the maintainer, before the claims

I started Memo because I kept getting burned by memory tools whose benchmark numbers I couldn't reproduce. So this project runs on one rule, stated plainly: **publish only what the shipped product measures, and publish the trail that produced it.** What that means in practice:

- **The benchmark harnesses are copies of the real pipeline** — page sizes, ranking, truncation — not a re-implementation of the idea. Same dataset bytes, same numbers; environment recorded. When I once caught the harness over-collecting candidates that the product could never see, the published numbers went *down* (0.3.1), not up.
- **Rejected experiments are published too.** The equal-weight bigram variant collapsed hit@1 to 5.2%; the wider per-term page wasn't worth 2× the API calls; a deterministic re-implementation of a time-aware expansion idea from a paper I respect made temporal recall *worse* — and that one is in the log with the exact numbers, because negative results are results.
- **My mistakes are in the CHANGELOG, not deleted.** Session ids read from the wrong field (0.3.0), titles silently nulled (0.3.1), and three bugs found by review in 0.5.0 — one of which, stopwords crowding content words out of the query window, meant the headline recall number was understated for two releases. Fixed, re-measured, and written down.
- **Limitations are stated where they hurt.** Session localization is not end-to-end answer accuracy. The two weakest question types are named with their numbers. The length-as-rarity weighting rests on an English regularity — long word ≈ content word — and does **not** transfer to Chinese; declared below, not hidden. Chinese queries hit the backend's unicode61 CJK limitation and get a `cjkWarning` instead of silent misses.
- **No strawman baselines, no borrowed numbers.** You will not find a comparison row for a process this product does not run, or a third-party self-reported figure presented as a reference.

If you find a number here that doesn't reproduce, that is the highest-value bug report this project can receive — please [open an issue](https://github.com/lesliechowsh/dsh-memo/issues).

## Requirements

- **DeepSeek Harness** with the `sessionQuery` service in the composition (shipped in the standard `web` profile).
- The deployment's session-query index must be open — if it is configured with `openAt: "never"`, session search is disabled and `memo_search` reports it honestly instead of guessing.
- **Chinese / CJK**: the backend's unicode61 FTS5 index treats contiguous CJK runs as single tokens, so Chinese sessions are searchable only by exact verbatim runs. `memo_search` returns a `cjkWarning` for Chinese queries; the fix is index-side and belongs upstream (see [`bench/`](bench/README.md)).
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
- **Two-layer recall** — phrase-first exact matches, then each question token and consecutive token pair matched as its own phrase, merged by summed weights (token length, pair length — a local rarity proxy). Query tokens are content-word-first: stopwords only fill leftover window slots. Question-style queries work, not just keywords.
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

Measured on three evaluations under the exact pipeline `memo_search` ships — phrase-first plus weighted token/pair merge, with the official backend's page-size truncation and representative-event ranking — reproduced in the harnesses over the same FTS5 engine class the backend uses. Full protocol, environment, and the variant-selection experiment log: [`bench/`](bench/README.md).

**LongMemEval-S** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813), 500 questions, 54-session haystacks per question):

**hit@1 74.8% · hit@5 89.8% · hit@10 95.2% · MRR 0.812**

| Question type | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 78.9% | 94.0% | 0.855 |
| temporal-reasoning | 133 | 75.9% | 91.0% | 0.820 |
| knowledge-update | 78 | 91.0% | 98.7% | 0.948 |
| single-session-user | 70 | 82.9% | 91.4% | 0.867 |
| single-session-assistant | 56 | 51.8% | 78.6% | 0.631 |
| single-session-preference | 30 | 33.3% | 60.0% | 0.435 |

**LoCoMo10** ([snap-research/LoCoMo](https://github.com/snap-research/LoCoMo), 1986 questions over 10 very long conversations, cross-dataset check):

**hit@1 53.2% · hit@5 80.4% · hit@10 91.1% · MRR 0.651**

**LongMemEval-CN cross-lingual** (Chinese questions over the original English haystacks): **hit@1 33.6%** — and that number comes entirely from Latin tokens left untranslated in the questions; pure-Chinese queries cannot match English sessions, and no tokenizer change fixes that (the gap is translation). `memo_search` detects Chinese queries and returns a `cjkWarning` about the backend's unicode61 CJK limitation instead of pretending; a Chinese-session evaluation corpus does not exist publicly yet.

**Scope — read these numbers for what they are:**

- These are **session-localization** hit@k numbers (does the gold session enter the top-k of ~54 and ~27-session pools), not end-to-end answer accuracy. Do not compare them with the end-to-end QA accuracy reported by systems like Mem0 / Zep / LangMem (LLM reader + judge pipelines) — that is a different quantity.
- **Random baselines for signal-to-noise**: on LongMemEval-S a random retriever gets hit@1 ≈ 1.9% (1/54); Memo's 74.8% is ≈ 40× that. On LoCoMo10 a random retriever gets hit@1 ≈ 3.7% (1/27); Memo's 53.2% is ≈ 14× that. **On LoCoMo10, prefer hit@1**: with ~27-session pools, random hit@10 is already ≈ 37%, so the hit@10 column carries little information there.
- **Not comparable to the LongMemEval paper's retrieval table.** Its BM25 (R@5 63–68%) and Contriever/Stella dense retrievers (R@5 72–76%) run on the 500-session M scale with Recall@k. Memo's hit@5 on the 54-session S scale is numerically similar — but the pool is ~10× smaller and hit@k is a looser protocol, so **no claim of parity with dense retrievers follows**. Memo is a sparse lexical retriever near its class's ceiling; it does not compete with vector/graph memory systems.
- **Known ceilings**: knowledge-update (hit@1 91.0%) works because question and evidence share words; assistant-quoted and preference questions (51.8% / 33.3%) are the lexical floor — their evidence often shares no words with the question, and no tokenizer or weight tuning closes a semantic gap.
- **English-specific assumption**: the length-as-rarity weighting ("long word ≈ content word") is an English statistical regularity. It does not transfer to Chinese (and the backend's unicode61 index has its own CJK limitation — see [Requirements](#requirements)).

## Roadmap

- [x] LoCoMo10 secondary benchmark
- [x] LongMemEval-CN cross-lingual benchmark (Chinese questions; translation gap measured)
- [x] Tag search and note deduplication
- [x] 0.5.0 bug fixes — content-word-first tokenization (hit@1 54.6% → 74.8%), empty-token note leak, newline-safe note append
- [x] Deterministic time-aware retrieval tested and rejected with published evidence (hard filtering hurts)
- [ ] Chinese-session evaluation corpus (blocked: none exists publicly; also needs upstream CJK-aware tokenization)
- [ ] End-to-end QA (retrieval + answer) on a 100-question subset — needs model-quota approval
- [ ] Dense retrieval for the lexical ceiling (assistant-quoted / preference types) — deliberately out of scope while "zero infrastructure" holds

## Support & contributing

- Questions and bug reports: [GitHub Issues](https://github.com/lesliechowsh/dsh-memo/issues)
- Reproduce the benchmark or add a new one: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md) — Memo never sends data off your machine; its only network-free dependency is the local DSH session store.

## License

MIT — see `LICENSE`.
