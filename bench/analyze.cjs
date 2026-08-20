// Memo miss analysis — why does the shipped pipeline lose points on
// LongMemEval-S? Data-first decomposition, no speculation.
//
// For every question this records:
//   - baseline rank (the shipped 0.7.x pipeline, must reproduce 74.8/89.8)
//   - union_all: sessions matched by ANY queried phrase (the discovery set)
//   - union_top10: sessions in any per-phrase top-10 (what the merge sees)
//   - token coverage: how many of the <=8 query tokens appear in the gold
//     session's text (0 = no lexical anchor at all)
//   - gold session size (events, word tokens)
//
// Then classifies every miss (rank 0) into:
//   NO-ANCHOR    gold shares zero query tokens (semantic gap — no lexical
//                pipeline can ever surface it; embedding territory)
//   DISCOVERED-CUT  gold was matched by some phrase but never made any
//                per-phrase top-10 (backend ordering truncated it)
//   MERGE-CUT    gold made a per-phrase top-10 but the merge/slice dropped it
//   NEAR-MISS    gold is in the unbounded merged list at rank 11+
//
// And reports oracle ceilings over the SAME phrase set:
//   - ceiling if every discovered session could be perfectly ranked (hit@1)
//   - ceiling if only per-phrase top-10 lists were usable
//   - one concrete ranking change measured as potential (IDF-weighted rerank
//     of the discovered union — harness-only oracle, labeled as such)
//
// Run: node analyze.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const STOP = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);
function tokenize(text) {
  const src = String(text).toLowerCase();
  const ascii = [...new Set(src.split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = ascii.filter((t) => !STOP.has(t));
  const stops = ascii.filter((t) => STOP.has(t));
  const cjk = [];
  for (const m of src.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length >= 2 && !cjk.includes(run)) cjk.push(run);
  }
  return [...content, ...cjk, ...stops].slice(0, 8);
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

function phraseMatches(match, byId, phrase) {
  let rows = [];
  try { rows = match.all(quotePhrase(phrase)); } catch (err) { /* none */ }
  const cands = [];
  for (const row of rows) {
    const s = byId.get(String(row.id));
    if (!s) continue;
    const rep = representative(s, seq(phrase));
    if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
  }
  cands.sort(backendRank);
  return cands; // full ordered list (not sliced)
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 2000");

  let total = 0;
  let hit1 = 0, hit5 = 0, hit10 = 0;
  let ceilingUnion = 0, ceilingTop10 = 0, ceilingIdfRerank = 0;
  const missCauses = { "no-anchor": 0, "discovered-cut": 0, "merge-cut": 0, "near-miss": 0 };
  const causeByType = new Map();
  const examples = { "no-anchor": [], "discovered-cut": [], "merge-cut": [], "near-miss": [] };
  const coverageHits = [], coverageMisses = [];

  let done = 0;
  for (const entry of questions) {
    const gold = goldSessions(entry);
    if (gold.size === 0) continue;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) continue;
    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const question = String(entry.question || "");
    const tokens = tokenize(question).slice(0, TERM_MAX);
    if (seq(question).length === 0 || tokens.length <= 1) continue;
    total++;

    // phrases: whole question + tokens + consecutive pairs
    const phrases = [];
    phrases.push([question, "phrase-step"]);
    for (const t of tokens) phrases.push([t, t.length]);
    for (let i = 0; i + 1 < tokens.length; i++) { const pair = tokens[i] + " " + tokens[i + 1]; phrases.push([pair, pair.length]); }

    const unionAll = new Set();
    const unionTop10 = new Set();
    const phraseTopMap = new Map();
    for (const [phrase] of phrases) {
      const cands = phraseMatches(match, byId, phrase);
      phraseTopMap.set(phrase, cands);
      for (const c of cands) unionAll.add(c.id);
      for (const c of cands.slice(0, Math.max(REQUEST_LIMIT, 8))) unionTop10.add(c.id);
    }

    // gold coverage: query tokens present in gold session text (word level)
    const goldTextTokens = new Set();
    let goldEvents = 0;
    for (const gid of gold) {
      const s = byId.get(gid);
      if (!s) continue;
      goldEvents += s.events.length;
      for (const ev of s.events) for (const t of ev.tokens) goldTextTokens.add(t);
    }
    let coverage = 0;
    for (const t of tokens) if (goldTextTokens.has(t)) coverage++;
    if (gold.size > 0) (coverage === 0 ? coverageMisses : coverageHits).push(coverage / Math.min(tokens.length, 8));

    // ---- shipped baseline ranking ----
    const phraseStep = phraseTopMap.get(question);
    const counts = new Map();
    const repTimes = new Map();
    for (const [phrase, weight] of phrases.slice(1)) {
      for (const c of phraseTopMap.get(phrase).slice(0, Math.max(REQUEST_LIMIT, 8))) {
        if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + weight);
        else { counts.set(c.id, weight); repTimes.set(c.id, c.time); }
      }
    }
    const tokenRanked = [...counts.keys()]
      .sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a)));
    const merged = [];
    const seen = new Set();
    for (const c of phraseStep.slice(0, REQUEST_LIMIT)) { seen.add(c.id); merged.push(c.id); }
    for (const id of tokenRanked) if (!seen.has(id)) merged.push(id);
    const top10 = merged.slice(0, REQUEST_LIMIT);

    let rank = 0;
    for (let i = 0; i < top10.length; i++) if (gold.has(top10[i])) { rank = i + 1; break; }
    if (rank === 1) hit1++;
    if (rank >= 1 && rank <= 5) hit5++;
    if (rank >= 1 && rank <= 10) hit10++;

    // ---- ceilings over the SAME phrase set ----
    let goldInUnion = false;
    for (const gid of gold) if (unionAll.has(gid)) goldInUnion = true;
    if (goldInUnion) ceilingUnion++;
    let goldInTop10Union = false;
    for (const gid of gold) if (unionTop10.has(gid)) goldInTop10Union = true;
    if (goldInTop10Union) ceilingTop10++;

    // IDF rerank oracle over unionAll (harness-only, product cannot get true df)
    {
      let hit = false;
      if (goldInUnion) {
        const dfCache = new Map();
        const idf = (term) => {
          if (!dfCache.has(term)) {
            let rows = [];
            try { rows = match.all(quotePhrase(term)); } catch (e) { /* none */ }
            dfCache.set(term, rows.length);
          }
          const df = dfCache.get(term);
          return Math.log((sessions.length + 1) / (1 + df));
        };
        const scores = new Map();
        const times = new Map();
        for (const id of unionAll) {
          scores.set(id, 0);
          const s = byId.get(id);
          if (s) times.set(id, s.events[s.events.length - 1].time);
        }
        for (const [phrase, weight] of phrases.slice(1)) {
          const pts = phrase.split(" ");
          const isPair = pts.length === 2;
          const w = isPair ? 2 * Math.max(idf(pts[0]), idf(pts[1])) : 4 * idf(pts[0]);
          for (const c of phraseTopMap.get(phrase).slice(0, Math.max(REQUEST_LIMIT, 8))) {
            scores.set(c.id, scores.get(c.id) + w);
          }
        }
        const ranked = [...scores.entries()].sort((a, b) => (b[1] - a[1]) || (times.get(b[0]) - times.get(a[0])));
        const top = ranked.slice(0, REQUEST_LIMIT);
        for (const [id] of top) if (gold.has(id)) { hit = true; break; }
      }
      if (hit) ceilingIdfRerank++;
    }

    // ---- miss classification ----
    const type = String(entry.question_type || "unknown");
    if (rank === 0) {
      const fullRank = merged.findIndex((id) => gold.has(id)) + 1; // 0 if absent
      let cause;
      if (coverage === 0) cause = "no-anchor";
      else if (!goldInTop10Union) cause = "discovered-cut";
      else if (fullRank === 0) cause = "merge-cut";
      else cause = "near-miss";
      missCauses[cause]++;
      const t = causeByType.get(type) || new Map();
      t.set(cause, (t.get(cause) || 0) + 1);
      causeByType.set(type, t);
      if (examples[cause].length < 3) {
        examples[cause].push({ q: question.slice(0, 70), coverage, goldEvents, goldSessions: [...gold].length, rank: fullRank });
      }
    }
    done++;
    if (done % 100 === 0) console.error(`progress: ${done} questions`);
  }

  const pct = (n) => ((n / total) * 100).toFixed(1) + "%";
  console.log("=== baseline (sanity: must equal published 74.8 / 89.8 / 95.2) ===");
  console.log(`hit@1 ${pct(hit1)}  hit@5 ${pct(hit5)}  hit@10 ${pct(hit10)}`);
  console.log("=== oracle ceilings over the SAME phrase set ===");
  console.log(`hit@1 if every discovered session could be ranked perfectly: ${pct(ceilingUnion)}`);
  console.log(`hit@1 if per-phrase top-10 lists were the only candidates:  ${pct(ceilingTop10)}`);
  console.log(`hit@1 with an IDF rerank of the top-10 candidate lists (harness oracle, true df): ${pct(ceilingIdfRerank)}`);
  console.log("=== miss decomposition (rank 0 only) ===");
  const misses = total - hit10;
  for (const [cause, n] of Object.entries(missCauses)) {
    console.log(`  ${cause.padEnd(16)} ${n}  (${(n / Math.max(1, misses) * 100).toFixed(1)}% of misses, ${(n / total * 100).toFixed(1)}% of all)`);
  }
  console.log("=== gold token coverage (mean over questions, hits vs misses) ===");
  const mean = (a) => a.length === 0 ? 0 : (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  console.log(`  anchored questions (coverage>0): ${mean(coverageHits)}   unanchored (coverage=0): ${coverageMisses.length}`);
  console.log("=== miss causes per question type ===");
  for (const [type, t] of [...causeByType.entries()].sort()) {
    const parts = Object.entries(missCauses).map(([c]) => `${c.slice(0, 5)}=${t.get(c) || 0}`);
    console.log(`  ${type.padEnd(24)} ${parts.join(" ")}`);
  }
  console.log("=== examples ===");
  for (const [cause, list] of Object.entries(examples)) {
    console.log(`-- ${cause}:`);
    for (const e of list) console.log(`   ${JSON.stringify(e)}`);
  }
}

main();
