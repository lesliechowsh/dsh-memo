// Memo (dsh-memo) — host-side dynamic plugin, canonical development form.
// Deployed in this process as plugin `memo-7`, pkg-16.
// Registers three model tools on the official sessionQuery service:
//   memo_search   — cross-session recall (phrase-first + tokenized merge)
//   memo_remember — distilled durable notes (facts, decisions, preferences)
//   memo_stats    — corpus overview
//
// Recall design: the official API quotes the whole query as one inert FTS5
// phrase, which question-style queries almost never match (LongMemEval-S
// hit@5 measured at 0.2%). memo_search therefore runs a phrase search first,
// then per-term searches merged by matched-term count (measured hit@5 97.0%).
//
// Notes live at $DSH_HOME/memo/notes.jsonl, resolved per tool execution via
// shellEnv.collect(exec) — never hardcode a machine path.
return {
  apply(ctx) {
    const sessionQuery = ctx.get('sessionQuery')
    const fsService = ctx.get('fs')
    const shellEnv = ctx.get('shellEnv')

    let cachedNotesPath = null
    function resolveNotesPath(exec) {
      if (cachedNotesPath !== null) return cachedNotesPath
      if (shellEnv !== undefined && exec !== undefined) {
        try {
          const env = shellEnv.collect(exec)
          if (env !== null && typeof env === 'object' && typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') {
            cachedNotesPath = env.DSH_HOME.replace(/\/+$/, '') + '/memo/notes.jsonl'
            return cachedNotesPath
          }
        } catch (err) { /* fall through */ }
      }
      return null
    }

    async function readNotes(path) {
      if (fsService === undefined || path === null) return []
      try {
        const target = await fsService.resolve(path)
        const text = await fsService.readText(target)
        const rows = []
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (t === '') continue
          try { rows.push(JSON.parse(t)) } catch (err) { /* skip malformed */ }
        }
        return rows
      } catch (err) { return [] }
    }

    async function appendNote(path, record) {
      if (fsService === undefined || path === null) return false
      try {
        const existing = await readNotes(path)
        existing.push(record)
        const target = await fsService.resolve(path)
        await fsService.writeText(target, existing.map((r) => JSON.stringify(r)).join('\n') + '\n')
        return true
      } catch (err) { return false }
    }

    const textOutput = () => ({
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    })

    async function phraseSearch(query, limit, sessionId, since) {
      if (sessionId !== undefined) {
        const page = await sessionQuery.searchEvents({
          sessionId,
          query: String(query),
          limit,
          ...(since !== undefined ? { filters: [{ kind: 'time', from: since }] } : {}),
        })
        return (page.items || []).map((hit) => ({ sessionId, title: null, snippet: hit.snippet ?? '', time: hit.time ?? null, seq: hit.seq ?? null, source: 'event', mode: 'phrase' }))
      }
      const page = await sessionQuery.searchSessions({
        query: String(query),
        limit,
        ...(since !== undefined ? { eventFilters: [{ kind: 'time', from: since }] } : {}),
      })
      return (page.items || []).map((hit) => {
        const bm = hit.bestMatch || {}
        return { sessionId: hit.id ?? hit.sessionId, title: null, snippet: bm.snippet ?? '', time: bm.time ?? null, seq: bm.seq ?? null, source: 'event', mode: 'phrase' }
      })
    }

    async function tokenizedSearch(query, limit, since) {
      const terms = [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 8)
      if (terms.length <= 1) return []
      const collected = new Map()
      for (const term of terms) {
        let page
        try {
          page = await sessionQuery.searchSessions({
            query: term,
            limit: Math.max(limit, 8),
            ...(since !== undefined ? { eventFilters: [{ kind: 'time', from: since }] } : {}),
          })
        } catch (err) { continue }
        for (const hit of page.items || []) {
          const id = String(hit.id ?? hit.sessionId ?? '')
          if (id === '') continue
          const bm = hit.bestMatch || {}
          const cur = collected.get(id)
          if (cur !== undefined) cur.count += 1
          else collected.set(id, { sessionId: id, title: null, snippet: bm.snippet ?? '', time: bm.time ?? null, seq: bm.seq ?? null, source: 'event', mode: 'terms', count: 1 })
        }
      }
      return [...collected.values()].sort((a, b) => (b.count - a.count) || ((b.time ?? 0) - (a.time ?? 0))).slice(0, limit)
    }

    // ---------- memo_search ----------
    const searchTool = harness.defineTool({
      name: 'memo_search',
      description: 'Search every past session in this workspace plus your memo notes. Use it whenever answering depends on what was said, decided, or built in any earlier session.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search terms; matched against session text and memo notes.' },
        limit: { type: 'number', description: 'Max hits per source. Default 10, cap 50.' },
        sessionId: { type: 'string', description: 'Limit the search to this session.' },
        since: { type: 'number', description: 'Only hits after this epoch-ms time.' },
      },
      output: textOutput(),
      execute: async (args, exec) => {
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10
        const since = typeof args.since === 'number' ? args.since : undefined
        const sessionId = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const result = { sessions: [], notes: [], limit }
        if (sessionQuery !== undefined) {
          try {
            const phrase = await phraseSearch(args.query, limit, sessionId, since)
            const merged = []
            const seen = new Set()
            for (const hit of phrase) {
              seen.add(String(hit.sessionId))
              merged.push(hit)
            }
            if (sessionId === undefined) {
              for (const hit of await tokenizedSearch(args.query, limit, since)) {
                if (!seen.has(String(hit.sessionId))) {
                  seen.add(String(hit.sessionId))
                  merged.push(hit)
                }
              }
            }
            result.sessions = merged.slice(0, limit)
          } catch (err) {
            result.error = 'search failed: ' + String((err && err.message) || err)
          }
        } else {
          result.error = 'sessionQuery service unavailable in this composition'
        }
        try {
          const q = String(args.query || '').toLowerCase()
          const notes = await readNotes(resolveNotesPath(exec))
          if (q !== '') {
            result.notes = notes.filter((n) => String(n.text || '').toLowerCase().includes(q)).slice(-limit).reverse()
          } else {
            result.notes = notes.slice(-limit).reverse()
          }
        } catch (err) { /* notes optional */ }
        return result
      },
    })

    // ---------- memo_remember ----------
    const rememberTool = harness.defineTool({
      name: 'memo_remember',
      description: 'Write one durable note to the memo store. Use for facts, decisions, preferences, and conventions that must survive across sessions; memo_search returns these notes.',
      parameters: {
        text: { type: 'string', required: true, description: 'The note — one concrete fact, decision, or preference.' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
      },
      output: textOutput(),
      execute: async (args, exec) => {
        const path = resolveNotesPath(exec)
        if (path === null) return { ok: false, error: 'cannot resolve DSH home (shellEnv unavailable); memo notes need $DSH_HOME/memo/notes.jsonl' }
        const record = {
          time: Date.now(),
          text: String(args.text),
          tags: typeof args.tags === 'string' ? args.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
        }
        const ok = await appendNote(path, record)
        return { ok, note: ok ? record : null, path }
      },
    })

    // ---------- memo_stats ----------
    const statsTool = harness.defineTool({
      name: 'memo_stats',
      description: 'Corpus overview: total sessions, five most recent session titles, memo-note count.',
      parameters: {},
      output: textOutput(),
      execute: async (args, exec) => {
        let sessionCount = 0
        let recent = []
        if (sessionQuery !== undefined) {
          try {
            const sessions = await sessionQuery.listSessions()
            sessionCount = sessions.length
            recent = sessions.slice(0, 5).map((s) => ({
              id: s.id ?? null,
              cwd: s.cwd ?? null,
              createdAt: s.createdAt ?? null,
              title: s.title ?? null,
            }))
          } catch (err) { /* keep zeros */ }
        }
        const notes = await readNotes(resolveNotesPath(exec))
        return { sessions: sessionCount, recent, notes: notes.length }
      },
    })

    harness.registerTool(ctx, searchTool)
    harness.registerTool(ctx, rememberTool)
    harness.registerTool(ctx, statsTool)
  },
}
