# Memo

[中文文档](./docs/README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](LICENSE)
[![status](https://img.shields.io/badge/status-beta-8B7E5A)](CHANGELOG.md)

**Your agent remembers everything you've done together — one plugin command, nothing else to run.**

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
      "mode": "phrase"
    }
  ],
  "notes": [],
  "limit": 10
}
```

> Agent: *"Yes — we researched it in the Weniger theme project: 'DESIGN DIETER RAMS' is a registered trademark, so the product was renamed Weniger…"*

## Install

```sh
dsh plugin --profile web add dsh-memo@latest
```

Restart `dsh web` — the three `memo_*` tools appear in your agent's tool list. That's the whole setup. (Uninstall: `dsh plugin --profile web remove dsh-memo`; manual profile-edit steps for CLI-less deployments are in [CONTRIBUTING.md](CONTRIBUTING.md).)

## What you get

- **Every past session, searchable.** Ask in plain language ("did we ever decide…?") and get the matching session, snippet, and evidence back in one tool call.
- **Nothing else to run.** No vector database, no embedding API, no API keys, no background indexer — it searches the corpus DSH already records, through the official `sessionQuery` backend.
- **Everything stays local.** Sessions stay in DSH's store; your distilled notes are one human-readable JSONL file.

Memo deliberately does not re-index your history into its own store. If you need cross-app memory outside DSH with embedding-based search, projects like Mem0 or Letta are built for that.

## Tools

### `memo_search(query, limit?, sessionId?, since?, tags?)`

Search every past session in the workspace plus your memo notes. `limit` defaults to 10 (cap 50); `sessionId` restricts to one session; `since` filters by epoch-ms; `tags` filters notes by tag. Returns `{ sessions, notes, limit }`:

- `sessions`: `{ sessionId, title (null when untitled), snippet, time, mode }` — ordered phrase-first, then by weighted token/pair score; `mode` is `"phrase"` (verbatim question hit) or `"terms"`.
- `notes`: most recent matches, newest last.
- When the deployment's session-query index is closed or the service is missing, the result carries an `error` string instead of fabricated hits — and Chinese queries carry a `cjkWarning` (see [Requirements](#requirements)).

### `memo_remember(text, tags?)`

Write one durable note — facts, decisions, preferences that survive across sessions and appear in `memo_search` results. Returns `{ ok, note, path }`; identical text returns the existing note as `{ ok: true, duplicate: true, note }` instead of appending. Notes are one JSONL record per line at `$DSH_HOME/memo/notes.jsonl`.

### `memo_stats()`

Corpus overview, no parameters: `{ sessions: 19, recent: […], notes: 4 }`.

## How it works

```
  memo_search(query)
   1. phrase step    whole query as one FTS5 phrase → top 10 sessions
   2. weighted step  ≤8 tokens + consecutive pairs, top 10 each,
                     merged by summed weights (token/pair length),
                     time-desc tiebreak — content words fill the
                     window first, stopwords only leftovers
   3. phrase first, then weighted, dedup, top 10
                    ── official sessionQuery (FTS5) ──
        DSH session corpus (live + persisted events)   + notes.jsonl
```

Memo re-indexes nothing: DSH's `sessionQuery` service is the single source of truth.

## Usage

The agent reaches for `memo_search` by itself when the answer depends on history ("Did we ever discuss SSH-based coding agents?"). Filter when you know the neighborhood: `memo_search(query: "benchmark", since: 1787000000000)`. Write distilled facts with `memo_remember(text: …, tags: "naming,convention")`, find them later with `memo_search(query: "naming", tags: "convention")`.

## Design & research grounding

Memo maps onto the memory taxonomy of [Memory for Large Language Models](https://arxiv.org/abs/2607.25380) (Zhoubian, Zhang, Kharlamov & Tang — THUNLP · Tsinghua / NUS): **explicit** representation (independently addressable JSONL), **online** updates (DSH appends as it happens), **long-term** persistence.

## Benchmark

Measured under the exact pipeline `memo_search` ships — reproduced in harnesses over the same FTS5 engine class the backend uses. Full protocol, environment, and the variant-selection experiment log: [`bench/`](bench/README.md).

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

**LoCoMo10** (1986 questions, cross-dataset check): **hit@1 53.2% · hit@5 80.4% · MRR 0.651** — read hit@1 there, not hit@10 (see below).

**LongMemEval-CN cross-lingual** (Chinese questions over the original English haystacks): **hit@1 33.6%**, entirely from Latin tokens left untranslated in the questions — the gap is translation, not tokenization. A Chinese-session evaluation corpus does not exist publicly yet.

**Scope — read these numbers for what they are:**

- Session-localization hit@k (~54 / ~27-session pools), not end-to-end answer accuracy — not comparable to Mem0 / Zep / LangMem (LLM reader + judge pipelines).
- Signal-to-noise: random hit@1 is ≈1.9% on S (54 sessions), ≈3.7% on LoCoMo (~27); Memo's 74.8% / 53.2% are ≈40× / ≈14× that. LoCoMo's random hit@10 is already ≈37%.
- Not comparable to the LongMemEval paper's retrieval table (BM25 R@5 63–68%, Contriever/Stella R@5 72–76% on the 500-session M scale, Recall@k protocol). No claim of parity with dense retrievers; Memo is a sparse lexical retriever near its class's ceiling.
- Known ceilings: assistant-quoted (51.8%) and preference (33.3%) questions are the lexical floor — their evidence often shares no words with the question.
- The length-as-rarity weighting ("long word ≈ content word") is an English statistical regularity; it does not transfer to Chinese.

## A note from the maintainer, before the claims

I started Memo because I kept getting burned by memory tools whose benchmark numbers I couldn't reproduce. So this project runs on one rule: **publish only what the shipped product measures, and publish the trail that produced it.**

- **The harnesses are copies of the real pipeline** — page sizes, ranking, truncation. Same dataset bytes, same numbers. When I caught the harness over-collecting candidates the product could never see, the published numbers went *down* (0.3.1), not up.
- **Rejected experiments are published too.** Equal-weight bigrams collapsed hit@1 to 5.2%; a wider per-term page wasn't worth 2× the API calls; a deterministic re-implementation of a time-aware expansion idea from a paper I respect made temporal recall *worse* — negative results are results, so they're in the log with the exact numbers.
- **My mistakes are in the CHANGELOG, not deleted.** Session ids read from the wrong field (0.3.0); titles silently nulled (0.3.1); three review-found bugs in 0.5.0, one of which — stopwords crowding content words out of the query window — had the headline recall number understated for two releases. Fixed, re-measured, written down.
- **Limitations are stated where they hurt.** The weak types are named with their numbers; the English-only weighting assumption and the CJK backend limitation are declared above, not hidden.
- **No strawman baselines, no borrowed numbers.**

If you find a number here that doesn't reproduce, that is the highest-value bug report this project can receive — please [open an issue](https://github.com/lesliechowsh/dsh-memo/issues).

## Requirements

- **DeepSeek Harness** with the `sessionQuery` service (shipped in the standard `web` profile); the deployment's session-query index must be open — `memo_search` reports a closed index honestly instead of guessing.
- **Chinese / CJK**: the backend's unicode61 FTS5 index treats contiguous CJK runs as single tokens, so Chinese sessions are searchable only by exact verbatim runs; `memo_search` returns a `cjkWarning`. The fix is index-side and belongs upstream (details in [`bench/`](bench/README.md)).
- Notes need `$DSH_HOME` resolvable at tool-execution time. No other services, no API keys, no network calls.

## Roadmap

- [x] LoCoMo10 secondary benchmark · LongMemEval-CN cross-lingual benchmark
- [x] Tag search and note deduplication · 0.5.0 bug fixes (content-word-first tokenization, empty-token note leak, newline-safe append)
- [x] Deterministic time-aware retrieval tested and rejected with published evidence
- [ ] LongMemEval-M (500-session pools) as a scale / anti-overfitting check — in progress
- [ ] Chinese-session evaluation corpus (blocked: none exists publicly; needs upstream CJK-aware tokenization)
- [ ] End-to-end QA (retrieval + answer) — needs model-quota approval
- [ ] Dense retrieval for the lexical ceiling — deliberately out of scope while "nothing else to run" holds

## Support & contributing

- Questions and bug reports: [GitHub Issues](https://github.com/lesliechowsh/dsh-memo/issues)
- Reproduce the benchmark or add a new one: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md) — Memo never sends data off your machine.

## License

MIT — see `LICENSE`.

## For agents reading this file

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
