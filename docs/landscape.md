# Landscape notes — how the other memory products present themselves

Research snapshot, 2025-08-21. Raw evidence (README captures, PyPI JSON, config
sources) is archived in the researcher's local `~/rsrch/` directory; every
claim below has a link to the public source it was read from.

This is not a benchmark. It is a survey of *how the adjacent products describe
themselves* — what they promise on the first screen, what they disclose, and
what a new user actually has to bring to run them. We ran it to check the
honesty bar, not to score anyone.

## What I found

### Mem0 — honest about its own benchmark provenance

- README leads with a benchmark table (LOCOMO, LongMemEval, BEAM) and a
  badge wall; the first-screen numbers exist.
- The OSS version runs without an extra vector service by default (embedded
  Qdrant under `/tmp/qdrant`), so "zero external infra" is roughly true at
  install time.
- But it still **requires an OpenAI API key** — the pipeline uses an LLM to
  extract facts and embeddings to index them. Retrieval quality is a paid
  cloud dependency.
- The benchmark suite README is explicit that measured numbers come from the
  managed platform and that OSS self-hosts can't reproduce them. That is the
  disclosure standard worth copying: *the number belongs to the product you
  can actually run, and it says so.*
- Sources: [mem0ai/mem0](https://github.com/mem0ai/mem0),
  [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks).

### Zep — the open-source path narrowed to a managed product

- The main repo now says outright: "This repository is **not** Zep's product
  or service" — it is examples and integrations for Zep Cloud.
- Self-hosting the open-source line means Graphiti, which needs Neo4j or
  FalkorDB **plus an OpenAI key**. Community Edition is deprecated.
- Their eval README links to benchmark code that 404s, and the PyPI page for
  `zep-cloud` still points at the deprecated CE — a new user following the
  published path hits a dead end.
- Sources: [getzep/zep](https://github.com/getzep/zep),
  [getzep/graphiti](https://github.com/getzep/graphiti).

### LangMem and Letta — no published quality numbers at all

- LangMem: `0.0.30` (2025-10-27 at capture time), README has no status line
  and no quality numbers; needs an LLM provider key and (for persistence) a
  Postgres store.
- Letta: the original repo became a landing page; the live code moved to
  `letta-ai/letta-code`, while the PyPI package name still installs the old
  line — a new user can easily install the wrong thing.
- Neither reports anything measurable about retrieval quality.
- Sources: [langchain-ai/langmem](https://github.com/langchain-ai/langmem),
  [letta-ai/letta](https://github.com/letta-ai/letta),
  [letta-ai/letta-code](https://github.com/letta-ai/letta-code).

## What this means for dsh-memo

1. **Our disclosure standard already clears the bar.** We publish only the
   shipped product's own measured numbers, with pool size and random baseline
   stated next to them, under a reproducible harness (`bench/`). Mem0's
   benchmark README is the same principle done well; Zep's 404 and Letta's
   renamed-package trap show the failure mode we must not drift into:
   published paths must stay walkable.
2. **"Zero infra" needs the same precision as benchmark claims.** Mem0's
   honest version is "no vector service to run, but bring an OpenAI key."
   Ours is "re-indexes nothing, but runs only inside DSH on its
   `sessionQuery` service." Both are true and both are narrower than the
   marketing word "zero infra" suggests. Keep stating ours in the README
   exactly as it is stated now.
3. **No competitor publishes end-to-end QA accuracy on a protocol we could
   fairly share**, so there is no honest comparative table to write — which
   is why the README has none. If someone ever publishes DSH-native numbers,
   that changes.

Re-check this file when a competitor ships a notable change (e.g. an OSS
version that runs without an LLM key, or honest QA numbers). The date at the
top must change with any update.
