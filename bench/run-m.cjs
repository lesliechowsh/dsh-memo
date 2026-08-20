// Memo benchmark harness — LongMemEval-M retrieval (scale / anti-overfitting).
//
// Same shipped pipeline as run.cjs (phrase-first + weighted token/pair merge,
// content-word-first window, backend page-size truncation and
// representative-event ranking), evaluated on the M variant: 500 NEW
// questions with ~500-session haystacks each — a fresh question set and a
// ~10x larger pool than S, so the 0.5.x algorithm is checked against
// selection overfitting.
//
// Memory: the M file is ~2.5 GB, so this harness never JSON.parses the whole
// file. A streaming scanner splits the top-level JSON array into one entry
// at a time; each entry is parsed, evaluated, and released. The scanner also
// supports an element cap for smoke runs.
//
// Speed: occurrence counts for 1-token and 2-token phrases are precomputed
// per event (term map / adjacent-pair map) — semantically identical to the
// scan-based counter in run.cjs, just precomputed once.
//
// Run: node run-m.cjs            (full 500 questions)
//      M_LIMIT=3 node run-m.cjs   (smoke)
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.M_LIMIT || 500);
const START = Number(process.env.M_START || 0); // segment support: evaluate entries (START, START+LIMIT]
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const FILE = process.env.M_FILE || DIR + "/longmemeval_m.json";
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const STOP_WORDS = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);
function tokenize(text) {
  const all = [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return [...content, ...all.filter((t) => STOP_WORDS.has(t))].slice(0, 8);
}

function seq(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 1);
}

// Contiguous occurrence counter for arbitrary-length phrases (rare path —
// FTS5 discovery already limits long-phrase candidates).
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
      const tokens = seq(text);
      const termCounts = new Map();
      for (const t of tokens) termCounts.set(t, (termCounts.get(t) || 0) + 1);
      const pairCounts = new Map();
      for (let j = 0; j + 1 < tokens.length; j++) {
        const key = tokens[j] + " " + tokens[j + 1];
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
      return { text, tokens, termCounts, pairCounts, len: Array.from(text).length, time: base + k, seq: k };
    });
    return { id: String(ids[i] ?? "s" + i), idx: i, events };
  });
}

function representative(session, phraseTokens) {
  let best = null;
  for (const ev of session.events) {
    let occ;
    if (phraseTokens.length === 1) occ = ev.termCounts.get(phraseTokens[0]) || 0;
    else if (phraseTokens.length === 2) occ = ev.pairCounts.get(phraseTokens.join(" ")) || 0;
    else occ = occurrencesIn(ev.tokens, phraseTokens);
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

// Streaming scanner: splits the top-level JSON array into complete elements
// by brace-depth tracking (string-aware), scanning each chunk exactly once
// (the old re-scanning design double-counted braces in consumed prefixes and
// blew past the V8 string limit). Calls onElement(jsonString) per item;
// stops after maxElements emissions (0 = unlimited).
function scanTopLevelArray(file, onElement, maxElements) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
    let depth = 0;
    let inString = false;
    let esc = false;
    let pieces = [];
    let elementOpen = false;
    let emitted = 0;
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      resolve();
    }

    function handle(chunk) {
      let i = 0;
      let elemStart = -1; // element start within this chunk (-1 = started earlier)
      while (i < chunk.length) {
        const c = chunk[i];
        if (inString) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inString = false;
          i++;
          continue;
        }
        if (c === '"') { inString = true; i++; continue; }
        if (c === "{") {
          if (depth === 0) { elemStart = i; pieces = []; elementOpen = true; }
          depth++;
          i++;
          continue;
        }
        if (c === "}") {
          depth--;
          if (depth === 0 && elementOpen) {
            pieces.push(chunk.slice(elemStart >= 0 ? elemStart : 0, i + 1));
            onElement(pieces.join(""));
            emitted++;
            pieces = [];
            elementOpen = false;
            elemStart = -1;
            if (maxElements > 0 && emitted >= maxElements) {
              stream.destroy();
              finish();
              return;
            }
          }
          i++;
          continue;
        }
        i++;
      }
      if (depth > 0) {
        pieces.push(chunk.slice(elemStart >= 0 ? elemStart : 0));
        elemStart = -1;
      }
    }

    stream.on("data", (chunk) => {
      if (!done) handle(chunk);
    });
    stream.on("end", finish);
    stream.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    stream.on("close", finish);
  });
}

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 2000");

  let hit1 = 0, hit5 = 0, hit10 = 0, mrrSum = 0, total = 0;
  const byType = new Map();
  const misses = [];
  let scanned = 0;
  let warned = false;

  await scanTopLevelArray(FILE, (json) => {
    scanned++;
    if (scanned <= START || scanned > START + LIMIT) return;
    if (!warned) { console.error(`scanning… (entries ${START + 1}..${START + LIMIT} are evaluated)`); warned = true; }
    let entry;
    try { entry = JSON.parse(json); } catch (err) { return; }
    const gold = goldSessions(entry);
    if (gold.size === 0) return;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) return;
    total++;

    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const byId = new Map(sessions.map((s) => [s.id, s]));

    const question = String(entry.question || "");
    const phraseTokens = seq(question);
    if (phraseTokens.length === 0) return;

    const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT).map((c) => c.id);

    const tokens = tokenize(question).slice(0, TERM_MAX);
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
      const dfCache = new Map();
      const idfOf = (term) => {
        if (!dfCache.has(term)) {
          let rows = [];
          try { rows = match.all(quotePhrase(term)); } catch (err) { /* none */ }
          dfCache.set(term, Math.log((sessions.length + 1) / (1 + Math.min(rows.length, 50))));
        }
        return dfCache.get(term);
      };
      for (const [phrase, lenWeight] of phrases) {
        const pts = phrase.split(" ");
        const isPair = pts.length === 2;
        const weight = isPair ? lenWeight * Math.max(idfOf(pts[0]), idfOf(pts[1])) : 4 * idfOf(pts[0]);
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
      misses.push({ qid: entry.question_id, query: question.slice(0, 50), got: top.slice(0, 3) });
    }
    const type = String(entry.question_type || "unknown");
    const t = byType.get(type) || { n: 0, hit1: 0, hit5: 0, mrr: 0 };
    t.n += 1;
    if (bestRank === 1) t.hit1 += 1;
    if (bestRank >= 1 && bestRank <= 5) t.hit5 += 1;
    if (bestRank > 0) t.mrr += 1 / bestRank;
    byType.set(type, t);
    if (total % 50 === 0) console.error(`progress: ${total} questions evaluated (hit@1 so far ${(hit1 / total * 100).toFixed(1)}%)`);
  }, START + LIMIT);

  const pct = (n) => (total === 0 ? 0 : ((n / total) * 100).toFixed(1) + "%");
  console.log(`=== LongMemEval-M retrieval (product pipeline, ~500-session pools; entries ${START + 1}..${START + LIMIT}) ===`);
  console.log(`scanned: ${scanned}, evaluated: ${total}`);
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
    for (const m of misses.slice(0, 3)) console.log(" ", JSON.stringify(m).slice(0, 220));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
