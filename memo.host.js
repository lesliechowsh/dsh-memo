// Memo (dsh-memo) — host-side dynamic plugin, canonical development form.
// Deployed in this process as plugin `memo-7`, pkg-14.
// Registers three model tools on the official sessionQuery service:
//   memo_search   — cross-session full-text recall + memo-note merge
//   memo_remember — distilled durable notes (facts, decisions, preferences)
//   memo_stats    — corpus overview (session count, recent titles, note count)
//
// Notes live at $DSH_HOME/memo/notes.jsonl. The dynamic sandbox has no
// `process`, so DSH_HOME is resolved per tool execution via
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

    // ---------- memo_search ----------
    const searchTool = harness.defineTool({
      name: 'memo_search',
      description: 'Search all of your DSH session history and memo notes. Full-text recall across every session you ever had in this workspace (official sessionQuery ranking with snippets), plus your distilled memo notes. Use it whenever a question involves what was said, decided, or built before — in this or any other session.',
      parameters: {
        query: { type: 'string', required: true, description: 'Plain-language search query; matched against session event text and memo notes.' },
        limit: { type: 'number', description: 'Maximum results per source (sessions and notes). Default 10, cap 50.' },
        sessionId: { type: 'string', description: 'Restrict the search to one session id.' },
        since: { type: 'number', description: 'Only events after this epoch-ms timestamp.' },
      },
      output: textOutput(),
      execute: async (args, exec) => {
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10
        const result = { sessions: [], notes: [], limit }
        if (sessionQuery !== undefined) {
          try {
            if (typeof args.sessionId === 'string' && args.sessionId !== '') {
              const page = await sessionQuery.searchEvents({
                sessionId: args.sessionId,
                query: String(args.query),
                limit,
                ...(typeof args.since === 'number' ? { filters: [{ kind: 'time', from: args.since }] } : {}),
              })
              for (const hit of page.items || []) {
                result.sessions.push({ sessionId: args.sessionId, title: null, snippet: hit.snippet ?? '', time: hit.time ?? null, seq: hit.seq ?? null, source: 'event' })
              }
            } else {
              const page = await sessionQuery.searchSessions({
                query: String(args.query),
                limit,
                ...(typeof args.since === 'number' ? { eventFilters: [{ kind: 'time', from: args.since }] } : {}),
              })
              const hits = page.items || []
              const ids = [...new Set(hits.map((h) => h.id ?? h.sessionId).filter(Boolean))]
              const titles = {}
              try {
                const rows = await sessionQuery.readTitleSnapshots(ids)
                for (const row of rows || []) {
                  const value = row && typeof row === 'object' ? (row.value ?? row) : null
                  const id = value && (value.id ?? (value.header && value.header.id) ?? (value.session && value.session.id))
                  const title = value && (value.title ?? (value.titleSnapshot && value.titleSnapshot.title))
                  if (id !== undefined && id !== null) titles[String(id)] = typeof title === 'string' ? title : null
                }
              } catch (err) { /* titles are optional */ }
              for (const hit of hits) {
                const id = hit.id ?? hit.sessionId
                const bm = hit.bestMatch || {}
                result.sessions.push({ sessionId: id ?? null, title: titles[String(id)] ?? null, snippet: bm.snippet ?? '', time: bm.time ?? null, seq: bm.seq ?? null, source: 'event' })
              }
            }
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
      description: 'Write one distilled note into your durable memo store (separate from raw session logs). Use it for durable facts, decisions, preferences, and conventions that should survive across sessions. Notes are also returned by memo_search.',
      parameters: {
        text: { type: 'string', required: true, description: 'The note content — one concrete fact, decision, or preference.' },
        tags: { type: 'string', description: 'Optional comma-separated tags for organization.' },
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
      description: 'Overview of your memory corpus: how many sessions exist in this workspace, the most recent session titles, and how many memo notes are stored.',
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
