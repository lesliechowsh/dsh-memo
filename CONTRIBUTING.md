# Contributing

Thanks for your interest. dsh-memo is a small plugin; the two highest-value
contributions are **more honest benchmarks** and **real-world recall bug
reports**.

## Reproduce the benchmark

Everything needed is in [`bench/`](bench/README.md):

1. Download the dataset (278 MB, the HF mirror works where HF is blocked):

   ```sh
   mkdir -p ~/bench && cd ~/bench
   curl -L -o longmemeval_s.json \
     https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
   ```

2. Run the harness (Node 22+, built-in `node:sqlite` FTS5):

   ```sh
   node bench/run.cjs            # full 500 questions
   LIMIT=10 node bench/run.cjs   # smoke
   ```

The harness must reproduce the retrieval pipeline the shipped `memo_search`
runs — see the protocol notes in `bench/README.md` and the inline comments in
`bench/run.cjs` before changing ranking logic. If you change the product
algorithm, change the harness in the same commit and re-measure; publish only
the product's own measured numbers.

## Code conventions

- `index.js` (npm plugin form, `ctx.tools.register` + `inject`) and
  `memo.host.js` (dynamic development form) must stay behaviorally in sync —
  update both in one commit.
- Contract gotchas that cost real bugs before (do not regress):
  - `searchSessions` hits are `SessionRecord = { header, live, persisted,
    bestMatch }` — the id lives at `hit.header.id`, not `hit.id`.
  - `searchEvents` hits carry `sessionId` directly.
  - `SessionHeader` has no title — fold via `readTitleSnapshots`.
  - Notes are appended raw, never rewritten from parsed rows.
  - No hardcoded machine paths or localhost URLs; `$DSH_HOME` resolves per
    tool execution via `shellEnv.collect(exec)`.
- Tool descriptions follow the tight standard: trigger front-loaded, one-line
  parameters, no implementation details.

## Releasing

- npm is the canonical package channel (no GitHub Packages); publish with a
  temporary `--userconfig` npmrc holding a 2FA-bypass automation token, and
  delete it afterwards.
- Tag the version commit and create a GitHub release whose notes link npm.

## Manual install (no CLI / no plugin UI)

The bundle mechanism is what makes install mount the plugin. Two files matter:

1. Edit `<DSH_HOME>/profiles/<name>/package.json` — add `dsh-memo` to
   `dependencies` and to the ordered `dsh.profile.bundles` list (the package
   declares `dsh.bundle.patch`, which makes the profile loader apply its
   `cordis.patch.yml` — that patch mounts the plugin row and nothing else;
   Memo reconfigures no platform setting):

   ```json
   {
     "name": "dsh-profile-web",
     "private": true,
     "dependencies": { "dsh-memo": "^0.10.1" },
     "dsh": { "profile": { "bundles": ["…existing bundles…", "dsh-memo"] } }
   }
   ```

2. Install the dependency into the profile (the profile is a pnpm workspace):

   ```sh
   cd <DSH_HOME>/profiles/<name> && pnpm install
   ```

3. Restart `dsh --profile <name>`.

Bundle order matters: layers apply in `bundles` order, then the profile's own
`cordis.patch.yml`. Memo's patch must come after the platform bundles (base /
web-app) so its `openAt` override wins; appending it last does that. A
deployment that wants search off overrides `openAt: never` again in the
profile's own `cordis.patch.yml`, which applies last.
