// Memo (dsh-memo) — host-side dynamic plugin, canonical development form.
// Deployed in this process as plugin `memo-7`.
// Registers three model tools on the official sessionQuery service:
//   memo_search   — cross-session recall (phrase-first + per-term count merge)
//   memo_remember — distilled durable notes (facts, decisions, preferences)
//   memo_stats    — corpus overview
//
// Contract notes (learned the hard way — do not regress):
//   - searchSessions hits are SessionRecord = { header, live, persisted, bestMatch };
//     the session id lives at hit.header.id, NOT hit.id.
//   - searchEvents hits ARE events: they carry sessionId directly.
//   - SessionHeader has no title; fold titles via readTitleSnapshots.
//   - Notes are appended raw (never rewritten from parsed rows) so hand-edited
//     or malformed lines survive.
//   - DSH_HOME resolves per execution via shellEnv.collect(exec) — no cache,
//     no machine paths.
return {
  apply(ctx) {
    const sessionQuery = ctx.get('sessionQuery')
    const fsService = ctx.get('fs')
    const shellEnv = ctx.get('shellEnv')

    function resolveNotesPath(exec) {
      if (shellEnv === undefined || exec === undefined) return null
      try {
        const env = shellEnv.collect(exec)
        if (env !== null && typeof env === 'object' && typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') {
          return env.DSH_HOME.replace(/\/+$/, '') + '/memo/notes.jsonl'
        }
      } catch (err) { /* fall through */ }
      return null
    }

    async function readNotesText(path) {
      if (fsService === undefined || path === null) return ''
      try {
        const target = await fsService.resolve(path)
        return await fsService.readText(target)
      } catch (err) { return '' }
    }

    function parseNotes(text) {
      const rows = []
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        try { rows.push(JSON.parse(t)) } catch (err) { /* malformed lines survive on disk */ }
      }
      return rows
    }

    async function appendNote(path, record) {
      if (fsService === undefined || path === null) return false
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const raw = await readNotesText(path)
          const target = await fsService.resolve(path)
          await fsService.writeText(target, raw + JSON.stringify(record) + '\n')
          return true
        } catch (err) { /* retry */ }
      }
      return false
    }

    function noteMatches(note, tokens) {
      const text = String(note.text || '').toLowerCase()
      if (tokens.length <= 1) return text.includes(tokens[0] || '')
      return tokens.every((t) => text.includes(t))
    }

    const textOutput = () => ({
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    })

    async function enrichTitles(hits) {
      const ids = [...new Set(hits.map((h) => h.sessionId).filter((id) => id !== undefined && id !== null && id !== ''))]
      if (ids.length === 0 || sessionQuery === undefined) return
      try {
        const rows = await sessionQuery.readTitleSnapshots(ids.map(String))
        const titles = {}
        for (const row of rows || []) {
          const value = row && typeof row === 'object' ? (row.value ?? row) : null
          const id = value && (value.id ?? (value.header && value.header.id) ?? (value.session && value.session.id))
          const title = value && (value.title ?? (value.titleSnapshot && value.titleSnapshot.title))
          if (id !== undefined && id !== null) titles[String(id)] = typeof title === 'string' ? title : null
        }
        for (const hit of hits) hit.title = titles[String(hit.sessionId)] ?? null
      } catch (err) { /* titles optional */ }
    }

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
        return { sessionId: (hit.header && hit.header.id) ?? null, title: null, snippet: bm.snippet ?? '', time: bm.time ?? null, seq: bm.seq ?? null, source: 'event', mode: 'phrase' }
      })
    }

    async function tokenizedSearch(query, limit, since) {
      const tokens = [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 8)
      if (tokens.length <= 1) return []
      const collected = new Map()
      for (const term of tokens) {
        let page
        try {
          page = await sessionQuery.searchSessions({
            query: term,
            limit: Math.max(limit, 8),
            ...(since !== undefined ? { eventFilters: [{ kind: 'time', from: since }] } : {}),
          })
        } catch (err) { continue }
        for (const hit of page.items || []) {
          const id = (hit.header && hit.header.id) ? String(hit.header.id) : ''
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
              if (hit.sessionId === null || hit.sessionId === undefined) continue
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
            await enrichTitles(result.sessions)
          } catch (err) {
            result.error = 'search failed: ' + String((err && err.message) || err)
          }
        } else {
          result.error = 'sessionQuery service unavailable in this composition'
        }
        try {
          const tokens = [...new Set(String(args.query || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 8)
          const notes = parseNotes(await readNotesText(resolveNotesPath(exec)))
          result.notes = notes.filter((n) => noteMatches(n, tokens)).slice(-limit).reverse()
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
              id: (s.header && s.header.id) ?? null,
              cwd: (s.header && s.header.cwd) ?? null,
              createdAt: (s.header && s.header.createdAt) ?? null,
              title: null,
            }))
            await enrichTitles(recent)
          } catch (err) { /* keep zeros */ }
        }
        const notes = parseNotes(await readNotesText(resolveNotesPath(exec)))
        return { sessions: sessionCount, recent, notes: notes.length }
      },
    })

    harness.registerTool(ctx, searchTool)
    harness.registerTool(ctx, rememberTool)
    harness.registerTool(ctx, statsTool)
  },
}
