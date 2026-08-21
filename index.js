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

  // ---------- A-prime engine (0.12.0; persisted + boot-safe in 0.12.1) ----------
  // Process-local inverted index over conversation events, read through the
  // official exact-read APIs (listSessions/readSession — the backend-
  // independent tier that does NOT trigger the FTS reconcile; measured
  // 35-47 s per FTS call on this device class vs 85-527 ms per readSession).
  //
  // 0.12.1 boot-safety and persistence:
  //   - The index persists to $DSH_HOME/memo/index.json and boots LOAD it
  //     (seconds) instead of re-reading the corpus — 0.12.0 re-read 527 MB
  //     synchronously and blocked the Web UI for minutes after every
  //     restart (boot-availability rule).
  //   - Live sessions are skipped: the current conversation is already in
  //     the agent's context (maintainer practice — search targets
  //     cross-session, older content).
  //   - Injected workspace instructions (user/message texts starting with
  //     <system-reminder) are NOT indexed — they repeat in every session
  //     and polluted df/IDF statistics (dogfood finding, 2026-08-21).
  //   - Giant sessions (raw event count > GIANT_EVENTS) are indexed once
  //     and never re-read: a giant's readSession is a multi-minute
  //     synchronous server-side block (the read clones every event
  //     server-side) that no plugin-side chunking can split. Their content
  //     stays searchable up to the last index; cheaper sessions refresh on
  //     boot, throttled with work-scaled pauses.
  const INDEXED_TYPES = new Set(["user/message", "assistant/message", "compaction/summary", "session/title"]);
  const GIANT_EVENTS = 20000;
  const REMINDER_PREFIX = "<system-reminder";

  // Token sequence: ASCII word runs (len >= 1) + contiguous Han runs (>= 2)
  // as single tokens — the unicode61 behavior the FTS index had.
  function seqTokens(text) {
    const out = [];
    for (const m of String(text).toLowerCase().matchAll(/[a-z0-9]+|\p{Script=Han}+/gu)) {
      if (m[0].length >= 1) out.push(m[0]);
    }
    return out;
  }

  function occurrencesIn(t, p) {
    if (p.length === 0) return 0;
    let n = 0;
    outer: for (let i = 0; i + p.length <= t.length; i++) {
      for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) continue outer;
      n++;
    }
    return n;
  }

  // Searchable text of one indexed event. Message content is a block list;
  // text blocks carry the prose (tool-call blocks are machinery).
  function eventText(ev) {
    const data = ev && ev.data;
    if (data === undefined || data === null) return "";
    if (ev.type === "session/title") {
      const t = data.title ?? data.text;
      return typeof t === "string" ? t : "";
    }
    if (ev.type === "compaction/summary") {
      const t = data.summary ?? data.text;
      return typeof t === "string" ? t : "";
    }
    const message = data.message ?? data;
    const content = message && message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("\n");
  }

  function snippetAround(text, firstToken, width) {
    const t = String(text);
    if (t.length <= width) return t;
    const at = firstToken === undefined ? -1 : t.toLowerCase().indexOf(String(firstToken).toLowerCase());
    if (at < 0) return t.slice(0, width);
    const start = Math.max(0, at - Math.floor(width / 3));
    return t.slice(start, start + width);
  }

  function rankCmp(a, b) {
    return b.occ - a.occ || a.len - b.len || b.time - a.time ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || b.seq - a.seq;
  }

  // index = { sessions: Map(id -> { events, inverted, rawCount }) }
  const memoIndex = { sessions: new Map(), building: false, built: 0, total: 0, startedAt: 0, loaded: false };

  function indexSession(id, snap, rawCount) {
    const events = [];
    const inverted = new Map();
    let raw = 0;
    for (const ev of (snap && snap.events) || []) {
      raw++;
      if (!INDEXED_TYPES.has(String(ev.type))) continue;
      const text = eventText(ev);
      if (text === "" || text.startsWith(REMINDER_PREFIX)) continue;
      const tokens = seqTokens(text);
      if (tokens.length === 0) continue;
      const k = events.length;
      events.push({ text, tokens, len: Array.from(text).length, time: Number(ev.time) || 0, seq: Number(ev.seq) || 0, type: String(ev.type) });
      for (const t of new Set(tokens)) {
        let arr = inverted.get(t);
        if (arr === undefined) { arr = []; inverted.set(t, arr); }
        arr.push(k);
      }
    }
    memoIndex.sessions.set(String(id), { events, inverted, rawCount: rawCount !== undefined ? rawCount : raw });
  }

  // The npm form runs in the host process where process.env carries
  // DSH_HOME (fallback: HOME/.dsh). The dynamic dev sandbox has no process
  // and simply skips persistence (in-memory index only).
  function persistHome() {
    try {
      if (typeof process === "undefined" || !process.env) return null;
      const direct = process.env.DSH_HOME;
      if (typeof direct === "string" && direct !== "") return direct.replace(/\/+$/, "");
      const home = process.env.HOME;
      if (typeof home === "string" && home !== "") return home.replace(/\/+$/, "") + "/.dsh";
      return null;
    } catch (err) { return null; }
  }

  async function saveIndexFile() {
    const home = persistHome();
    if (home === null) return;
    const out = { version: 1, savedAt: Date.now(), sessions: {} };
    for (const [id, s] of memoIndex.sessions) {
      out.sessions[id] = { rawCount: s.rawCount, events: s.events.map((e) => [e.type, e.time, e.seq, e.text]) };
    }
    try {
      const target = await ctx.fs.resolve(home + "/memo/index.json");
      await ctx.fs.writeText(target, JSON.stringify(out));
    } catch (err) { /* persistence best-effort */ }
  }

  async function loadIndexFile() {
    const home = persistHome();
    if (home === null) return false;
    try {
      const target = await ctx.fs.resolve(home + "/memo/index.json");
      const raw = await ctx.fs.readText(target);
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.sessions !== "object") return false;
      for (const [id, rec] of Object.entries(parsed.sessions)) {
        const events = (rec && Array.isArray(rec.events) ? rec.events : []).map((row) => {
          const text = String(row[3] ?? "");
          return { type: String(row[0] ?? ""), time: Number(row[1]) || 0, seq: Number(row[2]) || 0, text, tokens: seqTokens(text), len: Array.from(text).length };
        });
        const inverted = new Map();
        events.forEach((ev, k) => {
          for (const t of new Set(ev.tokens)) {
            let arr = inverted.get(t);
            if (arr === undefined) { arr = []; inverted.set(t, arr); }
            arr.push(k);
          }
        });
        memoIndex.sessions.set(String(id), { events, inverted, rawCount: (rec && rec.rawCount) || events.length });
      }
      memoIndex.loaded = true;
      return true;
    } catch (err) { return false; }
  }

  async function buildIndexAll() {
    if (memoIndex.building) return;
    memoIndex.building = true;
    memoIndex.startedAt = Date.now();
    try {
      const records = await ctx.sessionQuery.listSessions();
      memoIndex.total = records.length;
      const haveIndex = await loadIndexFile();
      for (const rec of records) {
        const id = (rec.header && rec.header.id) ?? null;
        if (id === null) continue;
        const existing = haveIndex ? memoIndex.sessions.get(String(id)) : undefined;
        // Live sessions: skipped — their content is in the agent's context.
        if (rec.live === true) { memoIndex.built += 1; continue; }
        // Giants already indexed: never re-read (multi-minute sync block).
        if (existing !== undefined && existing.rawCount > GIANT_EVENTS) { memoIndex.built += 1; continue; }
        const sessionT0 = Date.now();
        try {
          indexSession(String(id), await ctx.sessionQuery.readSession(String(id)));
        } catch (err) { /* skip unreadable session */ }
        memoIndex.built += 1;
        // Boot-availability rule: yield to the host between sessions, with
        // a pause scaled to the work just done.
        const worked = Date.now() - sessionT0;
        await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(2000, worked))));
      }
      await saveIndexFile();
    } finally {
      memoIndex.building = false;
    }
  }

  // Lazily index NEW non-live sessions; cheap id-diff via listSessions.
  async function syncNewSessions() {
    if (memoIndex.building) return;
    let records;
    try { records = await ctx.sessionQuery.listSessions(); } catch (err) { return; }
    let added = false;
    for (const rec of records) {
      const id = (rec.header && rec.header.id) ?? null;
      if (id === null || rec.live === true) continue;
      if (memoIndex.sessions.has(String(id))) continue;
      try { indexSession(String(id), await ctx.sessionQuery.readSession(String(id))); added = true; } catch (err) { /* skip */ }
      memoIndex.built += 1;
      memoIndex.total += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (added) await saveIndexFile();
  }

  // The shipped ranking (exp6-validated): phrase-first, then df-proxy IDF
  // weighted merge with exact df from the index, time-desc tiebreak.
  async function engineSearch(query, limit, sessionId, since) {
    const phraseTokens = seqTokens(String(query));
    if (phraseTokens.length === 0) return { sessions: [] };
    const pool = [];
    for (const [id, s] of memoIndex.sessions) {
      if (sessionId !== undefined && id !== String(sessionId)) continue;
      pool.push([id, s]);
    }
    const scoped = {
      matching(phraseTokens2) {
        if (phraseTokens2.length === 0) return [];
        const out = [];
        for (const [id, s] of pool) {
          const evs = s.inverted.get(phraseTokens2[0]);
          if (evs === undefined) continue;
          let best = null;
          for (const k of evs) {
            const ev = s.events[k];
            if (since !== undefined && ev.time < since) continue;
            let occ;
            if (phraseTokens2.length === 1) {
              occ = 0;
              for (const t of ev.tokens) if (t === phraseTokens2[0]) occ++;
            } else {
              occ = occurrencesIn(ev.tokens, phraseTokens2);
            }
            if (occ === 0) continue;
            if (best === null || occ > best.occ || (occ === best.occ && (ev.len < best.len ||
              (ev.len === best.len && (ev.time > best.time || (ev.time === best.time && ev.seq > best.seq)))))) {
              best = { occ, len: ev.len, time: ev.time, seq: ev.seq };
            }
          }
          if (best !== null) out.push({ id, occ: best.occ, len: best.len, time: best.time, seq: best.seq });
        }
        return out;
      },
      df(term) {
        let n = 0;
        for (const [, s] of pool) if (s.inverted.has(term)) n++;
        return n;
      },
    };
    const phraseRanked = scoped.matching(phraseTokens).sort(rankCmp).slice(0, limit);
    const tokens = tokenize(String(query));
    const counts = new Map();
    const repTimes = new Map();
    if (tokens.length > 1) {
      const termLimit = Math.max(limit, 8);
      const phrases = [];
      for (const t of tokens) phrases.push([t, t.length]);
      for (let i = 0; i + 1 < tokens.length; i++) {
        phrases.push([tokens[i] + " " + tokens[i + 1], (tokens[i] + " " + tokens[i + 1]).length]);
      }
      const N = pool.length;
      const idfOf = (term) => Math.log((N + 1) / (1 + Math.min(scoped.df(term), 50)));
      for (const [phrase, lenWeight] of phrases) {
        const pts = phrase.split(" ");
        const isPair = pts.length === 2;
        const weight = isPair ? lenWeight * Math.max(idfOf(pts[0]), idfOf(pts[1])) : 4 * idfOf(pts[0]);
        for (const c of scoped.matching(pts).sort(rankCmp).slice(0, termLimit)) {
          if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + weight);
          else { counts.set(c.id, weight); repTimes.set(c.id, c.time); }
        }
      }
    }
    const tokenRanked = [...counts.keys()]
      .sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a)))
      .slice(0, limit);
    const merged = [];
    const seen = new Set();
    for (const c of [...phraseRanked, ...tokenRanked.map((id) => ({ id }))]) {
      if (!seen.has(c.id)) { seen.add(c.id); merged.push(c.id); }
    }
    const sessions = merged.slice(0, limit).map((id) => {
      const s = memoIndex.sessions.get(id);
      let rep = null;
      for (const k of s.inverted.get(phraseTokens[0]) || []) {
        const ev = s.events[k];
        if (since !== undefined && ev.time < since) continue;
        const occ = occurrencesIn(ev.tokens, phraseTokens);
        if (occ === 0 && !(phraseTokens.length === 1 && ev.tokens.includes(phraseTokens[0]))) continue;
        if (rep === null || occ > rep.occ || (occ === rep.occ && (ev.len < rep.len ||
          (ev.len === rep.len && (ev.time > rep.time || (ev.time === rep.time && ev.seq > rep.seq)))))) {
          rep = { ...ev, occ };
        }
      }
      const hit = {
        sessionId: id,
        title: null,
        // 0.12.2: clue-sufficiency — 1000 chars (~one full answer) instead of
        // 240, so the agent can answer from the result instead of shelling
        // out to read raw logs (observed in real use: the SSH test).
        snippet: rep ? snippetAround(rep.text, phraseTokens[0], 1000) : "",
        time: rep ? rep.time : null,
        seq: rep ? rep.seq : null,
        source: "event",
        mode: "phrase",
      };
      // Evidence: top-3 matching events straight from the index.
      const evHits = [];
      for (const k of s.inverted.get(phraseTokens[0]) || []) {
        const ev = s.events[k];
        if (since !== undefined && ev.time < since) continue;
        if (occurrencesIn(ev.tokens, phraseTokens) === 0 && !(phraseTokens.length === 1 && ev.tokens.includes(phraseTokens[0]))) continue;
        evHits.push(ev);
      }
      evHits.sort((a, b) => (b.occ ?? 0) - (a.occ ?? 0) || a.len - b.len || b.time - a.time);
      hit.events = evHits.slice(0, 3).map((ev) => ({ snippet: snippetAround(ev.text, phraseTokens[0], 600), time: ev.time, seq: ev.seq }));
      return hit;
    });
    return { sessions };
  }

  // Kick off the background build once, at plugin start.
  const buildPromise = buildIndexAll().catch(() => {});

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
        if (memoIndex.sessions.size === 0 && memoIndex.building) {
          // First build still running: wait for at least some coverage, then
          // search the partial index and disclose progress.
          await new Promise((resolve) => {
            const check = () => (memoIndex.built > 0 || !memoIndex.building) ? resolve() : setTimeout(check, 200);
            check();
          });
        }
        await syncNewSessions();
        const out = await engineSearch(args.query, limit, sessionId, since);
        result.sessions = out.sessions;
        await enrichTitles(result.sessions);
        if (memoIndex.building || (memoIndex.total > 0 && memoIndex.built < memoIndex.total)) {
          result.indexing = { indexed: memoIndex.built, total: memoIndex.total, note: "background build in progress; results cover indexed sessions so far" };
        }
        if (memoIndex.sessions.size === 0 && !memoIndex.building) {
          result.error = "session index empty (build failed or no sessions readable); notes search still active";
        }
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
