// Memo (dsh-memo) — npm client-module form of the host tool plugin.
// Registers three model tools over the official sessionQuery service:
//   memo_search   — search every past session + memo notes
//   memo_remember — write one durable note (facts, decisions, preferences)
//   memo_stats    — corpus overview
// Notes live at $DSH_HOME/memo/notes.jsonl, resolved per execution via
// shellEnv.collect(exec) — no machine paths, no process access.
exports.name = "dsh-memo";
exports.inject = ["tools", "sessionQuery", "fs", "shellEnv"];

exports.apply = function (ctx) {
  let cachedNotesPath = null;

  function resolveNotesPath(exec) {
    if (cachedNotesPath !== null) return cachedNotesPath;
    try {
      const env = ctx.shellEnv.collect(exec);
      if (env !== null && typeof env === "object" && typeof env.DSH_HOME === "string" && env.DSH_HOME !== "") {
        cachedNotesPath = env.DSH_HOME.replace(/\/+$/, "") + "/memo/notes.jsonl";
        return cachedNotesPath;
      }
    } catch (err) { /* fall through */ }
    return null;
  }

  async function readNotes(path) {
    if (path === null) return [];
    try {
      const target = await ctx.fs.resolve(path);
      const text = await ctx.fs.readText(target);
      const rows = [];
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        try { rows.push(JSON.parse(t)); } catch (err) { /* skip malformed */ }
      }
      return rows;
    } catch (err) { return []; }
  }

  async function appendNote(path, record) {
    if (path === null) return false;
    try {
      const existing = await readNotes(path);
      existing.push(record);
      const target = await ctx.fs.resolve(path);
      await ctx.fs.writeText(target, existing.map((r) => JSON.stringify(r)).join("\n") + "\n");
      return true;
    } catch (err) { return false; }
  }

  const textOutput = () => ({
    schema: { type: "object", additionalProperties: true },
    render(args, value) {
      return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
    },
  });

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
      },
      required: ["query"],
    },
    output: textOutput(),
    async execute(args, exec) {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10;
      const result = { sessions: [], notes: [], limit };
      try {
        if (typeof args.sessionId === "string" && args.sessionId !== "") {
          const page = await ctx.sessionQuery.searchEvents({
            sessionId: args.sessionId,
            query: String(args.query),
            limit,
            ...(typeof args.since === "number" ? { filters: [{ kind: "time", from: args.since }] } : {}),
          });
          for (const hit of page.items || []) {
            result.sessions.push({ sessionId: args.sessionId, title: null, snippet: hit.snippet ?? "", time: hit.time ?? null, seq: hit.seq ?? null, source: "event" });
          }
        } else {
          const page = await ctx.sessionQuery.searchSessions({
            query: String(args.query),
            limit,
            ...(typeof args.since === "number" ? { eventFilters: [{ kind: "time", from: args.since }] } : {}),
          });
          const hits = page.items || [];
          const ids = [...new Set(hits.map((h) => h.id ?? h.sessionId).filter(Boolean))];
          const titles = {};
          try {
            const rows = await ctx.sessionQuery.readTitleSnapshots(ids);
            for (const row of rows || []) {
              const value = row && typeof row === "object" ? (row.value ?? row) : null;
              const id = value && (value.id ?? (value.header && value.header.id) ?? (value.session && value.session.id));
              const title = value && (value.title ?? (value.titleSnapshot && value.titleSnapshot.title));
              if (id !== undefined && id !== null) titles[String(id)] = typeof title === "string" ? title : null;
            }
          } catch (err) { /* titles are optional */ }
          for (const hit of hits) {
            const id = hit.id ?? hit.sessionId;
            const bm = hit.bestMatch || {};
            result.sessions.push({ sessionId: id ?? null, title: titles[String(id)] ?? null, snippet: bm.snippet ?? "", time: bm.time ?? null, seq: bm.seq ?? null, source: "event" });
          }
        }
      } catch (err) {
        result.error = "search failed: " + String((err && err.message) || err);
      }
      try {
        const q = String(args.query || "").toLowerCase();
        const notes = await readNotes(resolveNotesPath(exec));
        if (q !== "") {
          result.notes = notes.filter((n) => String(n.text || "").toLowerCase().includes(q)).slice(-limit).reverse();
        } else {
          result.notes = notes.slice(-limit).reverse();
        }
      } catch (err) { /* notes optional */ }
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
      const ok = await appendNote(path, record);
      return { ok, note: ok ? record : null, path };
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
          id: s.id ?? null,
          cwd: s.cwd ?? null,
          createdAt: s.createdAt ?? null,
          title: s.title ?? null,
        }));
      } catch (err) { /* keep zeros */ }
      const notes = await readNotes(resolveNotesPath(exec));
      return { sessions: sessionCount, recent, notes: notes.length };
    },
  });
};
