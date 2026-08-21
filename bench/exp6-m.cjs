// Memo benchmark harness — EXP6-M: in-memory inverted-index retrieval on
// LongMemEval-M (scale / anti-overfitting check for the A-prime path).
//
// Same retrieval as exp6.cjs (token-level matching, inverted index built per
// haystack, exact-df IDF, phrase-first merge), evaluated on the M variant:
// 500 new questions with ~500-session haystacks each. Falsifier: M direction
// must hold ≥ the FTS-era 0.8.0 M numbers (hit@1 54.6% / hit@5 78.6% /
// MRR 0.645) before the A-prime path ships.
//
// Memory: ~2.5 GB file, never JSON.parsed whole — the streaming scanner from
// run-m.cjs (string-aware brace tracking, chunk scanned once) feeds one
// entry at a time.
//
// Run: node exp6-m.cjs              (full 500 questions)
//      M_LIMIT=3 node exp6-m.cjs    (smoke)
//      M_START=0 M_LIMIT=100 node exp6-m.cjs   (segment)
"use strict";
const fs = require("node:fs");

const LIMIT = Number(process.env.M_LIMIT || 500);
const START = Number(process.env.M_START || 0);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const FILE = process.env.M_FILE || DIR + "/longmemeval_m.json";
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const STOP_WORDS = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);

// Token sequence: ASCII word runs (len >= 1) + contiguous Han runs (len >= 2)
// as single tokens — unicode61 behavior mirrored by the shipped tokenizer.
function seq(text) {
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(/[a-z0-9]+|\p{Script=Han}+/gu)) {
    if (/\p{Script=Han}/u.test(m[0])) {
      if (m[0].length >= 2) out.push(m[0]);
    } else {
      out.push(m[0]);
    }
  }
  return out;
}

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

// Inverted index: term -> Map(sessionId -> eventIndices[]), built once per
// haystack (mirrors A-prime).
function buildIndex(sessions) {
  const index = new Map();
  for (const s of sessions) {
    s.events.forEach((ev, k) => {
      for (const t of ev.termCounts.keys()) {
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

function representative(session, phraseTokens) {
  let best = null;
  for (const ev of session.events) {
    let occ;
    if (phraseTokens.length === 1) occ = ev.termCounts.get(phraseTokens[0]) || 0;
    else if (phraseTokens.length === 2) occ = ev.pairCounts.get(phraseTokens.join(" ")) || 0;
    else occ = occurrencesIn(ev.tokens, phraseTokens);
    if (occ === 0) continue;
    if (best === null || occ > best.occ || (occ === best.occ && (ev.len < best.len ||
      (ev.len === best.len && (ev.time > best.time || (ev.time === best.time && ev.seq > best.seq)))))) {
      best = { occ, len: ev.len, time: ev.time, seq: ev.seq };
    }
  }
  return best;
}

function backendRank(a, b) {
  return b.occ - a.occ || a.len - b.len || b.time - a.time ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || b.seq - a.seq;
}

function matchingSessions(sessions, index, phraseTokens) {
  if (phraseTokens.length === 0) return [];
  const first = index.get(phraseTokens[0]);
  if (first === undefined) return [];
  const out = [];
  for (const s of sessions) {
    const evs = first.get(s.id);
    if (evs === undefined) continue;
    const rep = representative(s, phraseTokens);
    if (rep !== null) out.push({ id: s.id, occ: rep.occ, len: rep.len, time: rep.time, seq: rep.seq });
  }
  return out;
}

// Streaming scanner (run-m.cjs's fixed design: each chunk scanned once,
// string-aware brace tracking, cross-chunk element accumulation).
function scanTopLevelArray(file, onElement, maxElements) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
    let depth = 0, inString = false, esc = false;
    let pieces = [], elementOpen = false, emitted = 0, done = false;
    function finish() { if (!done) { done = true; resolve(); } }
    function handle(chunk) {
      let i = 0, elemStart = -1;
      while (i < chunk.length) {
        const c = chunk[i];
        if (inString) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inString = false;
          i++; continue;
        }
        if (c === '"') { inString = true; i++; continue; }
        if (c === "{") {
          if (depth === 0) { elemStart = i; pieces = []; elementOpen = true; }
          depth++; i++; continue;
        }
        if (c === "}") {
          depth--;
          if (depth === 0 && elementOpen) {
            pieces.push(chunk.slice(elemStart >= 0 ? elemStart : 0, i + 1));
            onElement(pieces.join(""));
            emitted++;
            pieces = []; elementOpen = false; elemStart = -1;
            if (maxElements > 0 && emitted >= maxElements) { stream.destroy(); finish(); return; }
          }
          i++; continue;
        }
        i++;
      }
      if (depth > 0) { pieces.push(chunk.slice(elemStart >= 0 ? elemStart : 0)); elemStart = -1; }
    }
    stream.on("data", (chunk) => { if (!done) handle(chunk); });
    stream.on("end", finish);
    stream.on("error", (err) => { if (!done) { done = true; reject(err); } });
    stream.on("close", finish);
  });
}

async function main() {
  let hit1 = 0, hit5 = 0, hit10 = 0, mrrSum = 0, total = 0;
  const byType = new Map();
  const misses = [];
  let scanned = 0, warned = false;
  let indexMs = 0, queryMs = 0;

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

    let t0 = Date.now();
    const index = buildIndex(sessions);
    indexMs += Date.now() - t0;

    const question = String(entry.question || "");
    const phraseTokens = seq(question);
    if (phraseTokens.length === 0) return;

    t0 = Date.now();
    const phraseRanked = matchingSessions(sessions, index, phraseTokens)
      .sort(backendRank).slice(0, REQUEST_LIMIT).map((c) => c.id);

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
        for (const c of matchingSessions(sessions, index, pts).sort(backendRank).slice(0, termLimit)) {
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
    queryMs += Date.now() - t0;

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
    if (total % 20 === 0) console.error(`progress: ${total} questions evaluated (hit@1 so far ${(hit1 / total * 100).toFixed(1)}%)`);
  }, START + LIMIT);

  const pct = (n) => (total === 0 ? 0 : ((n / total) * 100).toFixed(1) + "%");
  console.log(`=== LongMemEval-M retrieval (EXP6 scan path; entries ${START + 1}..${START + LIMIT}) ===`);
  console.log(`scanned: ${scanned}, evaluated: ${total}`);
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
    for (const m of misses.slice(0, 3)) console.log(" ", JSON.stringify(m).slice(0, 220));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
