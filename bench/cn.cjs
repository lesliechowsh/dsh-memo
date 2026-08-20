// Memo benchmark harness — LongMemEval-CN cross-lingual retrieval.
//
// The CN subset (shiliu-memory/longmemeval-cn) ships translated Chinese
// questions for the original 500 LongMemEval-S cases, but NOT translated
// haystacks. This harness therefore measures the real mixed-language
// scenario: Chinese questions over the original English session haystacks,
// gold = the original answer_session_ids (mapped via question_id).
//
// Two variants, both faithful to the shipped pipeline:
//   A "shipped"  — the product's current tokenizer ([a-z0-9] only) drops
//     every CJK token, so the weighted step is skipped for Chinese queries;
//     only the verbatim phrase step runs (and cannot match English text).
//   B "cjk-runs" — the proposed fix: tokenize CJK runs the way the official
//     backend's unicode61 index does (contiguous CJK runs as tokens), plus
//     consecutive run pairs, same weights and merge as the shipped V6.
//
// Expected outcome of both is near zero — the real gap is translation, not
// tokenization; the harness makes that measurable and honest.
//
// Data: ~/bench/longmemeval_s.json (original) + ~/lmcn_results.jsonl (CN).
// Run: node cn.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const CN_FILE = process.env.LMCN_FILE || ((process.env.HOME || ".") + "/lmcn_results.jsonl");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

// Shipped tokenizer (0.5.0): content words fill the window first, stopwords
// fill the remainder; ASCII only, so pure-CJK queries yield zero tokens.
const STOP_WORDS = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);
function tokenizeAscii(text) {
  const all = [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return [...content, ...all.filter((t) => STOP_WORDS.has(t))].slice(0, 8);
}

// CJK-run tokenizer: runs of CJK chars (len >= 2), matching the granularity
// of the backend's unicode61 index; ASCII words included as before.
function tokenizeCjk(text) {
  const out = [];
  for (const part of String(text).toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/)) {
    if (/^[\u3400-\u9fff]+$/.test(part) && part.length >= 2) out.push(part);
  }
  return [...new Set(out)];
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

function phraseTop(match, byId, phrase, topN, tokenizerFn) {
  let rows = [];
  try { rows = match.all(quotePhrase(phrase)); } catch (err) { /* no matches */ }
  const cands = [];
  for (const row of rows) {
    const s = byId.get(String(row.id));
    if (!s) continue;
    const rep = representative(s, tokenizerFn(phrase));
    if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
  }
  cands.sort(backendRank);
  return cands.slice(0, topN);
}

// Evaluate one question under a tokenizer, mirroring the shipped pipeline.
function evalOne(match, byId, question, gold, tokenizeFn) {
  const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT, seq).map((c) => c.id);
  const tokens = tokenizeFn(question).slice(0, TERM_MAX);
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
      for (const c of phraseTop(match, byId, phrase, termLimit, seq)) {
        if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + weight);
        else { counts.set(c.id, weight); repTimes.set(c.id, c.time); }
      }
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
  const top = merged.slice(0, REQUEST_LIMIT);
  let bestRank = 0;
  for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { bestRank = i + 1; break; }
  return bestRank;
}

function main() {
  const entries = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8"));
  const byId = new Map(entries.map((e) => [String(e.question_id), e]));
  const cnRows = fs.readFileSync(CN_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`cn rows: ${cnRows.length}`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 500");

  const stat = () => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0, byType: new Map() });
  const stats = { A: stat(), B: stat() };
  const record = (variant, type, rank) => {
    const s = stats[variant];
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

  for (const row of cnRows) {
    const origId = String(row.questionId).replace(/_cn$/, "");
    const entry = byId.get(origId);
    if (!entry) continue;
    const gold = goldSessions(entry);
    if (gold.size === 0) continue;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) continue;
    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const bySession = new Map(sessions.map((s) => [s.id, s]));
    const question = String(row.question || "");

    const ra = evalOne(match, bySession, question, gold, tokenizeAscii);
    record("A", String(entry.question_type || "unknown"), ra);
    const rb = evalOne(match, bySession, question, gold, tokenizeCjk);
    record("B", String(entry.question_type || "unknown"), rb);
  }

  console.log("=== LongMemEval-CN cross-lingual (Chinese questions over English haystacks) ===");
  for (const [name, s] of Object.entries(stats)) {
    const pct = (n) => (s.n === 0 ? 0 : ((n / s.n) * 100).toFixed(1) + "%");
    console.log(`${name === "A" ? "A shipped-tokenizer " : "B cjk-run-tokenizer"} n=${String(s.n).padEnd(4)} hit@1 ${pct(s.hit1)}  hit@5 ${pct(s.hit5)}  hit@10 ${pct(s.hit10)}  MRR ${(s.mrr / Math.max(1, s.n)).toFixed(4)}`);
  }
  console.log("per-type (A hit@1 / B hit@1):");
  const typeNames = new Set([...stats.A.byType.keys(), ...stats.B.byType.keys()]);
  for (const type of [...typeNames].sort()) {
    const a = stats.A.byType.get(type);
    const b = stats.B.byType.get(type);
    const f = (t) => (t ? `${((t.hit1 / t.n) * 100).toFixed(1)}% (n=${t.n})` : "-");
    console.log(`  ${type.padEnd(24)} A ${f(a).padEnd(14)} B ${f(b)}`);
  }
}

main();
