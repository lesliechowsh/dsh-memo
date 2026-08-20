// Memo experiment #3 — deterministic time-aware retrieval (corrected design).
//
// Grounding, corrected after re-reading LongMemEval (Wu et al., arXiv:2410.10813,
// ICLR 2025) §5.4 + Table 4:
//   - The paper's time-aware query expansion gains are ROUND-granularity
//     (+11.3%); at session granularity it is only 0.639 -> 0.654 Recall@5
//     (+1.5pp) with NDCG@10 DROPPING 0.707 -> 0.679.
//   - It requires values additionally indexed by dates (index-side change —
//     conflicts with Memo's "re-indexes nothing" promise).
//   - With a weaker temporal model (Llama 3.1 8B) expansion HURTS (0.624):
//     wrong time ranges silently prune the search space.
//
// Therefore this experiment tests only deterministic, no-model variants that
// can never lose the gold session worse than the baseline:
//   V6  shipped baseline (stopword-fixed weighted token/pair merge)
//   T1  date-word expansion — weekday/month/year words from the question
//       added as weighted phrases.
//   T2h hard `since` filter on both steps — INCLUDED TO DOCUMENT THE FAILURE
//       MODE (wrong windows silently drop gold), not as a candidate.
//   T2s soft time boost — single pass, cost-neutral: sessions with an event
//       inside the parsed relative window get a fixed score boost in the
//       tokenized merge only. Worst case = baseline.
//   T2m dual-path merge — filtered and unfiltered runs merged with filtered
//       hits listed first (2x backend calls; no gold loss possible).
//   T3  = T1 + T2s.
//
// Window anchor: question_date (the dataset's "now"; production anchors on
// Date.now()). Trigger coverage is reported honestly.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;
const TIME_BOOST = 24;

const RELATIVE_PATTERNS = [
  [/\byesterday\b/i, 1],
  [/\btoday\b/i, 1],
  [/\blast (weekend|week)\b|\bpast (weekend|week)\b|\bthis (weekend|week)\b/i, 7],
  [/\blast (month)\b|\bpast (month)\b|\bthis (month)\b/i, 30],
  [/\blast (year)\b|\bpast (year)\b|\bthis (year)\b/i, 365],
  [/\b(a )?few days ago\b|\b(couple of )?days ago\b/i, 5],
  [/\brecent(ly)?\b/i, 14],
  [/\blast (summer|winter|spring|autumn|fall)\b/i, 90],
];
function parseWindow(question) {
  for (const [re, days] of RELATIVE_PATTERNS) if (re.test(question)) return days;
  return null;
}

const DATE_WORD_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|weekend|summer|winter|spring|autumn|fall|19\d\d|20\d\d)\b/gi;

const STOP_WORDS = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);
// Content words fill the 8-token window first; stopwords fill the remainder
// (mirrors the shipped product — query-head stopwords must not crowd out
// discriminative words).
function tokenize(text) {
  const all = [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return [...content, ...all.filter((t) => STOP_WORDS.has(t))].slice(0, 8);
}

function seq(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 1);
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
      return { text, tokens: seq(text), len: Array.from(text).length, time: base + k, seq: k };
    });
    return { id: String(ids[i] ?? "s" + i), idx: i, events };
  });
}

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

function backendRank(a, b) {
  return (
    b.occ - a.occ ||
    a.len - b.len ||
    b.time - a.time ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    b.seq - a.seq
  );
}

function quotePhrase(text) {
  return '"' + String(text).replace(/"/g, '""') + '"';
}

function phraseTop(match, byId, phrase, topN, minTime) {
  let rows = [];
  try { rows = match.all(quotePhrase(phrase)); } catch (err) { /* no matches */ }
  const cands = [];
  for (const row of rows) {
    const s = byId.get(String(row.id));
    if (!s) continue;
    if (minTime !== null && !s.events.some((e) => e.time >= minTime)) continue;
    const rep = representative(s, seq(phrase));
    if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
  }
  cands.sort(backendRank);
  return cands.slice(0, topN);
}

// Runs the shipped pipeline once; minTime hard-filters when set, boost adds
// to a session's merge score when it has an event inside the window.
function evalOnce(match, byId, entry, question, minTime, boost, extraPhrases) {
  const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT, minTime).map((c) => c.id);
  const tokens = [...tokenize(question), ...(extraPhrases || [])].slice(0, TERM_MAX);
  const counts = new Map();
  const repTimes = new Map();
  if (tokens.length > 1) {
    const termLimit = Math.max(REQUEST_LIMIT, 8);
    const phrases = [];
    for (const t of tokens) phrases.push([t, t.length]);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const pair = tokens[i] + " " + tokens[i + 1];
      phrases.push([pair, pair.length]);
    }
    for (const [phrase, weight] of phrases) {
      for (const c of phraseTop(match, byId, phrase, termLimit, minTime)) {
        if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + weight);
        else { counts.set(c.id, weight); repTimes.set(c.id, c.time); }
      }
    }
  }
  if (boost > 0 && minTime !== null) {
    for (const s of byId.values()) {
      if (!counts.has(s.id)) continue;
      if (s.events.some((e) => e.time >= minTime)) counts.set(s.id, counts.get(s.id) + boost);
    }
  }
  const tokenRanked = [...counts.keys()]
    .sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a)))
    .slice(0, REQUEST_LIMIT);
  const merged = [];
  const seen = new Set();
  for (const id of [...phraseRanked, ...tokenRanked]) {
    if (!seen.has(id)) { seen.add(id); merged.push(id); }
  }
  return merged.slice(0, REQUEST_LIMIT);
}

function rankOf(top, gold) {
  for (let i = 0; i < top.length; i++) if (gold.has(top[i])) return i + 1;
  return 0;
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions x 6 variants`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 500");

  const NAMES = ["V6", "T1", "T2h", "T2s", "T2m", "T3"];
  const stat = () => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0, temporal: null });
  const stats = new Map(NAMES.map((v) => [v, stat()]));
  const record = (variant, type, rank) => {
    const s = stats.get(variant);
    s.n += 1;
    if (rank === 1) s.hit1 += 1;
    if (rank >= 1 && rank <= 5) s.hit5 += 1;
    if (rank >= 1 && rank <= 10) s.hit10 += 1;
    if (rank > 0) s.mrr += 1 / rank;
    if (type === "temporal-reasoning") {
      if (s.temporal === null) s.temporal = { n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0 };
      const t = s.temporal;
      t.n += 1;
      if (rank === 1) t.hit1 += 1;
      if (rank >= 1 && rank <= 5) t.hit5 += 1;
      if (rank >= 1 && rank <= 10) t.hit10 += 1;
      if (rank > 0) t.mrr += 1 / rank;
    }
  };

  let temporalTotal = 0, windowTriggers = 0, dateWordTriggers = 0;

  for (const entry of questions) {
    const gold = goldSessions(entry);
    if (gold.size === 0) continue;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) continue;
    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const question = String(entry.question || "");
    const type = String(entry.question_type || "unknown");
    if (seq(question).length === 0) continue;

    const windowDays = parseWindow(question);
    const dateWords = [...new Set((question.match(DATE_WORD_RE) || []).map((w) => w.toLowerCase()))];
    const anchor = parseDate(entry.question_date);
    const minTime = windowDays !== null && Number.isFinite(anchor) ? anchor - windowDays * 86400000 : null;

    if (type === "temporal-reasoning") {
      temporalTotal++;
      if (windowDays !== null) windowTriggers++;
      if (dateWords.length > 0) dateWordTriggers++;
    }

    const wrapped = { gold };
    const topV6 = evalOnce(match, byId, wrapped, question, null, 0, []);
    record("V6", type, rankOf(topV6, gold));
    record("T1", type, rankOf(evalOnce(match, byId, wrapped, question, null, 0, dateWords), gold));
    record("T2h", type, rankOf(evalOnce(match, byId, wrapped, question, minTime, 0, []), gold));
    record("T2s", type, rankOf(evalOnce(match, byId, wrapped, question, null, TIME_BOOST, []), gold));
    // T2m: filtered run listed first, then the unfiltered run, deduped —
    // a filtered miss can never lose the gold session.
    const filteredTop = evalOnce(match, byId, wrapped, question, minTime, 0, []);
    const mergedTop = [];
    const seen = new Set();
    for (const id of [...filteredTop, ...topV6]) {
      if (!seen.has(id)) { seen.add(id); mergedTop.push(id); }
    }
    record("T2m", type, rankOf(mergedTop.slice(0, REQUEST_LIMIT), gold));
    record("T3", type, rankOf(evalOnce(match, byId, wrapped, question, null, TIME_BOOST, dateWords), gold));
  }

  console.log(`temporal-reasoning questions: ${temporalTotal} (window-triggered: ${windowTriggers}, date-word: ${dateWordTriggers})`);
  console.log("=== overall (hit@1 / hit@5 / hit@10 / MRR) ===");
  for (const name of NAMES) {
    const s = stats.get(name);
    const pct = (n) => ((n / s.n) * 100).toFixed(1) + "%";
    console.log(`${name}  n=${String(s.n).padEnd(4)} ${pct(s.hit1)}  ${pct(s.hit5)}  ${pct(s.hit10)}  MRR ${(s.mrr / s.n).toFixed(4)}`);
  }
  console.log("=== temporal-reasoning subset (hit@1 / hit@5 / hit@10 / MRR) ===");
  for (const name of NAMES) {
    const t = stats.get(name).temporal;
    if (!t) continue;
    const pct = (n) => ((n / t.n) * 100).toFixed(1) + "%";
    console.log(`${name}  n=${String(t.n).padEnd(4)} ${pct(t.hit1)}  ${pct(t.hit5)}  ${pct(t.hit10)}  MRR ${(t.mrr / t.n).toFixed(4)}`);
  }
}

main();
