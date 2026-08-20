// Memo experiment #4 — final sparse-retrieval ceiling sweep (S-scale).
//
// Three axes, one parameterized harness, no intuition-driven changes:
//   STOP — stopword-list ablation: candidates ever/whether/discuss/last/week
//          etc. grouped; per-type reporting so temporal-reasoning damage
//          (last/week carry time meaning) is visible.
//   PHRASE — phrase-first hard ordering vs competitive: phrase hits get a
//            finite bonus and rank in the same pool as weighted hits.
//   WEIGHT — length proxy vs IDF: oracle-df IDF (harness-only, the true
//            document frequency) vs capped-50 proxy IDF (what the product
//            could actually observe through paged searchSessions results),
//            and length×idf.
//
// All variants share one FTS5 index build per question. Baseline A0 must
// reproduce the shipped 0.7.0 S numbers exactly (hit@1 74.8% · hit@5 89.8% ·
// hit@10 95.2% · MRR 0.8116) — any drift means the harness is wrong.
//
// Run: node exp4.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const BASE_STOP = ["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"];
const ADD_A1 = ["ever","whether","discuss","last","week"];
const ADD_A2 = [...ADD_A1, "have","has","had","will","your","my","me","our","their","some"];
const ADD_A3 = [...ADD_A1, "have","has","had","will","your","my"];

function makeStop(extra) {
  return new Set([...BASE_STOP, ...(extra || [])]);
}

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

// true document frequency of one term in the current pool (FTS5 match count)
function trueDf(match, term) {
  let rows = [];
  try { rows = match.all(quotePhrase(term)); } catch (err) { /* none */ }
  return rows.length;
}

const VARIANTS = [];

// ---- Run A: STOP ablation (hard phrase order, length weights) ----
for (const [name, extra] of [["A0-base", null], ["A1+5", ADD_A1], ["A2+15", ADD_A2], ["A3+12", ADD_A3]]) {
  VARIANTS.push({ name, stop: makeStop(extra), phraseMode: "hard", bonus: 0, weightMode: "len" });
}
// ---- Run B: phrase order (A1 stop list, length weights) ----
for (const [name, bonus] of [["B-hard", 0], ["B-bonus12", 12], ["B-bonus24", 24], ["B-bonus48", 48]]) {
  VARIANTS.push({ name, stop: makeStop(ADD_A2), phraseMode: bonus === 0 ? "hard" : "bonus", bonus, weightMode: "len" });
}
// ---- Run C: weight function (A1 stop, hard phrase order) ----
for (const [name, wm] of [["C-len", "len"], ["C-idfOracle", "idfOracle"], ["C-idfProxy", "idfProxy"], ["C-lenIdf", "lenIdf"]]) {
  VARIANTS.push({ name, stop: makeStop(ADD_A2), phraseMode: "hard", bonus: 0, weightMode: wm });
}

// Segment filter: EXP4_FILTER=A runs only variants whose name starts with "A".
const EXP4_FILTER = process.env.EXP4_FILTER || "";
const SELECTED = EXP4_FILTER ? VARIANTS.filter((v) => v.name.startsWith(EXP4_FILTER)) : VARIANTS;

function evalVariant(v, match, byId, entry, question, gold, poolSize) {
  const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT); // [{id,time}]
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
      if (v.weightMode === "len") {
        weight = phrase.length;
      } else {
        const df = trueDf(match, phraseTokens[0]);
        const dfCapped = Math.min(df, 50);
        const idf = Math.log((poolSize + 1) / (1 + df));
        const idfProxy = Math.log((poolSize + 1) / (1 + dfCapped));
        if (isPair) weight = phrase.length;
        else if (v.weightMode === "idfOracle") weight = 4 * idf;
        else if (v.weightMode === "idfProxy") weight = 4 * idfProxy;
        else weight = phraseTokens[0].length * idf;
      }
      for (const c of phraseTop(match, byId, phrase, termLimit)) {
        if (counts.has(c.id)) counts.set(c.id, counts.get(c.id) + weight);
        else { counts.set(c.id, weight); repTimes.set(c.id, c.time); }
      }
    }
  }

  let ranked;
  if (v.phraseMode === "hard") {
    const tokenRanked = [...counts.keys()]
      .sort((a, b) => (counts.get(b) - counts.get(a)) || (repTimes.get(b) - repTimes.get(a)))
      .slice(0, REQUEST_LIMIT);
    const merged = [];
    const seen = new Set();
    for (const c of phraseRanked) { seen.add(c.id); merged.push(c.id); }
    for (const id of tokenRanked) if (!seen.has(id)) merged.push(id);
    ranked = merged;
  } else {
    const pooled = new Map();
    phraseRanked.forEach((c, idx) => {
      pooled.set(c.id, { score: v.bonus + (REQUEST_LIMIT - idx), time: c.time });
    });
    for (const [id, score] of counts) {
      const cur = pooled.get(id);
      if (cur !== undefined) pooled.set(id, { score: Math.max(cur.score, score), time: cur.time });
      else pooled.set(id, { score, time: repTimes.get(id) || 0 });
    }
    ranked = [...pooled.entries()]
      .sort((a, b) => (b[1].score - a[1].score) || (b[1].time - a[1].time))
      .map((e) => e[0]);
  }
  const top = ranked.slice(0, REQUEST_LIMIT);
  for (let i = 0; i < top.length; i++) if (gold.has(top[i])) return i + 1;
  return 0;
}

function main() {
  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions x ${SELECTED.length} variants`);

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
    if (seq(question).length === 0) continue;

    for (const v of SELECTED) {
      const rank = evalVariant(v, match, byId, entry, question, gold, sessions.length);
      record(v.name, String(entry.question_type || "unknown"), rank);
    }
    done++;
    if (done % 100 === 0) console.error(`progress: ${done} questions`);
  }

  console.log("=== overall (hit@1 / hit@5 / hit@10 / MRR) ===");
  for (const v of SELECTED) {
    const s = stats.get(v.name);
    const pct = (n) => ((n / s.n) * 100).toFixed(1) + "%";
    console.log(`${v.name.padEnd(11)} n=${String(s.n).padEnd(4)} ${pct(s.hit1)}  ${pct(s.hit5)}  ${pct(s.hit10)}  MRR ${(s.mrr / s.n).toFixed(4)}`);
  }
  console.log("=== per-type hit@1 / hit@5 / MRR ===");
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

main();
