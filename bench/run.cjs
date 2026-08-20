// Memo benchmark harness — retrieval-layer evaluation on LongMemEval-S.
//
// Protocol (session-level retrieval, matching what memo_search returns at its
// top level):
//   1. For each question, index every haystack SESSION as one FTS5 document
//      (user+assistant message texts concatenated).
//   2. Query = the question text; engine = SQLite FTS5 — the same engine class
//      as DSH's official session-query-sqlite backend.
//   3. Gold = the session(s) whose messages carry `has_answer: true` (oracle).
//   4. Metrics: hit@1 / hit@5 / hit@10 over sessions, MRR.
//
// Run: node run.js [--sessions-only] [--limit N]
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);

function loadOracle(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

// Gold session ids per question: answer_session_ids present in the haystack.
function goldSessions(entry) {
  const haystackIds = new Set((entry.haystack_session_ids || []).map(String));
  const gold = new Set();
  for (const id of entry.answer_session_ids || []) {
    const s = String(id);
    if (haystackIds.has(s)) gold.add(s);
  }
  return gold;
}

// Extract per-question haystacks from the longmemeval_s file: a flat array of
// { question_id, question, haystack_session_ids, haystack_sessions, ... }.
function iterQuestions(bigPath) {
  const raw = fs.readFileSync(bigPath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("unrecognized longmemeval_s structure");
  return data.slice(0, LIMIT);
}

// Normalize one question's haystack into [{ id, text }] — one document per
// session (the same unit memo_search returns at its top level).
function haystackSessions(entry) {
  const ids = entry.haystack_session_ids || [];
  const sessions = entry.haystack_sessions || [];
  return sessions.map((sess, i) => ({
    id: String(ids[i] ?? "s" + i),
    text: (sess || []).map((m) => String(m && m.content !== undefined ? m.content : "")).join("\n"),
  }));
}

function buildQuery(question) {
  const clean = String(question || "").replace(/"/g, " ");
  // Tokenized OR — question-style recall; each token a quoted term.
  const tokens = [...new Set(clean.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  return tokens.map((t) => '"' + t + '"').join(" OR ");
}

function runMode(db, insert, search, questions, build) {
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
    for (const s of sessions) insert.run(s.id, s.text);
    const query = build(entry.question);
    if (query === "") continue;
    let rows = [];
    try { rows = search.all(query, 10).map((r) => String(r.id)); } catch (err) { /* empty */ }
    let rr = 0;
    let hit = false;
    for (let i = 0; i < rows.length; i++) {
      if (gold.has(rows[i])) {
        if (rr === 0) rr = 1 / (i + 1);
        if (!hit) {
          hit = true;
          if (i < 1) hit1++;
          if (i < 5) hit5++;
          if (i < 10) hit10++;
        }
      }
    }
    mrrSum += rr;
    const type = String(entry.question_type || "unknown");
    const t = byType.get(type) || { n: 0, hit1: 0, hit5: 0, mrr: 0 };
    t.n += 1;
    if (rr > 0 && hit) { t.hit1 += (rr === 1 ? 1 : 0); t.hit5 += 1; }
    t.mrr += rr;
    byType.set(type, t);
    if (!hit && misses.length < 5) misses.push({ qid: entry.question_id, query: query.slice(0, 50), gold: [...gold], got: rows.slice(0, 3) });
  }
  const pct = (n) => (total === 0 ? 0 : ((n / total) * 100).toFixed(1) + "%");
  const types = [...byType.entries()].map(([name, t]) => ({
    name,
    n: t.n,
    hit1: ((t.hit1 / t.n) * 100).toFixed(1) + "%",
    hit5: ((t.hit5 / t.n) * 100).toFixed(1) + "%",
    mrr: (t.mrr / t.n).toFixed(3),
  })).sort((a, b) => b.n - a.n);
  return {
    total,
    hit1: `${hit1}  ${pct(hit1)}`,
    hit5: `${hit5}  ${pct(hit5)}`,
    hit10: `${hit10}  ${pct(hit10)}`,
    mrr: (mrrSum / Math.max(1, total)).toFixed(4),
    types,
    misses,
  };
}

function main() {
  const dir = process.env.BENCH_DIR || "/data/data/com.termux/files/home/bench";
  const questions = iterQuestions(dir + "/longmemeval_s.json");
  console.log(`evaluating ${questions.length} questions`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const search = db.prepare(
    "SELECT id, snippet(docs, 1, '[', ']', '…', 8) snip, bm25(docs) rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?"
  );

  const tokenized = runMode(db, insert, search, questions, (q) => buildQuery(q));

  console.log("=== LongMemEval-S retrieval (session-level, FTS5/bm25) ===");
  console.log(`questions: ${tokenized.total}`);
  console.log(`hit@1 ${tokenized.hit1}  hit@5 ${tokenized.hit5}  hit@10 ${tokenized.hit10}  MRR ${tokenized.mrr}`);
  console.log("per question type (hit@1 / hit@5 / MRR):");
  for (const t of tokenized.types) console.log(`  ${t.name.padEnd(24)} n=${String(t.n).padEnd(4)} ${t.hit1}  ${t.hit5}  ${t.mrr}`);
  if (tokenized.misses.length > 0) {
    console.log("sample misses:");
    for (const m of tokenized.misses.slice(0, 3)) console.log(" ", JSON.stringify(m).slice(0, 260));
  }
}

main();
