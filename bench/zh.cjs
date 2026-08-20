// Memo — Chinese (CJK) functional regression harness. NOT a benchmark.
//
// There is no public Chinese multi-session memory-retrieval corpus (checked:
// longmemeval-cn ships questions+results only, MemLong's data repo is gone,
// LoCoMo is English). Benchmark-level Chinese evaluation therefore stays
// blocked and is reported as such in the README.
//
// What this file IS: a small, deterministic, self-built regression set that
// verifies the 0.7.0 CJK-run tokenizer actually improves Chinese recall,
// against the same FTS5 unicode61 engine class the official backend uses.
// Sessions are hand-written and embedded, so the same bytes reproduce the
// same numbers — but the set is tiny and self-made: treat it as a functional
// test, never as a published benchmark.
//
// Variant A = pre-0.7.0 shipped behavior: the ASCII tokenizer drops CJK, so
//   only the verbatim whole-question phrase step can match.
// Variant B = 0.7.0: CJK runs (len >= 2) become weighted query phrases, so
//   sessions sharing ANY run of the question are recalled (exact-run
//   granularity — the backend index contains no sub-run tokens).
//
// Run: node zh.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");

const REQUEST_LIMIT = 10;
const TERM_MAX = 8;

const STOP_WORDS = new Set(["the","a","an","and","or","what","did","do","does","is","are","was","were","to","of","in","on","at","for","with","about","we","you","i","it","this","that","how","when","where","which","why","be","been","from","by","as","there","not","can","could","should","would","just","also"]);

// Variant A tokenizer: ASCII only (pre-0.7.0 shipped behavior).
function tokenizeAscii(text) {
  const all = [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return [...content, ...all.filter((t) => STOP_WORDS.has(t))].slice(0, 8);
}

// Variant B tokenizer: 0.7.0 — ASCII content-first + CJK runs.
function tokenizeCjk(text) {
  const src = String(text).toLowerCase();
  const ascii = [...new Set(src.split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const content = ascii.filter((t) => !STOP_WORDS.has(t));
  const stops = ascii.filter((t) => STOP_WORDS.has(t));
  const cjk = [];
  for (const m of src.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = m[0];
    if (run.length >= 2 && !cjk.includes(run)) cjk.push(run);
  }
  return [...content, ...cjk, ...stops].slice(0, 8);
}

// ---- embedded corpus: 10 hand-written Chinese sessions ----
const SESSIONS = [
  { id: "s1", text: "用户：主题就定拉姆风格吧。助手：好的，Weniger 主题采用迪特·拉姆斯风格，少即是多。" },
  { id: "s2", text: "用户：命名规范怎么定？助手：npm 包用 dsh- 前缀，工具名用 snake_case 加 memo_ 命名空间。" },
  { id: "s3", text: "用户：发布流程是什么？助手：npm 是唯一正式渠道，GitHub 只发 tag 和 release 链接 npm。" },
  { id: "s4", text: "用户：benchmark 数字可信吗？助手：只发布产品自测、可复现的数字，被否实验也公开。" },
  { id: "s5", text: "用户：团队空间做什么？助手：每个标签页一个身份，在线状态和一个共享聊天室。" },
  { id: "s6", text: "用户：备忘录笔记存在哪？助手：$DSH_HOME/memo/notes.jsonl，每行一条 JSON。" },
  { id: "s7", text: "用户：中文检索为什么弱？助手：unicode61 把连续汉字当一个 token，没有子词索引。" },
  { id: "s8", text: "用户：停用词有什么坑？助手：英文问句句首虚词会挤掉内容词的窗口位置。" },
  { id: "s9", text: "用户：时间过滤该怎么做？助手：硬过滤会误剪搜索空间，实测比不过软加权。" },
  { id: "s10", text: "用户：为什么不做向量检索？助手：零基础设施承诺优先，词法天花板如实标注。" },
];

// ---- queries: gold session contains SOME runs but not the verbatim question ----
// Every query is multi-run (punctuation-separated) with at least one run
// appearing VERBATIM in the gold session — that is exactly what the 0.7.0
// weighted step can match, and exactly what the pre-0.7.0 pipeline could
// not (its tokenized step produced zero tokens for CJK). The last query is a
// ceiling control: no run appears anywhere, so both variants must miss.
const QUERIES = [
  { q: "主题就定拉姆风格吧，最终确认了吗？", gold: ["s1"] },
  { q: "命名规范怎么定？还有别的约定吗？", gold: ["s2"] },
  { q: "发布流程是什么，我记不清了", gold: ["s3"] },
  { q: "数字可信吗？有什么依据？", gold: ["s4"] },
  { q: "每个标签页一个身份，聊天室共享吗？", gold: ["s5"] },
  { q: "备忘录笔记存在哪？格式是什么？", gold: ["s6"] },
  { q: "中文检索为什么弱？有救吗？", gold: ["s7"] },
  { q: "停用词有什么坑？怎么修的？", gold: ["s8"] },
  { q: "时间过滤该怎么做？结论是？", gold: ["s9"] },
  { q: "为什么不做向量检索？以后会做吗？", gold: ["s10"] },
  { q: "中文能按词搜索吗？", gold: ["s7"] },
];

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

function representative(session, phraseTokens) {
  let best = null;
  for (const ev of session.events) {
    const occ = occurrencesIn(ev.tokens, phraseTokens);
    if (occ === 0) continue;
    if (best === null || occ > best.occ ||
      (occ === best.occ && (ev.len < best.len ||
        (ev.len === best.len && (ev.time > best.time ||
          (ev.time === best.time && ev.seq > best.seq))))))
      best = { occ, len: ev.len, time: ev.time, seq: ev.seq };
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

function evalQuery(match, byId, question, gold, tokenizeFn) {
  const phraseRanked = phraseTop(match, byId, question, REQUEST_LIMIT).map((c) => c.id);
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
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  const match = db.prepare("SELECT id FROM docs WHERE docs MATCH ? LIMIT 500");

  const byId = new Map();
  for (const s of SESSIONS) {
    // one doc per session; split into pseudo-events at punctuation so the
    // harness can rank representative events like the real backend
    const events = s.text.split(/[。！？]/).filter((t) => t.trim() !== "").map((t, k) => ({
      tokens: seq(t), len: Array.from(t).length, time: k, seq: k,
    }));
    byId.set(s.id, { id: s.id, events });
    insert.run(s.id, s.text);
  }

  const stats = { A: { hit1: 0, hit5: 0, mrr: 0, n: 0 }, B: { hit1: 0, hit5: 0, mrr: 0, n: 0 } };
  for (const item of QUERIES) {
    const gold = new Set(item.gold);
    for (const [variant, fn] of [["A", tokenizeAscii], ["B", tokenizeCjk]]) {
      const rank = evalQuery(match, byId, item.q, gold, fn);
      const s = stats[variant];
      s.n++;
      if (rank === 1) s.hit1++;
      if (rank >= 1 && rank <= 5) s.hit5++;
      if (rank > 0) s.mrr += 1 / rank;
      console.log(`${variant} | ${item.q} -> rank ${rank}${rank === 0 ? " (miss)" : ""}`);
    }
  }
  console.log("=== Chinese functional regression (self-built set, NOT a benchmark) ===");
  for (const [variant, s] of Object.entries(stats)) {
    const pct = (n) => ((n / s.n) * 100).toFixed(0) + "%";
    console.log(`${variant} ${variant === "A" ? "ascii-only (pre-0.7.0) " : "cjk-runs (0.7.0)    "} n=${s.n}  hit@1 ${pct(s.hit1)}  hit@5 ${pct(s.hit5)}  MRR ${(s.mrr / s.n).toFixed(2)}`);
  }
}

main();
