// Memo benchmark harness — EXP6: in-memory inverted-index retrieval.
//
// Why: DSH's FTS backend reconciles the whole live corpus on every call
// (measured 35-47 s/call on a phone-class device, query-independent), so the
// shipped FTS path is unusable there. A-prime replaces the FTS lookup with a
// process-local inverted index built from the official exact-read APIs
// (listSessions/readSession — no reconcile). This harness measures the
// RANKING quality of that replacement over LongMemEval-S.
//
// Matching semantics: token-level contiguous occurrence — the same
// occurrencesIn/representative/backendRank logic as run.cjs (the FTS-era
// harness), so the only variable under test is the lookup structure (inverted
// index vs FTS5 table). Tokens: lowercase ASCII word runs (len >= 1, like the
// FTS-era seq()) PLUS contiguous Han runs as single tokens (unicode61
// behavior, mirrored from the shipped tokenizer).
//
// Run: node exp6.cjs             (full 500 questions)
//      LIMIT=10 node exp6.cjs    (smoke)
"use strict";
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const STOP_WORDS = new Set(['the','a','an','and','or','what','did','do','does','is','are','was','were','to','of','in','on','at','for','with','about','we','you','i','it','this','that','how','when','where','which','why','be','been','from','by','as','there','not','can','could','should','would','just','also']);

// Token sequence: ASCII word runs (len >= 1) + contiguous Han runs as single
// tokens (unicode61 behavior).
function seq(text) {
  const out = [];
  const src = String(text).toLowerCase();
  const re = /[a-z0-9]+|\p{Script=Han}+/gu;
  for (const m of src.matchAll(re)) {
    if (/\p{Script=Han}/u.test(m[0])) {
      if (m[0].length >= 2) out.push(m[0]); // sub-2 Han runs are not tokens (mirrors shipped tokenizer)
    } else {
      out.push(m[0]);
    }
  }
  return out;
}

// Content words fill the 8-token window first; stopwords fill the remainder.
function tokenize(text) {
  const all = [...new Set(seq(String(text)))].filter((t) => t.length >= 2);
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return [...content, ...all.filter((t) => STOP_WORDS.has(t))].slice(0, 8);
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
        time: base + k,
        seq: k,
      };
    });
    return { id: String(ids[i] ?? "s" + i), idx: i, events };
  });
}

// Inverted index over one haystack: term -> Map(sessionId -> eventIndices[]).
// Built once per haystack, reused by every phrase lookup (mirrors A-prime).
function buildIndex(sessions) {
  const index = new Map();
  for (const s of sessions) {
    s.events.forEach((ev, k) => {
      for (const t of new Set(ev.tokens)) {
        let bySession = index.get(t);
        if (bySession === undefined) { bySession = new Map(); index.set(t, bySession); }
        let evs = bySession.get(s.id);
        if (evs === undefined) { evs = []; bySession.set(s.id, evs); }
        evs.push(k);
      }
    });
  }
  return index;
}

// Sessions whose representative event matches the phrase token sequence.
function matchingSessions(sessions, index, phraseTokens) {
  if (phraseTokens.length === 0) return [];
  const first = index.get(phraseTokens[0]);
  if (first === undefined) return [];
  const out = [];
  for (const s of sessions) {
    const evs = first.get(s.id);
    if (evs === undefined) continue;
    let best = null;
    for (const k of evs) {
      const ev = s.events[k];
      const occ = occurrencesIn(ev.tokens, phraseTokens);
      if (occ === 0) continue;
      if (best === null || occ > best.occ || (occ === best.occ && (ev.len < best.len ||
        (ev.len === best.len && (ev.time > best.time || (ev.time === best.time && ev.seq > best.seq)))))) {
        best = { occ, len: ev.len, time: ev.time, seq: ev.seq };
      }
    }
    if (best !== null) out.push({ id: s.id, occ: best.occ, len: best.len, time: best.time, seq: best.seq });
  }
  return out;
}

function backendRank(a, b) {
  return b.occ - a.occ || a.len - b.len || b.time - a.time ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || b.seq - a.seq;
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions`);

  let hit1 = 0, hit5 = 0, hit10 = 0, mrrSum = 0, total = 0;
  const byType = new Map();
  const misses = [];
  let indexMs = 0, queryMs = 0;

  for (const entry of questions) {
    const gold = goldSessions(entry);
    if (gold.size === 0) continue;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) continue;
    total++;

    let t0 = Date.now();
    const index = buildIndex(sessions);
    indexMs += Date.now() - t0;
    const byId = new Map(sessions.map((s) => [s.id, s]));

    const question = String(entry.question || "");
    const phraseTokens = seq(question);
    if (phraseTokens.length === 0) continue;

    t0 = Date.now();
    // ---- Phrase step: whole question as one token sequence, top `limit`. ----
    const phraseRanked = [];
    {
      const cands = matchingSessions(sessions, index, phraseTokens);
      cands.sort(backendRank);
      for (const c of cands.slice(0, REQUEST_LIMIT)) phraseRanked.push(c.id);
    }

    // ---- Tokenized step: same weights as the shipped 0.8.0 pipeline, with
    // ---- EXACT df counts from the index (no capped-50 proxy needed).
    const tokens = tokenize(question).slice(0, TERM_MAX);
    const counts = new Map();
    const repTimes = new Map();
    if (tokens.length > 1) {
      const termLimit = Math.max(REQUEST_LIMIT, 8);
      const phrases = [];
      for (const t of tokens) phrases.push([t, t.length]);
      for (let i = 0; i + 1 < tokens.length; i++) {
        phrases.push([tokens[i] + " " + tokens[i + 1], (tokens[i] + " " + tokens[i + 1]).length]);
      }
      const dfOf = (term) => {
        const bySession = index.get(term);
        return bySession === undefined ? 0 : bySession.size;
      };
      const idfOf = (term) => Math.log((sessions.length + 1) / (1 + Math.min(dfOf(term), 50)));
      for (const [phrase, lenWeight] of phrases) {
        const pts = phrase.split(" ");
        const isPair = pts.length === 2;
        const weight = isPair ? lenWeight * Math.max(idfOf(pts[0]), idfOf(pts[1])) : 4 * idfOf(pts[0]);
        const cands = matchingSessions(sessions, index, pts);
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
    queryMs += Date.now() - t0;

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
  console.log("=== LongMemEval-S retrieval (EXP6: in-memory inverted index, token-level matching) ===");
  console.log(`questions: ${total}`);
  console.log(`hit@1 ${hit1}  ${pct(hit1)}   hit@5 ${hit5}  ${pct(hit5)}   hit@10 ${hit10}  ${pct(hit10)}   MRR ${(mrrSum / Math.max(1, total)).toFixed(4)}`);
  console.log(`harness cost: index build ${(indexMs / 1000).toFixed(1)}s, queries ${(queryMs / 1000).toFixed(1)}s`);
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
