// Memo retrieval-variant experiment harness — LongMemEval-S.
// Evaluates the shipped product algorithm (V0 baseline) against candidate
// improvements for the weak question types (single-session-assistant,
// single-session-preference), sharing one FTS5 index build per question.
// All variants keep the product's phrase-first structure; only the tokenized
// step / merge scoring changes.
//
// Variants:
//   V0 baseline — product: terms (<=8), per-term top-10, merge by matched-term
//      count, time-desc tiebreak.
//   V1 terms+bigrams — consecutive token pairs added as quoted phrases
//      (weight 1 each), merged by matched-phrase count.
//   V2 length-weighted — terms only, merge score = sum of token lengths
//      (local IDF proxy; the API exposes no document frequency).
//   V3 terms+bigrams, pairs weight 2 — bigrams treated as more
//      discriminative.
//   V4 wider per-term page — baseline merge but per-term top-20
//      (max(limit*2, 16)), i.e. twice the API calls per query.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

function tokenize(text) {
  return [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
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

// Per-phrase top-N in backend order -> [{id, time}]
function phraseTop(match, byId, phrase, topN) {
  let rows = [];
  try { rows = match.all(quotePhrase(phrase)); } catch (err) { /* no matches */ }
  const cands = [];
  for (const row of rows) {
    const s = byId.get(String(row.id));
    if (!s) continue;
    const rep = representative(s, phrase.split(" "));
    if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
  }
  cands.sort(backendRank);
  return cands.slice(0, topN);
}

function evaluateVariant(name, perPhrase, phraseRanked, gold, stats) {
  // perPhrase: Map phrase -> top list; phraseRanked: top-10 ids of the phrase step.
  // Merge scoring callback gets (phrase, weight) entries per session.
  const seen = new Set();
  const merged = [...phraseRanked];
  for (const id of phraseRanked) seen.add(id);
  const rest = perPhrase.mergedRanked(); // variant-specific
  for (const id of rest) {
    if (!seen.has(id)) { seen.add(id); merged.push(id); }
  }
  const top = merged.slice(0, REQUEST_LIMIT);
  let bestRank = 0;
  for (let i = 0; i < top.length; i++) {
    if (gold.has(top[i])) { bestRank = i + 1; break; }
  }
  stats.record(name, bestRank);
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions x 5 variants`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 500");

  const stat = () => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0, byType: new Map() });
  const stats = new Map(["V0", "V1", "V2", "V3", "V4"].map((v) => [v, stat()]));
  const record = (variant, type, rank) => {
    const s = stats.get(variant);
    s.n += 1;
    if (rank === 1) s.hit1 += 1;
    if (rank >= 1 && rank <= 5) s.hit5 += 1;
    if (rank >= 1 && rank <= 10) s.hit10 += 1;
    if (rank > 0) s.mrr += 1 / rank;
    const t = s.byType.get(type) || { n: 0, hit1: 0, hit5: 0, mrr: 0 };
    t.n += 1;
    if (rank === 1) t.hit1 += 1;
    if (rank >= 1 && rank <= 5) t.hit5 += 1;
    if (rank > 0) t.mrr += 1 / rank;
    s.byType.set(type, t);
  };

  for (const entry of questions) {
    const gold = goldSessions(entry);
    if (gold.size === 0) continue;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) continue;
    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const byId = new Map(sessions.map((s) => [s.id, s]));

    const question = String(entry.question || "");
    const phraseTokens = seq(question);
    if (phraseTokens.length === 0) continue;

    // Phrase step (shared by all variants).
    const phraseRanked = [];
    for (const c of phraseTop(match, byId, question, REQUEST_LIMIT)) phraseRanked.push(c.id);

    const tokens = tokenize(question).slice(0, TERM_MAX);
    const pairs = [];
    for (let i = 0; i + 1 < tokens.length; i++) pairs.push(tokens[i] + " " + tokens[i + 1]);
    const phrases = [...new Set([...tokens, ...pairs])];

    const termTop = new Map();   // term -> top list (V0/V2/V4)
    const pairTop = new Map();   // pair -> top list (V1/V3)
    for (const t of tokens) termTop.set(t, phraseTop(match, byId, t, Math.max(REQUEST_LIMIT, 8)));
    for (const p of pairs) pairTop.set(p, phraseTop(match, byId, p, Math.max(REQUEST_LIMIT, 8)));
    const termTopWide = new Map();
    for (const t of tokens) termTopWide.set(t, phraseTop(match, byId, t, Math.max(REQUEST_LIMIT * 2, 16)));

    // ---- V0 baseline (product) ----
    if (tokens.length > 1) {
      const counts = new Map(), repTimes = new Map();
      for (const t of tokens) {
        for (const c of termTop.get(t)) {
          if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + 1);
          else { counts.set(c.id, 1); repTimes.set(c.id, c.time); }
        }
      }
      const ranked = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a))).slice(0, REQUEST_LIMIT);
      const merged = [], seen = new Set(phraseRanked);
      for (const id of [...phraseRanked, ...ranked]) if (!seen.has(id)) { seen.add(id); merged.push(id); }
      const top = merged.slice(0, REQUEST_LIMIT);
      let rank = 0;
      for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { rank = i + 1; break; }
      record("V0", String(entry.question_type || "unknown"), rank);
    }

    // ---- V1 terms + bigrams, equal weight ----
    if (tokens.length > 1) {
      const counts = new Map(), repTimes = new Map();
      for (const [list] of [[...termTop.entries(), ...pairTop.entries()].map((e) => e[1])]) {
        for (const c of list) {
          if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + 1);
          else { counts.set(c.id, 1); repTimes.set(c.id, c.time); }
        }
      }
      const ranked = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a))).slice(0, REQUEST_LIMIT);
      const merged = [], seen = new Set(phraseRanked);
      for (const id of [...phraseRanked, ...ranked]) if (!seen.has(id)) { seen.add(id); merged.push(id); }
      const top = merged.slice(0, REQUEST_LIMIT);
      let rank = 0;
      for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { rank = i + 1; break; }
      record("V1", String(entry.question_type || "unknown"), rank);
    }

    // ---- V2 length-weighted terms ----
    if (tokens.length > 1) {
      const scores = new Map(), repTimes = new Map();
      for (const t of tokens) {
        const w = t.length;
        for (const c of termTop.get(t)) {
          if (scores.has(c.id)) scores.set(c.id, scores.get(c.id) + w);
          else { scores.set(c.id, w); repTimes.set(c.id, c.time); }
        }
      }
      const ranked = [...scores.keys()].sort((a, b) => (scores.get(b) - scores.get(a)) || (repTimes.get(b) - repTimes.get(a))).slice(0, REQUEST_LIMIT);
      const merged = [], seen = new Set(phraseRanked);
      for (const id of [...phraseRanked, ...ranked]) if (!seen.has(id)) { seen.add(id); merged.push(id); }
      const top = merged.slice(0, REQUEST_LIMIT);
      let rank = 0;
      for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { rank = i + 1; break; }
      record("V2", String(entry.question_type || "unknown"), rank);
    }

    // ---- V3 terms + bigrams, pair weight 2 ----
    if (tokens.length > 1) {
      const scores = new Map(), repTimes = new Map();
      for (const t of tokens) {
        for (const c of termTop.get(t)) {
          if (scores.has(c.id)) scores.set(c.id, scores.get(c.id) + 1);
          else { scores.set(c.id, 1); repTimes.set(c.id, c.time); }
        }
      }
      for (const p of pairs) {
        for (const c of pairTop.get(p)) {
          if (scores.has(c.id)) scores.set(c.id, scores.get(c.id) + 2);
          else { scores.set(c.id, 2); repTimes.set(c.id, c.time); }
        }
      }
      const ranked = [...scores.keys()].sort((a, b) => (scores.get(b) - scores.get(a)) || (repTimes.get(b) - repTimes.get(a))).slice(0, REQUEST_LIMIT);
      const merged = [], seen = new Set(phraseRanked);
      for (const id of [...phraseRanked, ...ranked]) if (!seen.has(id)) { seen.add(id); merged.push(id); }
      const top = merged.slice(0, REQUEST_LIMIT);
      let rank = 0;
      for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { rank = i + 1; break; }
      record("V3", String(entry.question_type || "unknown"), rank);
    }

    // ---- V4 wider per-term page (2x API calls) ----
    if (tokens.length > 1) {
      const counts = new Map(), repTimes = new Map();
      for (const t of tokens) {
        for (const c of termTopWide.get(t)) {
          if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + 1);
          else { counts.set(c.id, 1); repTimes.set(c.id, c.time); }
        }
      }
      const ranked = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a))).slice(0, REQUEST_LIMIT);
      const merged = [], seen = new Set(phraseRanked);
      for (const id of [...phraseRanked, ...ranked]) if (!seen.has(id)) { seen.add(id); merged.push(id); }
      const top = merged.slice(0, REQUEST_LIMIT);
      let rank = 0;
      for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { rank = i + 1; break; }
      record("V4", String(entry.question_type || "unknown"), rank);
    }
  }

  console.log("=== variant comparison (hit@1 / hit@5 / hit@10 / MRR) ===");
  for (const [name, s] of stats) {
    if (s.n === 0) continue;
    const pct = (n) => ((n / s.n) * 100).toFixed(1) + "%";
    console.log(`${name}  n=${String(s.n).padEnd(4)} ${pct(s.hit1)}  ${pct(s.hit5)}  ${pct(s.hit10)}  MRR ${(s.mrr / s.n).toFixed(4)}`);
  }
  console.log("=== per-type hit@1 / hit@5 / MRR (V0 vs V1 vs V2 vs V3 vs V4) ===");
  const typeNames = new Set();
  for (const s of stats.values()) for (const t of s.byType.keys()) typeNames.add(t);
  for (const type of [...typeNames].sort()) {
    const line = [type.padEnd(24)];
    for (const name of ["V0", "V1", "V2", "V3", "V4"]) {
      const s = stats.get(name);
      const t = s.byType.get(type);
      if (!t) { line.push("      -   "); continue; }
      line.push(`${((t.hit1 / t.n) * 100).toFixed(1)} ${((t.hit5 / t.n) * 100).toFixed(1)} ${(t.mrr / t.n).toFixed(2)}`);
    }
    console.log("  " + line.join(" | "));
  }
}

main();
