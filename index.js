// Memo (dsh-memo) — npm client-module form of the host tool plugin.
// Registers three model tools over the official sessionQuery service:
//   memo_search   — search every past session + memo notes
//   memo_remember — write one durable note (facts, decisions, preferences)
//   memo_stats    — corpus overview
//
// Contract notes (do not regress):
//   - searchSessions hits are SessionRecord = { header, live, persisted, bestMatch };
//     the session id lives at hit.header.id, NOT hit.id.
//   - searchEvents hits carry sessionId directly.
//   - SessionHeader has no title; fold titles via readTitleSnapshots.
//   - Notes are appended raw (never rewritten from parsed rows) so hand-edited
//     or malformed lines survive.
//   - DSH_HOME resolves per execution via shellEnv.collect(exec) — no cache,
//     no machine paths.
exports.name = "dsh-memo";
exports.inject = ["tools", "sessionQuery", "fs", "shellEnv"];

exports.apply = function (ctx) {
  // Content words fill the 8-token window first; stopwords only fill the
  // remainder. The old inline tokenizer let query-head stopwords ("what did
  // we decide about the…") crowd out the discriminative words, and the
  // length-weighted merge even rewarded some of them.
  const STOP = new Set(["the", "a", "an", "and", "or", "what", "did", "do", "does", "is", "are", "was", "were", "to", "of", "in", "on", "at", "for", "with", "about", "we", "you", "i", "it", "this", "that", "how", "when", "where", "which", "why", "be", "been", "from", "by", "as", "there", "not", "can", "could", "should", "would", "just", "also"]);
  function tokenize(text) {
    const src = String(text).toLowerCase();
    const ascii = [...new Set(src.split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
    const content = ascii.filter((t) => !STOP.has(t));
    const stops = ascii.filter((t) => STOP.has(t));
    // CJK: the backend's unicode61 index tokenizes contiguous Han runs as
    // single tokens, so we extract the same runs (len >= 2) as query
    // phrases. Character-level recall inside a run is impossible without an
    // index-side change — exact runs only, which is still strictly more
    // than the old behavior (CJK queries produced zero tokens).
    const cjk = [];
    for (const m of src.matchAll(/\p{Script=Han}+/gu)) {
      const run = m[0];
      if (run.length >= 2 && !cjk.includes(run)) cjk.push(run);
    }
    return [...content, ...cjk, ...stops].slice(0, 8);
  }

  function resolveNotesPath(exec) {
    try {
      const env = ctx.shellEnv.collect(exec);
      if (env !== null && typeof env === "object" && typeof env.DSH_HOME === "string" && env.DSH_HOME !== "") {
        return env.DSH_HOME.replace(/\/+$/, "") + "/memo/notes.jsonl";
      }
    } catch (err) { /* fall through */ }
    return null;
  }

  async function readNotesText(path) {
    if (path === null) return "";
    try {
      const target = await ctx.fs.resolve(path);
      return await ctx.fs.readText(target);
    } catch (err) { return ""; }
  }

  function parseNotes(text) {
    const rows = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try { rows.push(JSON.parse(t)); } catch (err) { /* malformed lines survive on disk */ }
    }
    return rows;
  }

  async function appendNote(path, record) {
    if (path === null) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await readNotesText(path);
        // Hand-edited files may not end with a newline; without this the
        // next record concatenates onto the last line and both are lost.
        const sep = raw === "" || raw.endsWith("\n") ? "" : "\n";
        const target = await ctx.fs.resolve(path);
        await ctx.fs.writeText(target, raw + sep + JSON.stringify(record) + "\n");
        return true;
      } catch (err) { /* retry */ }
    }
    return false;
  }

  // Note writes are serialized per plugin instance (promise chain): the
  // dedup check + append run as one critical section, so concurrent
  // memo_remember calls in the same process cannot clobber each other.
  // Separate processes sharing one notes file remain racy (documented).
  let noteQueue = Promise.resolve();
  function enqueueNote(task) {
    const run = noteQueue.then(task, task);
    noteQueue = run.then(() => {}, () => {});
    return run;
  }

  // O(n) over the notes file per write — fine at current scale; a
  // size/mtime-invalidated index is the fix if notes ever grow large.
  async function findDuplicate(path, text) {
    const needle = String(text || "").trim().toLowerCase();
    if (needle === "") return null;
    const rows = parseNotes(await readNotesText(path));
    for (const row of rows) {
      if (String(row.text || "").trim().toLowerCase() === needle) return row;
    }
    return null;
  }

  function noteMatches(note, tokens, tags) {
    if (tokens.length === 0) return false; // empty tokens (e.g. pure-CJK query) must not match everything
    const text = String(note.text || "").toLowerCase();
    const textOk = tokens.length <= 1 ? text.includes(tokens[0] || "") : tokens.every((t) => text.includes(t));
    if (tags !== null && tags.length > 0) {
      const noteTags = Array.isArray(note.tags) ? note.tags.map((t) => String(t).toLowerCase()) : [];
      return textOk && tags.some((t) => noteTags.includes(t));
    }
    return textOk;
  }

  const textOutput = () => ({
    schema: { type: "object", additionalProperties: true },
    render(args, value) {
      return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
    },
  });

  async function enrichTitles(hits) {
    const ids = [...new Set(hits.map((h) => h.sessionId).filter((id) => id !== undefined && id !== null && id !== ""))];
    if (ids.length === 0) return;
    try {
      const rows = await ctx.sessionQuery.readTitleSnapshots(ids.map(String));
      const titles = {};
      for (const row of rows || []) {
        const obs = row && typeof row === "object" ? (row.value ?? row) : null;
        const id = obs && (obs.id ?? (obs.header && obs.header.id) ?? (obs.session && obs.session.id));
        const t = obs && obs.title;
        const title = typeof t === "string" ? t : (t && typeof t === "object" && typeof t.title === "string" ? t.title : null);
        if (id !== undefined && id !== null) titles[String(id)] = title;
      }
      for (const hit of hits) hit.title = titles[String(hit.sessionId)] ?? null;
    } catch (err) { /* titles optional */ }
  }

  async function phraseSearch(query, limit, sessionId, since) {
    if (sessionId !== undefined) {
      const page = await ctx.sessionQuery.searchEvents({
        sessionId,
        query: String(query),
        limit,
        ...(since !== undefined ? { filters: [{ kind: "time", from: since }] } : {}),
      });
      return (page.items || []).map((hit) => ({ sessionId, title: null, snippet: hit.snippet ?? "", time: hit.time ?? null, seq: hit.seq ?? null, source: "event", mode: "phrase" }));
    }
    const page = await ctx.sessionQuery.searchSessions({
      query: String(query),
      limit,
      ...(since !== undefined ? { eventFilters: [{ kind: "time", from: since }] } : {}),
    });
    return (page.items || []).map((hit) => {
      const bm = hit.bestMatch || {};
      return { sessionId: (hit.header && hit.header.id) ?? null, title: null, snippet: bm.snippet ?? "", time: bm.time ?? null, seq: bm.seq ?? null, source: "event", mode: "phrase" };
    });
  }

  async function tokenizedSearch(query, limit, since) {
    const tokens = tokenize(query);
    if (tokens.length <= 1) return [];
    // Phrase list: each token, then each consecutive token pair. Merge score
    // = sum of matched phrase weights (token length; pair string length) —
    // a local rarity proxy: longer content words and verbatim pairs
    // discriminate better than common short words.
    const phrases = [];
    for (const t of tokens) phrases.push([t, t.length]);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const pair = tokens[i] + " " + tokens[i + 1];
      phrases.push([pair, pair.length]);
    }
    const collected = new Map();
    for (const [phrase, weight] of phrases) {
      let page;
      try {
        page = await ctx.sessionQuery.searchSessions({
          query: phrase,
          limit: Math.max(limit, 8),
          ...(since !== undefined ? { eventFilters: [{ kind: "time", from: since }] } : {}),
        });
      } catch (err) { continue; }
      for (const hit of page.items || []) {
        const id = (hit.header && hit.header.id) ? String(hit.header.id) : "";
        if (id === "") continue;
        const bm = hit.bestMatch || {};
        const cur = collected.get(id);
        if (cur !== undefined) cur.count += weight;
        else collected.set(id, { sessionId: id, title: null, snippet: bm.snippet ?? "", time: bm.time ?? null, seq: bm.seq ?? null, source: "event", mode: "terms", count: weight });
      }
    }
    return [...collected.values()].sort((a, b) => (b.count - a.count) || ((b.time ?? 0) - (a.time ?? 0))).slice(0, limit);
  }

  ctx.tools.register({
    name: "memo_search",
    description: "Search every past session in this workspace plus your memo notes. Use it whenever answering depends on what was said, decided, or built in any earlier session.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms; matched against session text and memo notes." },
        limit: { type: "number", description: "Max hits per source. Default 10, cap 50." },
        sessionId: { type: "string", description: "Limit the search to this session." },
        since: { type: "number", description: "Only hits after this epoch-ms time." },
        tags: { type: "string", description: "Comma-separated tags; notes must carry at least one to be returned." },
      },
      required: ["query"],
    },
    output: textOutput(),
    async execute(args, exec) {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10;
      const since = typeof args.since === "number" ? args.since : undefined;
      const sessionId = typeof args.sessionId === "string" && args.sessionId !== "" ? args.sessionId : undefined;
      const result = { sessions: [], notes: [], limit };
      try {
        const phrase = await phraseSearch(args.query, limit, sessionId, since);
        const merged = [];
        const seen = new Set();
        for (const hit of phrase) {
          if (hit.sessionId === null || hit.sessionId === undefined) continue;
          seen.add(String(hit.sessionId));
          merged.push(hit);
        }
        if (sessionId === undefined) {
          for (const hit of await tokenizedSearch(args.query, limit, since)) {
            if (!seen.has(String(hit.sessionId))) {
              seen.add(String(hit.sessionId));
              merged.push(hit);
            }
          }
        }
        result.sessions = merged.slice(0, limit);
        await enrichTitles(result.sessions);
      } catch (err) {
        result.error = "search failed: " + String((err && err.message) || err);
      }
      try {
        const tokens = tokenize(args.query || "");
        const tags = typeof args.tags === "string" ? args.tags.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
        const notes = parseNotes(await readNotesText(resolveNotesPath(exec)));
        result.notes = notes.filter((n) => noteMatches(n, tokens, tags)).slice(-limit).reverse();
      } catch (err) { /* notes optional */ }
      if (/\p{Script=Han}/u.test(String(args.query || ""))) {
        result.cjkWarning = "query contains Chinese: recall works at the granularity of contiguous Han runs (the backend unicode61 index has no sub-run tokens); sessions are found when a run of the query appears verbatim, word-level search inside runs needs an upstream tokenizer change (see bench/README)";
      }
      return result;
    },
  });

  ctx.tools.register({
    name: "memo_remember",
    description: "Write one durable note to the memo store. Use for facts, decisions, preferences, and conventions that must survive across sessions; memo_search returns these notes.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note — one concrete fact, decision, or preference." },
        tags: { type: "string", description: "Comma-separated tags." },
      },
      required: ["text"],
    },
    output: textOutput(),
    async execute(args, exec) {
      const path = resolveNotesPath(exec);
      if (path === null) return { ok: false, error: "cannot resolve DSH home (shellEnv unavailable); memo notes need $DSH_HOME/memo/notes.jsonl" };
      const record = {
        time: Date.now(),
        text: String(args.text),
        tags: typeof args.tags === "string" ? args.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
      };
      return await enqueueNote(async () => {
        const existing = await findDuplicate(path, record.text);
        if (existing !== null) return { ok: true, duplicate: true, note: existing, path };
        const ok = await appendNote(path, record);
        return { ok, note: ok ? record : null, path };
      });
    },
  });

  ctx.tools.register({
    name: "memo_stats",
    description: "Corpus overview: total sessions, five most recent session titles, memo-note count.",
    parameters: { type: "object", properties: {} },
    output: textOutput(),
    async execute(args, exec) {
      let sessionCount = 0;
      let recent = [];
      try {
        const sessions = await ctx.sessionQuery.listSessions();
        sessionCount = sessions.length;
        recent = sessions.slice(0, 5).map((s) => ({
          id: (s.header && s.header.id) ?? null,
          cwd: (s.header && s.header.cwd) ?? null,
          createdAt: (s.header && s.header.createdAt) ?? null,
          title: null,
        }));
        await enrichTitles(recent);
      } catch (err) { /* keep zeros */ }
      const notes = parseNotes(await readNotesText(resolveNotesPath(exec)));
      return { sessions: sessionCount, recent, notes: notes.length };
    },
  });
};
