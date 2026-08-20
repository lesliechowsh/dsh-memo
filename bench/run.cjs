// Memo benchmark harness — retrieval-layer evaluation on LongMemEval-S.
//
// This harness reproduces the EXACT retrieval algorithm `memo_search` ships:
//   1. Phrase step: the whole question as one quoted FTS5 phrase (matches the
//      official API's inert-phrase semantics) — finds sessions containing the
//      verbatim question.
//   2. Tokenized step: each question token as a separate quoted-phrase search
//      (up to 8 tokens), sessions merged and ranked by matched-term count,
//      tie-broken by session recency (haystack order here).
//   3. Phrase hits are listed first, then tokenized hits, deduplicated.
//
// The FTS5 table here is the same engine class the official backend uses;
// ranking is replicated in JS so the harness measures the product algorithm,
// not an idealized BM25 baseline.
//
// Protocol: one document per haystack session (the unit memo_search returns);
// gold = the question's answer_session_ids present in the haystack; metrics =
// hit@1 / hit@5 / hit@10 over sessions, MRR, with a per-question-type
// breakdown (hit@5 here means first gold rank <= 5).
//
// Run: node run.cjs            (full 500 questions)
//      LIMIT=10 node run.cjs   (smoke)
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");

function tokenize(text) {
  return [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
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
  const sessions = entry.haystack_sessions || [];
  return sessions.map((sess, i) => ({
    id: String(ids[i] ?? "s" + i),
    idx: i,
    text: (sess || []).map((m) => String(m && m.content !== undefined ? m.content : "")).join("\n"),
  }));
}

// Count how many distinct question tokens appear in a session's text —
// the "matched-term count" the product ranks by.
function matchCount(text, tokens) {
  const words = new Set(tokenize(text));
  let n = 0;
  for (const t of tokens) if (words.has(t)) n++;
  return n;
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const phraseMatch = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 200");
  const termMatch = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 200");

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
    const byId = new Map(sessions.map((s) => [s.id, s]));

    const question = String(entry.question || "").replace(/"/g, " ");
    const tokens = tokenize(question).slice(0, 8);
    if (tokens.length === 0) continue;

    // Phrase step: whole question as one inert phrase.
    const phraseIds = [];
    try {
      for (const row of phraseMatch.all('"' + question.trim() + '"')) phraseIds.push(String(row.id));
    } catch (err) { /* no phrase matches */ }

    // Tokenized step: one search per term; sessions ranked by matched-term
    // count (the product algorithm), tie-broken by haystack order.
    // Measured experiments, kept as roadmap notes: IDF-weighted merge lifts
    // hit@1 45.8→57.2 / MRR 0.58→0.66 in the harness but needs exact
    // corpus-wide df the official API cannot expose — not shipped.
    const counts = new Map();
    for (const term of tokens) {
      let rows = [];
      try { rows = termMatch.all('"' + term + '"'); } catch (err) { /* term query failed */ }
      for (const row of rows) {
        const id = String(row.id);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    const rankByCount = (a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || b.idx - a.idx;
    const tokenRanked = [...counts.keys()]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort(rankByCount)
      .map((s) => s.id);

    const phraseRanked = phraseIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => matchCount(b.text, tokens) - matchCount(a.text, tokens) || b.idx - a.idx)
      .map((s) => s.id);

    const merged = [];
    const seen = new Set();
    for (const id of [...phraseRanked, ...tokenRanked]) {
      if (!seen.has(id)) { seen.add(id); merged.push(id); }
    }

    let bestRank = 0;
    for (let i = 0; i < merged.length && i < 10; i++) {
      if (gold.has(merged[i])) { bestRank = i + 1; break; }
    }
    if (bestRank > 0) {
      if (bestRank === 1) hit1++;
      if (bestRank <= 5) hit5++;
      if (bestRank <= 10) hit10++;
      mrrSum += 1 / bestRank;
    } else if (misses.length < 5) {
      misses.push({ qid: entry.question_id, query: question.slice(0, 50), gold: [...gold], got: merged.slice(0, 3) });
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
  console.log("=== LongMemEval-S retrieval (product algorithm: phrase + per-term count merge) ===");
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
