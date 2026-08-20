// Memo experiment #4-M — M-scale validation of S-scale winners.
// Variants: base (shipped 0.7.0), idfProxy (A2 stoplist + capped-50 df
// proxy IDF), idfOracle (A2 stoplist + true df IDF), lenIdf (A2 stoplist +
// length × true-df IDF). Streaming, segmentable (M_START/M_LIMIT).
// Run: EXP4_FILTER=idf M_START=0 M_LIMIT=50 node exp4-m.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.M_LIMIT || 500);
const START = Number(process.env.M_START || 0);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const FILE = process.env.M_FILE || DIR + "/longmemeval_m.json";
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const BASE_STOP = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);
const A2_STOP = new Set([...BASE_STOP, "ever","whether","discuss","last","week","have","has","had","will","your","my","me","our","their","some"]);

const ALL_VARIANTS = [
  { name: "base", stop: BASE_STOP, weight: "len" },
  { name: "idfProxy", stop: A2_STOP, weight: "idfProxy" },
  { name: "idfOracle", stop: A2_STOP, weight: "idfOracle" },
  { name: "lenIdfOracle", stop: A2_STOP, weight: "lenIdfOracle" },
  { name: "lenIdfProxy", stop: A2_STOP, weight: "lenIdfProxy" },
];
const EXP4_FILTER = process.env.EXP4_FILTER || "";
const SELECTED = EXP4_FILTER ? ALL_VARIANTS.filter((v) => v.name.includes(EXP4_FILTER) || v.name === "base") : ALL_VARIANTS;

function tokenize(text, stop) {
  const src = String(text).toLowerCase();
  const ascii = [...new Set(src.split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = ascii.filter((t) => !stop.has(t));
  const stops = ascii.filter((t) => stop.has(t));
  const cjk = [];
  for (const m of src.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length >= 2 && !cjk.includes(run)) cjk.push(run);
  }
  return [...content, ...cjk, ...stops].slice(0, 8);
}

function seq(text) {
  return String(text).toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/).filter((t) => t.length >= 1);
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

function trueDf(match, term) {
  let rows = [];
  try { rows = match.all(quotePhrase(term)); } catch (err) { /* none */ }
  return rows.length;
}

// Streaming scanner (fixed design: scan each chunk once, offset accounting)
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
      let elemStart = -1;
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

function evalVariant(v, match, byId, question, gold, poolSize) {
  const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT).map((c) => c.id);
  const tokens = tokenize(question, v.stop).slice(0, TERM_MAX);
  const counts = new Map();
  const repTimes = new Map();
  if (tokens.length > 1) {
    const termLimit = Math.max(REQUEST_LIMIT, 8);
    const phrases = [];
    for (const t of tokens) phrases.push([t, t]);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const pair = tokens[i] + " " + tokens[i + 1];
      phrases.push([pair, pair]);
    }
    for (const [phrase] of phrases) {
      const phraseTokens = phrase.split(" ");
      const isPair = phraseTokens.length === 2;
      let weight;
      if (v.weight === "len") {
        weight = phrase.length;
      } else {
        const df = trueDf(match, phraseTokens[0]);
        const dfCapped = Math.min(df, 50);
        const idf = Math.log((poolSize + 1) / (1 + df));
        const idfProxy = Math.log((poolSize + 1) / (1 + dfCapped));
        if (isPair) weight = phrase.length;
        else if (v.weight === "idfOracle") weight = 4 * idf;
        else if (v.weight === "idfProxy") weight = 4 * idfProxy;
        else if (v.weight === "lenIdfOracle") weight = phraseTokens[0].length * idf;
        else weight = phraseTokens[0].length * idfProxy;
      }
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
  for (let i = 0; i < top.length; i++) if (gold.has(top[i])) return i + 1;
  return 0;
}

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 2000");

  const stat = () => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0, byType: new Map() });
  const stats = new Map(SELECTED.map((v) => [v.name, stat()]));
  const record = (name, type, rank) => {
    const s = stats.get(name);
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

  let scanned = 0;
  let warned = false;
  let evaluated = 0;

  await scanTopLevelArray(FILE, (json) => {
    scanned++;
    if (scanned <= START || scanned > START + LIMIT) return;
    if (!warned) { console.error(`evaluating entries ${START + 1}..${START + LIMIT}, variants: ${SELECTED.map((v) => v.name).join(", ")}`); warned = true; }
    let entry;
    try { entry = JSON.parse(json); } catch (err) { return; }
    const gold = goldSessions(entry);
    if (gold.size === 0) return;
    const sessions = haystackSessions(entry);
    if (sessions.length === 0) return;
    evaluated++;

    db.exec("DELETE FROM docs");
    for (const s of sessions) insert.run(s.id, s.events.map((e) => e.text).join("\n"));
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const question = String(entry.question || "");
    if (seq(question).length === 0) return;

    for (const v of SELECTED) {
      const rank = evalVariant(v, match, byId, question, gold, sessions.length);
      record(v.name, String(entry.question_type || "unknown"), rank);
    }
    if (evaluated % 25 === 0) console.error(`progress: ${evaluated} questions in segment`);
  }, START + LIMIT);

  const pct = (n) => (evaluated === 0 ? 0 : ((n / evaluated) * 100).toFixed(1) + "%");
  console.log(`=== M-segment ${START + 1}..${START + LIMIT} (evaluated ${evaluated}) ===`);
  for (const v of SELECTED) {
    const s = stats.get(v.name);
    console.log(`${v.name.padEnd(10)} n=${String(s.n).padEnd(4)} hit@1 ${pct(s.hit1)}  hit@5 ${pct(s.hit5)}  hit@10 ${pct(s.hit10)}  MRR ${(s.mrr / Math.max(1, s.n)).toFixed(4)}`);
  }
  console.log("per-type hit@1 / hit@5 / MRR:");
  const typeNames = new Set();
  for (const s of stats.values()) for (const t of s.byType.keys()) typeNames.add(t);
  for (const type of [...typeNames].sort()) {
    const line = [type.padEnd(24)];
    for (const v of SELECTED) {
      const t = stats.get(v.name).byType.get(type);
      if (!t) { line.push("     -   "); continue; }
      line.push(`${((t.hit1 / t.n) * 100).toFixed(1)} ${((t.hit5 / t.n) * 100).toFixed(1)} ${(t.mrr / t.n).toFixed(2)}`);
    }
    console.log("  " + line.join(" | "));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
