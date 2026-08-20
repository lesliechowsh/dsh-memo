// Memo benchmark harness — LoCoMo10 retrieval (secondary benchmark).
//
// Reproduces the exact pipeline `memo_search` ships (phrase-first + weighted
// token/pair merge with the official backend's page-size truncation and
// representative-event ranking), evaluated on the LoCoMo10 QA annotations:
//
//   - Haystack per question = the sessions of ONE conversation (the unit a
//     workspace would hold; sessions are the units memo_search returns).
//   - Gold = the sessions containing the answer's evidence turns (dia_id).
//   - One FTS5 document per turn (event), same engine class and default
//     unicode61 tokenizer as the official backend; ranking reimplemented in
//     JS as in run.cjs.
//   - Time proxy: real session date strings ("1:56 pm on 8 May, 2023") plus
//     in-session turn order.
//
// Data: https://github.com/snap-research/LoCoMo/blob/master/data/locomo10.json
// (the repo's in-tree release; 10 conversations, 1986 QA samples).
//
// Run: node locomo.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const FILE = process.env.LOCOMO_FILE || ((process.env.HOME || ".") + "/locomo10.json");
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

// "1:56 pm on 8 May, 2023" -> epoch ms
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
function parseDate(s) {
  const m = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})/.exec(String(s));
  if (!m || MONTHS[m[5]] === undefined) return NaN;
  let h = Number(m[1]);
  if (m[3] === "pm" && h !== 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  const mo = String(MONTHS[m[5]]).padStart(2, "0");
  return Date.parse(`${m[6]}-${mo}-${String(m[4]).padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[2]}:00Z`);
}

// Sessions of one conversation: { id, base (ms), events: [{text,tokens,len,time,seq}] }
function buildSessions(convObj) {
  const sessionKeys = Object.keys(convObj).filter((k) => /^session_\d+$/.test(k));
  sessionKeys.sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
  const sessions = [];
  for (const key of sessionKeys) {
    const turns = convObj[key] || [];
    const dateStr = String(convObj[key + "_date_time"] || "");
    const parsed = parseDate(dateStr);
    const base = Number.isFinite(parsed) ? parsed : sessions.length * 86400000;
    const events = turns.map((turn, k) => {
      const text = String(turn && turn.text !== undefined ? turn.text : "");
      return { text, tokens: seq(text), len: Array.from(text).length, time: base + k, seq: k, diaId: turn && turn.dia_id ? String(turn.dia_id) : null };
    });
    sessions.push({ id: key, base, events });
  }
  return sessions;
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

function phraseTop(match, byId, phrase, topN) {
  let rows = [];
  try { rows = match.all(quotePhrase(phrase)); } catch (err) { /* no matches */ }
  const cands = [];
  for (const row of rows) {
    const s = byId.get(String(row.id));
    if (!s) continue;
    const rep = representative(s, seq(phrase));
    if (rep) cands.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
  }
  cands.sort(backendRank);
  return cands.slice(0, topN);
}

function main() {
  const conversations = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 500");

  let hit1 = 0, hit5 = 0, hit10 = 0, mrrSum = 0, total = 0;
  const byCategory = new Map();
  const misses = [];

  for (const conv of conversations) {
    const sessions = buildSessions(conv.conversation);
    if (sessions.length === 0) continue;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const diaToSession = new Map();
    for (const s of sessions) for (const ev of s.events) if (ev.diaId) diaToSession.set(ev.diaId, s.id);

    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));

    for (const qa of conv.qa || []) {
      const gold = new Set();
      for (const dia of qa.evidence || []) {
        const sid = diaToSession.get(String(dia));
        if (sid !== undefined) gold.add(sid);
      }
      if (gold.size === 0) continue;
      const question = String(qa.question || "");
      const tokens = tokenize(question).slice(0, TERM_MAX);
      if (tokens.length === 0) continue;
      total++;

      const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT).map((c) => c.id);

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
          for (const c of phraseTop(match, byId, phrase, termLimit)) {
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
      for (let i = 0; i < top.length; i++) {
        if (gold.has(top[i])) { bestRank = i + 1; break; }
      }
      if (bestRank > 0) {
        if (bestRank === 1) hit1++;
        if (bestRank <= 5) hit5++;
        if (bestRank <= 10) hit10++;
        mrrSum += 1 / bestRank;
      } else if (misses.length < 5) {
        misses.push({ q: question.slice(0, 60), gold: [...gold], got: top.slice(0, 3) });
      }
      const cat = String(qa.category ?? "unknown");
      const t = byCategory.get(cat) || { n: 0, hit1: 0, hit5: 0, mrr: 0 };
      t.n += 1;
      if (bestRank === 1) t.hit1 += 1;
      if (bestRank >= 1 && bestRank <= 5) t.hit5 += 1;
      if (bestRank > 0) t.mrr += 1 / bestRank;
      byCategory.set(cat, t);
    }
  }

  const pct = (n) => (total === 0 ? 0 : ((n / total) * 100).toFixed(1) + "%");
  console.log("=== LoCoMo10 retrieval (product pipeline: phrase + weighted token/pair merge) ===");
  console.log(`questions: ${total}`);
  console.log(`hit@1 ${hit1}  ${pct(hit1)}   hit@5 ${hit5}  ${pct(hit5)}   hit@10 ${hit10}  ${pct(hit10)}   MRR ${(mrrSum / Math.max(1, total)).toFixed(4)}`);
  console.log("per category (hit@1 / hit@5 / MRR):");
  for (const [cat, t] of [...byCategory.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  category ${cat.padEnd(6)} n=${String(t.n).padEnd(4)} ${((t.hit1 / t.n) * 100).toFixed(1)}%  ${((t.hit5 / t.n) * 100).toFixed(1)}%  ${(t.mrr / t.n).toFixed(3)}`);
  }
  if (misses.length > 0) {
    console.log("sample misses:");
    for (const m of misses.slice(0, 3)) console.log(" ", JSON.stringify(m).slice(0, 220));
  }
}

main();
