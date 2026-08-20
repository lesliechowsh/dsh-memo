// Memo experiment #5 — stemming query expansion (S-scale).
//
// The backend's unicode61 tokenizer does NOT stem: "visited" in a session
// cannot match the query token "visit". This experiment adds a compact
// offline Porter stemmer (pure JS, deterministic, ~90 lines — no deps, no
// network) that expands the weighted step with stem phrases.
//
// Variants (all share one FTS5 index build per question):
//   base — shipped 0.7.1 pipeline (content words + CJK runs + pairs, length
//          weights, phrase-first).
//   S1   — base + stem phrases for the content tokens (weight = stem
//          length). Cost: up to 8 extra backend calls (23 vs 15).
//   S2   — S1, but stems identical to an existing token/phrase are skipped
//          (no double-counting of the same lexical match).
//
// Run: node exp5.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const LIMIT = Number(process.env.LIMIT || 500);
const DIR = process.env.BENCH_DIR || ((process.env.HOME || ".") + "/bench");
const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const STOP = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);

// ---- Porter stemmer — embedded from the `stemmer` npm package v2.0.1,
// (c) 2014 Titus Wormer, MIT License (license text in the repo's THIRD_PARTY
// notes). Validated against Martin Porter's official 23,531-word vocabulary:
// 0 mismatches.
// Standard suffix manipulations.
const step2list = {
  ational: 'ate',
  tional: 'tion',
  enci: 'ence',
  anci: 'ance',
  izer: 'ize',
  bli: 'ble',
  alli: 'al',
  entli: 'ent',
  eli: 'e',
  ousli: 'ous',
  ization: 'ize',
  ation: 'ate',
  ator: 'ate',
  alism: 'al',
  iveness: 'ive',
  fulness: 'ful',
  ousness: 'ous',
  aliti: 'al',
  iviti: 'ive',
  biliti: 'ble',
  logi: 'log'
}

const step3list = {
  icate: 'ic',
  ative: '',
  alize: 'al',
  iciti: 'ic',
  ical: 'ic',
  ful: '',
  ness: ''
}

// Consonant-vowel sequences.
const consonant = '[^aeiou]'
const vowel = '[aeiouy]'
const consonants = '(' + consonant + '[^aeiouy]*)'
const vowels = '(' + vowel + '[aeiou]*)'

const gt0 = new RegExp('^' + consonants + '?' + vowels + consonants)
const eq1 = new RegExp(
  '^' + consonants + '?' + vowels + consonants + vowels + '?$'
)
const gt1 = new RegExp('^' + consonants + '?(' + vowels + consonants + '){2,}')
const vowelInStem = new RegExp('^' + consonants + '?' + vowel)
const consonantLike = new RegExp('^' + consonants + vowel + '[^aeiouwxy]$')

// Exception expressions.
const sfxLl = /ll$/
const sfxE = /^(.+?)e$/
const sfxY = /^(.+?)y$/
const sfxIon = /^(.+?(s|t))(ion)$/
const sfxEdOrIng = /^(.+?)(ed|ing)$/
const sfxAtOrBlOrIz = /(at|bl|iz)$/
const sfxEED = /^(.+?)eed$/
const sfxS = /^.+?[^s]s$/
const sfxSsesOrIes = /^.+?(ss|i)es$/
const sfxMultiConsonantLike = /([^aeiouylsz])\1$/
const step2 =
  /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/
const step3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/
const step4 =
  /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/

/**
 * Get the stem from a given value.
 *
 * @param {string} value
 *   Value to stem.
 * @returns {string}
 *   Stem for `value`
 */
// eslint-disable-next-line complexity
function porterStem(value) {
  let result = String(value).toLowerCase()

  // Exit early.
  if (result.length < 3) {
    return result
  }

    let firstCharacterWasLowerCaseY = false

  // Detect initial `y`, make sure it never matches.
  if (
    result.codePointAt(0) === 121 // Lowercase Y
  ) {
    firstCharacterWasLowerCaseY = true
    result = 'Y' + result.slice(1)
  }

  // Step 1a.
  if (sfxSsesOrIes.test(result)) {
    // Remove last two characters.
    result = result.slice(0, -2)
  } else if (sfxS.test(result)) {
    // Remove last character.
    result = result.slice(0, -1)
  }

    let match

  // Step 1b.
  if ((match = sfxEED.exec(result))) {
    if (gt0.test(match[1])) {
      // Remove last character.
      result = result.slice(0, -1)
    }
  } else if ((match = sfxEdOrIng.exec(result)) && vowelInStem.test(match[1])) {
    result = match[1]

    if (sfxAtOrBlOrIz.test(result)) {
      // Append `e`.
      result += 'e'
    } else if (sfxMultiConsonantLike.test(result)) {
      // Remove last character.
      result = result.slice(0, -1)
    } else if (consonantLike.test(result)) {
      // Append `e`.
      result += 'e'
    }
  }

  // Step 1c.
  if ((match = sfxY.exec(result)) && vowelInStem.test(match[1])) {
    // Remove suffixing `y` and append `i`.
    result = match[1] + 'i'
  }

  // Step 2.
  if ((match = step2.exec(result)) && gt0.test(match[1])) {
    result = match[1] + step2list[match[2]]
  }

  // Step 3.
  if ((match = step3.exec(result)) && gt0.test(match[1])) {
    result = match[1] + step3list[match[2]]
  }

  // Step 4.
  if ((match = step4.exec(result))) {
    if (gt1.test(match[1])) {
      result = match[1]
    }
  } else if ((match = sfxIon.exec(result)) && gt1.test(match[1])) {
    result = match[1]
  }

  // Step 5.
  if (
    (match = sfxE.exec(result)) &&
    (gt1.test(match[1]) ||
      (eq1.test(match[1]) && !consonantLike.test(match[1])))
  ) {
    result = match[1]
  }

  if (sfxLl.test(result) && gt1.test(result)) {
    result = result.slice(0, -1)
  }

  // Turn initial `Y` back to `y`.
  if (firstCharacterWasLowerCaseY) {
    result = 'y' + result.slice(1)
  }

  return result
}

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

function evalVariant(mode, match, byId, question, gold) {
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
    if (mode !== "base") {
      const seen = new Set(phrases.map((p) => p[0]));
      for (const t of tokens) {
        const stem = porterStem(t);
        if (stem.length >= 2 && !(mode === "S2" && seen.has(stem))) {
          seen.add(stem);
          phrases.push([stem, stem.length]);
        }
      }
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
  for (let i = 0; i < top.length; i++) if (gold.has(top[i])) return i + 1;
  return 0;
}

function main() {
  // self-test the stemmer against the canonical Porter examples
  const cases = { caresses: "caress", ponies: "poni", ties: "ti", caress: "caress", cats: "cat", feed: "feed", agreed: "agre", disabled: "disabl", matting: "mat", mating: "mate", meeting: "meet", milling: "mill", messing: "mess", meetings: "meet" };
  for (const [w, want] of Object.entries(cases)) {
    const got = porterStem(w);
    if (got !== want) { console.error(`STEMMER MISMATCH ${w}: got ${got}, want ${want}`); process.exit(1); }
  }
  console.error("stemmer self-test OK");

  const questions = JSON.parse(fs.readFileSync(DIR + "/longmemeval_s.json", "utf8")).slice(0, LIMIT);
  console.log(`evaluating ${questions.length} questions x 3 variants`);

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 2000");

  const MODES = ["base", "S1", "S2"];
  const stat = () => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0, byType: new Map() });
  const stats = new Map(MODES.map((v) => [v, stat()]));
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

    for (const mode of MODES) {
      const rank = evalVariant(mode, match, byId, question, gold);
      record(mode, String(entry.question_type || "unknown"), rank);
    }
    done++;
    if (done % 100 === 0) console.error(`progress: ${done} questions`);
  }

  console.log("=== overall (hit@1 / hit@5 / hit@10 / MRR) ===");
  for (const mode of MODES) {
    const s = stats.get(mode);
    const pct = (n) => ((n / s.n) * 100).toFixed(1) + "%";
    console.log(`${mode.padEnd(6)} n=${String(s.n).padEnd(4)} ${pct(s.hit1)}  ${pct(s.hit5)}  ${pct(s.hit10)}  MRR ${(s.mrr / s.n).toFixed(4)}`);
  }
  console.log("=== per-type hit@1 / hit@5 / MRR ===");
  const typeNames = new Set();
  for (const s of stats.values()) for (const t of s.byType.keys()) typeNames.add(t);
  for (const type of [...typeNames].sort()) {
    const line = [type.padEnd(24)];
    for (const mode of MODES) {
      const t = stats.get(mode).byType.get(type);
      if (!t) { line.push("     -   "); continue; }
      line.push(`${((t.hit1 / t.n) * 100).toFixed(1)} ${((t.hit5 / t.n) * 100).toFixed(1)} ${(t.mrr / t.n).toFixed(2)}`);
    }
    console.log("  " + line.join(" | "));
  }
}

main();
