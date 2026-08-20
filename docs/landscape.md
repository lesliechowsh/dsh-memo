# Landscape notes — how the other memory products present themselves

Research snapshot, 2026-08-21. Method: read-only survey of official READMEs,
docs, PyPI pages, and eval directories — nothing installed or run. Every
number below records *how the product reports itself*; none of it is used as
a reference row for dsh-memo. Raw evidence (README captures, PyPI JSON, mem0
config sources, Zep quickstart HTML, eval directory listings) is archived in
the researcher's local `~/rsrch/` directory.

This is not a benchmark. It is a survey of presentation — what each product
promises on the first screen, what a new user must bring to run it, and how
honestly its quality numbers are scoped.

## 1. Time from zero to "write once, read it back"

| Product | Steps | Hard dependencies |
|---|---|---|
| [Mem0](https://github.com/mem0ai/mem0) | 3 (`pip install mem0ai` → `Memory()` → `add`/`search`) | OpenAI key. README: "Mem0 requires an LLM to function", default `gpt-5-mini` + `text-embedding-3-small`. No separate vector service to run: `VectorStoreConfig` defaults to embedded Qdrant at `/tmp/qdrant`; history in `~/.mem0/history.db`. Hybrid search needs `mem0ai[nlp]` + a spaCy model |
| [Zep](https://github.com/getzep/zep) | ≥6 (install SDK → sign up for a key → create user → thread → add messages → fetch context block) | **Mandatory cloud signup.** README's first line: "This repository is **not** Zep's product". Community Edition deprecated into `legacy/`. Self-hosting means [Graphiti](https://github.com/getzep/graphiti): Python 3.10+, Neo4j 5.26 / FalkorDB / Neptune + OpenSearch, and "an `OPENAI_API_KEY`" |
| [LangMem](https://github.com/langchain-ai/langmem) | 3, ~15 lines | Two keys: `ANTHROPIC_API_KEY` + an embedding config (`dims: 1536`, `openai:text-embedding-3-small`). No database for the quickstart |
| [Letta](https://github.com/letta-ai/letta) | `npm i -g @letta-ai/letta-code` → `letta` → `/connect` with your model key | Ships its own harness, still needs an LLM provider |

dsh-memo: one `dsh plugin --profile web add dsh-memo@latest`, no key, no
service, no index. The nearest competitor needs at minimum an LLM/embedding
key; Zep self-hosted needs a graph database.

## 2. Data flow

- **Mem0**: LLM extracts "facts" (single-pass, ADD-only, never overwrites) →
  embedded Qdrant + `/tmp` persistence; retrieval fuses semantic + BM25 +
  entity match.
- **Zep**: messages flow into a cloud temporal knowledge graph (entities,
  facts with validity windows, episodes); retrieval mixes embeddings, BM25,
  and graph traversal. The production engine is closed-source.
- **LangMem**: writes into a LangGraph `BaseStore` namespace; semantic
  retrieval; the README footnote admits the quickstart store "will be lost
  on restart".
- **Letta**: memory blocks + MemFS ("All context … is tracked via git"),
  `/search` over full messages, `/doctor` audits memory quality.

All four copy the conversation into their own store and rewrite it through
an LLM before it can be found. Memo queries the DSH `sessionQuery` corpus
directly — no second copy, no extraction loss.

## 3. The first screen

- Mem0: badge wall (Trendshift, YC S24) + benchmark table (LoCoMo /
  LongMemEval / BEAM, tokens, p50 latency) + demo link — but the demo link
  302s to a login page.
- Zep/Graphiti: logo, arXiv badge, two GIFs, arXiv screenshot; the docs site
  has a playground and serves every page as both `.md` and `/llms.txt`
  (agent-friendly).
- LangMem: plain text + code, no images, no numbers, no demo; two
  copy-pasteable quickstarts.
- Letta: demo GIF + feature table + a live online demo at chat.letta.com.

## 4. How quality numbers are reported

- **Mem0**: the table states its protocol (single retrieval, `top_200`,
  "production-representative model stack") and adds: "Scores reflect Mem0's
  managed platform, which includes proprietary optimizations not available
  in the open-source SDK." The eval harness is open
  ([memory-benchmarks](https://github.com/mem0ai/memory-benchmarks):
  Ingest → Search → Evaluate, `--top-k 200`, LLM judge) but reproducing
  costs you the keys. This is the disclosure standard worth copying: *the
  number belongs to the product you can actually run, and it says so.*
- **Zep**: paper [arXiv 2501.13956](https://arxiv.org/abs/2501.13956) plus
  blog; `benchmarks/locomo` / `benchmarks/longmemeval` notebooks state
  "OpenAI and Zep keys are required".
- **LangMem / Letta**: no numbers at all.

Memo's posture: numbers are the shipped product's own, measured under a
published, reproducible harness (`bench/`), with pool size and random
baseline stated beside them — and the anti-overfitting M-scale check.
Different shape from Mem0's, same honesty direction.

## 5. Things that impressed / things that annoyed

Impressed: Mem0's open eval harness plus the explicit "OSS can't get these
numbers" disclosure; `mem0 init --agent` (four commands, no email/OTP);
Zep's `/llms.txt` + per-page `.md`; LangMem's "lost on restart" footnote
placed where you will actually step in it; Letta's git-managed memory and
`/doctor` self-audit.

Annoyed (the failure modes we must not drift into):

1. Zep's eval README links `[Code](kg_architecture_agent_memory)` → 404
   (the real directories are `locomo` / `longmemeval`).
2. The `zep-cloud` PyPI page still recommends the deprecated Community
   Edition and the old docs URL.
3. Letta's main repo became a landing page (V1 "should not be used in
   production") while the PyPI `letta` package still installs the old line
   — new users install the wrong thing.
4. LangMem sits at `0.0.30` (2025-10-27) with no status line in the README.
5. "First-screen benchmark table + demo that requires login" as a combo;
   quality evidence that is entirely LLM-as-judge with no human
   verification described.

## 6. What this means for dsh-memo

What stands (and stays): **zero infrastructure** (no key, no service, no
index rebuild), **direct query of the official corpus** (no second copy, no
extraction loss), **open evidence chain** (protocol + pool size + random
baseline + M-scale anti-overfitting). No competitor publishes numbers on a
protocol we could fairly share, so there is still no honest comparative
table to write — which is why the README has none.

What to adopt, and what we did about each:

1. *Numbers scoped to the runnable product, with the protocol stated* —
   already our posture; Mem0's wording is the reference phrasing if we ever
   restate it.
2. *Machine-readable docs* (Zep's `/llms.txt` pattern) — the README already
   carries a "for agents" appendix; a repo-root `llms.txt` was considered
   and skipped for now because the audience (DSH agents) reads the npm
   README, not a docs site. Revisit if we ever run a docs site.
3. *Limits stated where you will hit them* (LangMem) — already shipped: a
   CJK query returns a `cjkWarning` in the tool result itself, not only in
   docs.
4. *A first-screen demo* (Letta's GIF) — the 60-second try-it script
   (0.8.1) covers the scripted path; a GIF requires a client-side plugin
   this maintainer cannot run right now (approval flow unavailable).
   Recorded as blocked, not abandoned.
5. *Release-time verification of every link and install path* — adopted as
   a standing rule (AGENTS.md): the Zep 404 and the Letta renamed-package
   trap are exactly the drift to check for before each publish.

Re-check this file when a competitor ships a notable change (e.g. an OSS
version that runs without an LLM key, or honest QA numbers). The date at the
top must change with any update.
