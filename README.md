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

The install only mounts the plugin — it does not reconfigure DSH. Memo answers from its own persisted index (see below) and makes zero calls to the platform's FTS search, which upstream ships opt-in for its own reasons.

## What you get

- **Every past session, searchable.** Ask in plain language ("did we ever decide…?") and get the matching session, snippet, and evidence back in one tool call.
- **Nothing else to run.** No vector database, no embedding API, no API keys, no background indexer — it searches the corpus DSH already records, through the official `sessionQuery` backend.
- **Everything stays local.** Sessions stay in DSH's store; your distilled notes are one human-readable JSONL file.

Memo deliberately does not re-index your history into its own store. If you need cross-app memory outside DSH with embedding-based search, projects like Mem0 or Letta are built for that.

## Tools

### `memo_search(query, limit?, sessionId?, since?, tags?)`

Search every past session in the workspace plus your memo notes. `limit` defaults to 10 (cap 50); `sessionId` restricts to one session; `since` filters by epoch-ms; `tags` filters notes by tag; `snippetChars` sets characters per snippet (default 240, clamped 80-2000) — raise it when the answer needs surrounding context, keep it low when your context budget is tight. The agent owns this knob; the tool never grows snippets by itself. Returns `{ sessions, notes, limit }`:

- `sessions`: `{ sessionId, title (null when untitled), snippet, time, mode }` — ordered phrase-first, then by weighted token/pair score; `mode` is `"phrase"` (verbatim question hit) or `"terms"`.
- `notes`: most recent matches, newest last.
- When the deployment's session-query index is closed or the service is missing, the result carries an `error` string instead of fabricated hits. Chinese queries get run-level recall (contiguous Han runs as weighted phrases) plus a `cjkWarning` describing the remaining limit — see [Requirements](#requirements).

### `memo_remember(text, tags?)`

Write one durable note — facts, decisions, preferences that survive across sessions and appear in `memo_search` results. Returns `{ ok, note, path }`; identical text returns the existing note as `{ ok: true, duplicate: true, note }` instead of appending. Notes are one JSONL record per line at `$DSH_HOME/memo/notes.jsonl`.

Its one indispensable job: the current conversation is deliberately not indexed (it is already in the agent's context), so when a decision made *now* must survive into future sessions, `memo_remember` is the only immediate channel — write it now, search it later. Use it sparingly for exactly that; rules that must be present in every session belong in your workspace instructions instead.

### `memo_stats()`

Corpus overview, no parameters: `{ sessions: 19, recent: […], notes: 4 }`.

## How it works

```
  memo_search(query)
   1. phrase step    whole query as one FTS5 phrase → top 10 sessions
   2. weighted step  ≤8 tokens (content words + CJK runs) +
                     merged by df-proxy IDF weights (term idf×4,
                     pair length × max idf; df estimated per query
                     with capped-50 counts, length fallback),
                     time-desc tiebreak — content words fill the
                     window first, stopwords only leftovers
   3. phrase first, then weighted, dedup, top 10
                    ── official sessionQuery (FTS5) ──
        DSH session corpus (live + persisted events)   + notes.jsonl
```

Memo does not build a second durable store: DSH's `sessionQuery` service is the single source of truth, read through its exact-read APIs. A search costs one `listSessions` (to spot new sessions) plus in-memory index lookups — zero FTS backend calls (0.12.0; earlier versions made up to 26, see CHANGELOG).

## Usage

### Try it in 60 seconds

After installing, ask your agent these three things in one conversation. Each
one needs memory of the *previous* exchange, so each exercises the search:

1. *"Remember this: npm is the only official release channel for this project."* (the agent writes a note)
2. *"What was the 'release channel' convention we wrote down?"* (the agent must recall it — `memo_search` finds the note)
3. *"Also remember: demo data lives in the bench directory."* then *"Where did we say the demo data lives?"* (a second round of the same loop)

You just experienced the whole product: write, recall, write, recall — no
setup beyond the install, no external service involved.

### Day-to-day

The agent reaches for `memo_search` by itself when the answer depends on history ("Did we ever discuss SSH-based coding agents?"). Filter when you know the neighborhood: `memo_search(query: "benchmark", since: 1787000000000)`. Write distilled facts with `memo_remember(text: …, tags: "naming,convention")`, find them later with `memo_search(query: "naming", tags: "convention")`. Every session hit carries a `snippet` (the best-matching event); the top 3 hits also carry `events` — up to 3 matching events each — so the agent can read the actual passage instead of a one-line match.

### Startup, freshness, and the slow backend

DSH's session-query FTS backend reconciles its whole live corpus on every call — on slow machines a single call can take tens of seconds. Memo does not use that path: it indexes the conversation events (user and assistant messages, compaction summaries, session titles — the authoritative record; streaming chunks are ~90% of raw bytes and fold into the indexed messages, source-verified) into an inverted index persisted at `$DSH_HOME/memo/index.json`. Boots load it in seconds; a background refresh then picks up new sessions with pauses between reads so the Web UI stays available. Injected workspace instructions (`<system-reminder` blocks) are not indexed — they repeat in every session and would pollute ranking. The current conversation is skipped (it is already in your agent's context), and very large sessions are indexed once rather than re-read at every boot (their reads are synchronous multi-minute server-side operations); searches over them cover content up to the last index. Notes search is unaffected and always current.

## Design & research grounding

Memo maps onto the memory taxonomy of [Memory for Large Language Models](https://arxiv.org/abs/2607.25380) (Zhoubian, Zhang, Kharlamov & Tang — THUNLP · Tsinghua / NUS): **explicit** representation (independently addressable JSONL), **online** updates (DSH appends as it happens), **long-term** persistence.

## Benchmark

Measured under the exact pipeline `memo_search` ships — reproduced in harnesses over the same FTS5 engine class the backend uses. Full protocol, environment, and the variant-selection experiment log: [`bench/`](bench/README.md).

**LongMemEval-S** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813), 500 questions, 54-session haystacks per question):

**hit@1 78.2% · hit@5 92.4% · hit@10 97.4% · MRR 0.847**

| Question type | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 78.2% | 96.2% | 0.863 |
| temporal-reasoning | 133 | 75.9% | 90.2% | 0.821 |
| knowledge-update | 78 | 96.2% | 98.7% | 0.972 |
| single-session-user | 70 | 88.6% | 97.1% | 0.933 |
| single-session-assistant | 56 | 64.3% | 87.5% | 0.745 |
| single-session-preference | 30 | 43.3% | 66.7% | 0.556 |

**LoCoMo10** (1986 questions, cross-dataset check): **hit@1 60.2% · hit@5 87.2% · MRR 0.718** — read hit@1 there, not hit@10 (see below).

**LongMemEval-M** (500 **new** questions, ~500-session pools — the scale / anti-overfitting check):

**hit@1 54.6% · hit@5 78.6% · hit@10 83.8% · MRR 0.645** (random hit@1 on this pool ≈ 0.2% → ≈ 273× random)

The S → M drop (hit@1 78.2% → 54.6%) tracks the ~10× larger pool; the
per-type rank order was verified identical across S and M under the 0.6.0
pipeline (the same pipeline structure 0.8.0 extends). The 0.8.0 weighting was
selected on S and confirmed positive on ALL five 100-question M segments
(measured segment by segment, not once after the fact).

**LongMemEval-CN cross-lingual** (Chinese questions over the original English haystacks): **hit@1 44.6%** (up from 33.6% before the 0.7.0 CJK tokenization — CJK runs unblock the weighted step for mixed queries, so single untranslated Latin tokens are now actually queried). Every gain still comes from those Latin tokens: pure-Chinese queries over English sessions cannot match, and the gap is translation, not tokenization. A Chinese-session evaluation corpus does not exist publicly yet.

**Scope — read these numbers for what they are:**

- Session-localization hit@k (~54 / ~27-session pools), not end-to-end answer accuracy — not comparable to Mem0 / Zep / LangMem (LLM reader + judge pipelines).
- Signal-to-noise: random hit@1 is ≈1.9% on S (54 sessions), ≈3.7% on LoCoMo (~27), ≈0.2% on M (~500); Memo's 78.2% / 60.2% / (M below) are ≈41× / ≈16× / ≈260× that. LoCoMo's random hit@10 is already ≈37%.
- On the M scale we now publish our own numbers: hit@5 76.6%. The paper's retrieval table (BM25 R@5 63–68%, Contriever/Stella R@5 72–76%) uses Recall@k over rounds; ours is session hit@k — close but not the same protocol, so **no parity claim**. Memo is a sparse lexical retriever near its class's ceiling.
- Known ceilings: assistant-quoted and preference questions are the lexical floor — their evidence often shares no words with the question (33.3% / 30.0% hit@1 on S / M).
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
- **Chinese / CJK**: the backend's unicode61 index stores contiguous Han runs as single tokens. Memo searches those runs as weighted phrases (0.7.0), so a session is found when any run of the query appears verbatim. Word-level search inside a run is impossible without an index-side tokenizer change — `memo_search` says so via `cjkWarning` (details in [`bench/`](bench/README.md)).
- Notes need `$DSH_HOME` resolvable at tool-execution time. No other services, no API keys, no network calls.

## Roadmap

- [x] LoCoMo10 secondary benchmark · LongMemEval-CN cross-lingual benchmark
- [x] Tag search and note deduplication · 0.5.0 bug fixes (content-word-first tokenization, empty-token note leak, newline-safe append)
- [x] Deterministic time-aware retrieval tested and rejected with published evidence
- [x] LongMemEval-M (500-session pools) scale / anti-overfitting check — hit@1 52.6%, type ranking identical to S
- [x] Chinese run-level recall (0.7.0) + built-in functional regression set (`bench/zh.cjs`, self-built, NOT a benchmark)
- [ ] Chinese-session evaluation corpus (blocked: none exists publicly; benchmark-level Chinese numbers need it) · word-level recall inside runs (blocked: upstream tokenizer change)
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
