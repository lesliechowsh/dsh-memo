// Memo benchmark harness — retrieval-layer evaluation on LongMemEval-S.
//
// This harness reproduces the retrieval pipeline `memo_search` ships, running
// against the official backend's (dsh-session-query-sqlite) semantics:
//
//   1. Phrase step — the whole question as one inert FTS5 phrase. The backend
//      indexes one FTS5 document per EVENT, picks one representative event per
//      session (event_rank = 1 by match_count DESC, document_length ASC,
//      time DESC, seq DESC) and ranks sessions by that representative's
//      stats, returning the top `limit` (default 10).
//   2. Tokenized step — each question token (<= 8, len >= 2) plus each
//      consecutive token pair as its own quoted phrase; per phrase the top
//      max(limit, 8) sessions in backend order; merged by summed phrase
//      weights (token length / pair string length — a local rarity proxy)
//      with time-desc tiebreak, sliced to `limit`.
//   3. Phrase hits listed first, then tokenized hits, deduplicated, sliced to
//      `limit` — exactly the order and truncation the product ships.
//
// FTS5 discovery uses the same engine class and default unicode61 tokenizer
// as the official backend; the backend's ORDER BY is reimplemented in JS
// because the dataset exposes message text but not the backend's event rows.
// Time proxy: session datetime (parsed from haystack_dates) + in-session
// message index, since LongMemEval messages carry no timestamps.
//
// Protocol: gold = the question's answer_session_ids present in the haystack;
// metrics = hit@1 / hit@5 / hit@10 over sessions, MRR, per-question-type
// breakdown.
//
// Run: node run.cjs            (full 500 questions)
//      LIMIT=10 node run.cjs   (smoke)
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10; // memo_search's default limit — the page size for both steps.
const TERM_MAX = 8;      // memo_search tokenizes at most 8 terms per query.

const STOP_WORDS = new Set(['the','a','an','and','or','what','did','do','does','is','are','was','were','to','of','in','on','at','for','with','about','we','you','i','it','this','that','how','when','where','which','why','be','been','from','by','as','there','not','can','could','should','would','just','also']);
// Content words fill the 8-token window first; stopwords fill the remainder
// (mirrors the shipped product — query-head stopwords must not crowd out
// discriminative words).
function tokenize(text) {
  const all = [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return [...content, ...all.filter((t) => STOP_WORDS.has(t))].slice(0, 8);
}

// Token sequence (len >= 1) for phrase/term occurrence counting.
function seq(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 1);
}

// Contiguous occurrences of token sequence `p` inside token sequence `t`.
function occurrencesIn(t, p) {
  if (p.length === 0) return 0;
  let n = 0;
  outer: for (let i = 0; i + p.length <= t.length; i++) {
    for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) continue outer;
    n++;
  }
  return n;
}

// Parse "2023/05/20 (Sat) 02:21" -> epoch ms.
function parseDate(s) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/.exec(String(s));
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
}

function goldSessions(entry) {
  const haystackIds = new Set((entry.haystack_session_ids || []).map(String));
  const gold = new Set();
  for (const id of entry.answer_session_ids || []) {
    const s = String(id);
    if (haystackIds.has(s)) gold.add(s);
  }
  return gold;
}

// One session with per-event (message) documents, mirroring the backend's
// event-level FTS5 table: { text, tokens, len (codepoints), time, seq }.
function haystackSessions(entry) {
  const ids = entry.haystack_session_ids || [];
  const dates = entry.haystack_dates || [];
  const sessions = entry.haystack_sessions || [];
  return sessions.map((sess, i) => {
    const parsed = parseDate(dates[i]);
    const base = Number.isFinite(parsed) ? parsed : (dates.length - i) * 86400000;
    const events = (sess || []).map((m, k) => {
      const text = String(m && m.content !== undefined ? m.content : "");
      return {
        text,
        tokens: seq(text),
        len: Array.from(text).length,
        time: base + k, // time proxy: session datetime + in-session index
        seq: k,
      };
    });
    return { id: String(ids[i] ?? "s" + i), idx: i, events };
  });
}

// Backend event_rank = 1: the representative event per session is the one
// maximizing (match_count DESC, document_length ASC, time DESC, seq DESC).
// match_count = contiguous occurrences of the phrase in that event's text.
function representative(session, phraseTokens) {
  let best = null;
  for (const ev of session.events) {
    const occ = occurrencesIn(ev.tokens, phraseTokens);
    if (occ === 0) continue;
    if (
      best === null ||
      occ > best.occ ||
      (occ === best.occ && (ev.len < best.len ||
        (ev.len === best.len && (ev.time > best.time ||
          (ev.time === best.time && ev.seq > best.seq)))))
    ) best = { occ, len: ev.len, time: ev.time, seq: ev.seq };
  }
  return best;
}

// Backend session ORDER BY: match_count DESC, document_length ASC, time DESC,
// session_id ASC, seq DESC (all of the representative event).
function backendRank(a, b) {
  return (
    b.occ - a.occ ||
    a.len - b.len ||
    b.time - a.time ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    b.seq - a.seq
  );
}

// FTS5-quote a phrase the way quoteFtsData inerts it: whole query inside
// double quotes, inner quotes doubled.
function quotePhrase(text) {
  return '"' + String(text).replace(/"/g, '""') + '"';
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 500");

  let hit1 = 0, hit5 = 0, hit10 = 0, mrrSum = 0, total = 0;
  const byType = new Map();
  const misses = [];

  for (const entry of questions) {
    const gold = goldSessions(entry);
    if (gold.size === 0) continue;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) continue;
    total++;

    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const byId = new Map(sessions.map((s) => [s.id, s]));

    const question = String(entry.question || "");
    const phraseTokens = seq(question);
    if (phraseTokens.length === 0) continue;

    // ---- Phrase step: whole question as one inert phrase, top `limit`. ----
    const phraseRanked = [];
    {
      let rows = [];
      try { rows = match.all(quotePhrase(question)); } catch (err) { /* no matches */ }
      const cands = [];
      for (const row of rows) {
        const s = byId.get(String(row.id));
        if (!s) continue;
        const rep = representative(s, phraseTokens);
        if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
      }
      cands.sort(backendRank);
      for (const c of cands.slice(0, REQUEST_LIMIT)) phraseRanked.push(c.id);
    }

    // ---- Tokenized step: per-phrase top max(limit, 8), merged by summed
    // ---- phrase weights (token length / pair length), time-desc tiebreak.
    const tokens = tokenize(question).slice(0, TERM_MAX);
    const counts = new Map();
    const repTimes = new Map(); // representative-event time of the first phrase that found the session
    if (tokens.length > 1) {
      const termLimit = Math.max(REQUEST_LIMIT, 8);
      const phrases = [];
      for (const t of tokens) phrases.push([t, t.length]);
      for (let i = 0; i + 1 < tokens.length; i++) {
        const pair = tokens[i] + " " + tokens[i + 1];
        phrases.push([pair, pair.length]);
      }
      for (const [phrase, weight] of phrases) {
        let rows = [];
        try { rows = match.all(quotePhrase(phrase)); } catch (err) { /* phrase query failed */ }
        const cands = [];
        for (const row of rows) {
          const s = byId.get(String(row.id));
          if (!s) continue;
          const rep = representative(s, phrase.split(" "));
          if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
        }
        cands.sort(backendRank);
        for (const c of cands.slice(0, termLimit)) {
          if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + weight);
          else { counts.set(c.id, weight); repTimes.set(c.id, c.time); }
        }
      }
    }
    const tokenRanked = [...counts.keys()]
      .sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a)))
      .slice(0, REQUEST_LIMIT);

    // ---- Merge: phrase first, then terms, dedup, slice to limit. ----
    const merged = [];
    const seen = new Set();
    for (const id of [...phraseRanked, ...tokenRanked]) {
      if (!seen.has(id)) { seen.add(id); merged.push(id); }
    }
    const top = merged.slice(0, REQUEST_LIMIT);

    let bestRank = 0;
    for (let i = 0; i < top.length && i < 10; i++) {
      if (gold.has(top[i])) { bestRank = i + 1; break; }
    }
    if (bestRank > 0) {
      if (bestRank === 1) hit1++;
      if (bestRank <= 5) hit5++;
      if (bestRank <= 10) hit10++;
      mrrSum += 1 / bestRank;
    } else if (misses.length < 5) {
      misses.push({ qid: entry.question_id, query: question.slice(0, 50), gold: [...gold], got: top.slice(0, 3) });
    }

    const type = String(entry.question_type || "unknown");
    const t = byType.get(type) || { n: 0, hit1: 0, hit5: 0, mrr: 0 };
    t.n += 1;
    if (bestRank === 1) t.hit1 += 1;
    if (bestRank >= 1 && bestRank <= 5) t.hit5 += 1;
    if (bestRank > 0) t.mrr += 1 / bestRank;
    byType.set(type, t);
  }

  const pct = (n) => (total === 0 ? 0 : ((n / total) * 100).toFixed(1) + "%");
  console.log("=== LongMemEval-S retrieval (product pipeline: phrase + weighted phrase-pair merge) ===");
  console.log(`questions: ${total}`);
  console.log(`hit@1 ${hit1}  ${pct(hit1)}   hit@5 ${hit5}  ${pct(hit5)}   hit@10 ${hit10}  ${pct(hit10)}   MRR ${(mrrSum / Math.max(1, total)).toFixed(4)}`);
  console.log("per question type (hit@1 / hit@5 / MRR):");
  const types = [...byType.entries()].map(([name, t]) => ({
    name, n: t.n,
    hit1: ((t.hit1 / t.n) * 100).toFixed(1) + "%",
    hit5: ((t.hit5 / t.n) * 100).toFixed(1) + "%",
    mrr: (t.mrr / t.n).toFixed(3),
  })).sort((a, b) => b.n - a.n);
  for (const t of types) console.log(`  ${t.name.padEnd(24)} n=${String(t.n).padEnd(4)} ${t.hit1}  ${t.hit5}  ${t.mrr}`);
  if (misses.length > 0) {
    console.log("sample misses:");
    for (const m of misses.slice(0, 3)) console.log(" ", JSON.stringify(m).slice(0, 240));
  }
}

main();
