# Memo

[English](../README.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](../LICENSE)
[![status](https://img.shields.io/badge/status-beta-8B7E5A)](../CHANGELOG.md)

**你的 agent 记得住你们做过的每一件事——一条插件命令，别的什么都不用跑。**

## 快速示例

> 你：*"我们之前聊过 Dieter Rams 的事吗？"*
> Agent 调用 `memo_search("Dieter Rams")` →

```json
{
  "sessions": [
    {
      "sessionId": "session-49924467-9cd1-414a-9998-f207782c72ad",
      "title": "Weniger 主题设计",
      "snippet": "…「DESIGN DIETER RAMS」是已注册商标，Rams Foundation 积极管理其姓名与遗产…",
      "time": 1787078839061,
      "mode": "phrase"
    }
  ],
  "notes": [],
  "limit": 10
}
```

> Agent：*"有——我们在 Weniger 主题项目里调研过：'DESIGN DIETER RAMS' 是注册商标，所以产品改名为 Weniger……"*

## 安装

```sh
dsh plugin --profile web add dsh-memo@latest
```

重启 `dsh web`——agent 的工具列表里出现三个 `memo_*` 工具。整个安装就这些。（卸载：`dsh plugin --profile web remove dsh-memo`；无 CLI 部署的手动配置步骤见 [CONTRIBUTING.md](../CONTRIBUTING.md)。）

**安装顺手做的一件事：** DSH 出厂时全文会话搜索是 opt-in 的——平台默认 `openAt: never`，`searchSessions`/`searchEvents` 处于禁用状态，直到有东西把它打开。Memo 的包自带补丁，安装即启用平台内置索引（`openAt: first-search`）。两个诚实的后果，都是 DSH 的设计：

- **索引在内存里**，所以每次重启后的第一次搜索会重建索引。大语料下这第一次搜索会慢；同进程内的后续搜索都很快。
- 想要持久索引？在你的 profile 的 `cordis.patch.yml` 里加一个 `path`：

```yaml
- id: session-query-sqlite
  config:
    path: /path/to/your/dsh-home/storages/session-search.sqlite
    openAt: first-search
```

如果你的部署刻意想关掉搜索，在后置补丁层里重新设 `openAt: never` 即可；此时 Memo 只提供笔记功能，并如实报告禁用状态而不是编造命中。以上适用于 DSH ≥ 0.1.0-rc.7（引入 opt-in 默认值的版本）。

## 你能得到什么

- **每个历史会话都可搜索。** 用大白话问（"我们之前决定过……吗？"），一次工具调用拿回命中的会话、片段和证据。
- **别的什么都不用跑。** 没有向量数据库、没有 embedding API、没有 API key、没有后台索引器——它直接搜索 DSH 已经记录的语料，走官方 `sessionQuery` 后端。
- **一切都留在本地。** 会话留在 DSH 的存储里；你的蒸馏笔记就是一个人类可读的 JSONL 文件。

Memo 刻意不把你的历史重建进自己的索引。如果你需要 DSH 之外、基于 embedding 的跨应用记忆，Mem0、Letta 这类项目就是为那个场景造的。

## 工具

### `memo_search(query, limit?, sessionId?, since?, tags?)`

搜索工作区里所有历史会话 + 备忘笔记。`limit` 默认 10（上限 50）；`sessionId` 限定单个会话；`since` 按 epoch-ms 过滤；`tags` 按标签过滤笔记。返回 `{ sessions, notes, limit }`：

- `sessions`：`{ sessionId, title（无标题时为 null）, snippet, time, mode }`——短语命中在前，再按加权词/词对得分排序；`mode` 为 `"phrase"`（原句命中）或 `"terms"`。
- `notes`：最近的匹配，新的在后。
- 会话查询索引关闭或服务缺失时，结果携带 `error` 字符串而不是编造命中。中文查询获得 run 级召回（连续汉字串作为加权短语），并携带 `cjkWarning` 说明剩余限制——见[环境要求](#环境要求)。

### `memo_remember(text, tags?)`

写一条持久笔记——跨会话存续的事实、决定、偏好，会出现在 `memo_search` 结果里。返回 `{ ok, note, path }`；文本完全相同则返回已有笔记 `{ ok: true, duplicate: true, note }` 而不是重复写入。笔记以每行一条 JSON 记录的形式存在 `$DSH_HOME/memo/notes.jsonl`。

### `memo_stats()`

语料总览，无参数：`{ sessions: 19, recent: […], notes: 4 }`。

## 工作原理

```
  memo_search(query)
   1. 短语步   整句作为一条 FTS5 短语 → top 10 会话
   2. 加权步   ≤8 词 + 相邻词对，各自 top 10，
               按 df 代理 IDF 权重合并（词 idf×4、
               词对长度 × max idf；df 每次查询用
               capped-50 计数估计，失败回退长度），
               时间降序 tiebreak——内容词先占满
               窗口，停用词只填剩余
   3. 短语在前，再加权结果，去重，取前 10
                    ── 官方 sessionQuery (FTS5) ──
        DSH 会话语料（live + persisted 事件）   + notes.jsonl
```

Memo 不建第二份持久库：DSH 的 `sessionQuery` 服务是唯一真相源，通过其精确读取接口访问。每次搜索只花一次 `listSessions`（发现新会话）加内存索引查询——零次 FTS 后端调用（0.12.0；更早版本最多 26 次，见 CHANGELOG）。

## 用法

### 60 秒上手

安装完成后，在同一次对话里向 agent 说这四句话。每一句都需要上一句的记忆，所以每一步都在实战检索：

1. *"记一下：这个项目发布渠道的约定是 npm 为唯一正式渠道。"*（agent 写一条笔记）
2. *"我们记的'发布渠道的约定'是什么？"*（agent 必须回忆——`memo_search` 找到那条笔记）
3. *"再记一条：demo 数据都放在 bench 目录。"* 然后 *"我们记的 demo 数据放在哪？"*（再来一轮同样的循环）

到此你已体验完整产品：写、回忆、再写、再回忆——除了安装，没有任何额外配置，没有任何外部服务。

### 日常使用

答案依赖历史时 agent 会自己调用 `memo_search`（"我们有没有讨论过基于 SSH 的编码 agent？"）。知道大概范围时加过滤：`memo_search(query: "benchmark", since: 1787000000000)`。用 `memo_remember(text: …, tags: "naming,convention")` 写蒸馏事实，之后用 `memo_search(query: "naming", tags: "convention")` 找回。每个会话命中带一条 `snippet`（最佳匹配事件）；前 3 个命中还各带 `events`（最多 3 条匹配事件），agent 读到的是实际上下文，而不是一行匹配。

### 启动、新鲜度与慢后端

DSH 的 session-query FTS 后端每次调用都对全部活跃语料做对账——慢机器上单次调用要几十秒。Memo 的搜索不走这条路：把对话事件（用户消息、assistant 完整回复、压缩摘要、会话标题——权威对话内容，流式碎片占原始体积约九成且已从源头验证会折叠进完整回复）建成倒排索引，持久化在 `$DSH_HOME/memo/index.json`。开机几秒内加载完成；后台刷新以带间歇的节奏补新会话，Web UI 始终可用。注入的工作区指令（`<system-reminder` 块）不进索引——它们在每个会话里重复出现，会污染排序。当前会话跳过（内容本来就在 agent 上下文里）；超大会话只索引一次、不在每次开机重读（其读取是服务端同步的分钟级操作），对它的搜索覆盖到最近一次索引为止。笔记搜索不受影响、永远最新。

## 设计与研究基础

Memo 落在 [《Memory for Large Language Models》](https://arxiv.org/abs/2607.25380)（清华 THUNLP 唐杰教授团队 / NUS）的记忆分类法上：**显式**表征（可独立寻址的 JSONL）、**在线**更新（DSH 实时追加）、**长期**持久化。

## Benchmark

按 `memo_search` 实际发货的管线实测，评测脚本跑在与后端同类的 FTS5 引擎上。完整协议、环境与变体选择实验记录：[`bench/`](../bench/README.md)。

**LongMemEval-S**（[arXiv:2410.10813](https://arxiv.org/abs/2410.10813)，500 个问题，每题 54 个干扰会话）：

**hit@1 78.2% · hit@5 92.4% · hit@10 97.4% · MRR 0.847**

| 题型 | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 78.2% | 96.2% | 0.863 |
| temporal-reasoning | 133 | 75.9% | 90.2% | 0.821 |
| knowledge-update | 78 | 96.2% | 98.7% | 0.972 |
| single-session-user | 70 | 88.6% | 97.1% | 0.933 |
| single-session-assistant | 56 | 64.3% | 87.5% | 0.745 |
| single-session-preference | 30 | 43.3% | 66.7% | 0.556 |

**LoCoMo10**（1986 题，跨数据集验证）：**hit@1 60.2% · hit@5 87.2% · MRR 0.718**——请以 hit@1 为准（原因见下）。

**LongMemEval-M**（500 个**全新**问题 × 约 500 会话池——规模 / 抗过拟合检验）：

**hit@1 54.6% · hit@5 78.6% · hit@10 83.8% · MRR 0.645**（该池随机 hit@1 ≈ 0.2% → 约 273 倍随机）

S → M 的下降（hit@1 78.2% → 54.6%）与候选池约 10 倍扩大一致；题型强弱排序在 0.6.0 管线（0.8.0 所扩展的同一结构）下已验证 S/M 完全一致。0.8.0 的加权在 S 档选定，并**逐段（5×100）在 M 上全部为正**——不是事后一次性跑出来的。

**LongMemEval-CN 跨语言**（中文问题 × 原始英文会话）：**hit@1 44.6%**（0.7.0 中文分词之前是 33.6%——中文串解锁了混合查询的加权步，使未翻译的单个拉丁词真正被查询）。所有增益仍来自这些拉丁词：纯中文问题无法命中英文会话，缺口在翻译、不在分词。公开的中文会话评测语料目前尚不存在。

**口径说明——这些数字该怎么读：**

- 这是会话定位的 hit@k（约 54 / 约 27 个候选会话的池子），不是端到端答题准确率——不可与 Mem0 / Zep / LangMem（LLM reader + judge 管线）比较。
- 信噪比：S 档随机 hit@1 ≈ 1.9%（1/54）、LoCoMo ≈ 3.7%（1/27）、M 档 ≈ 0.2%（1/500）；Memo 的 78.2% / 60.2% /（M 见下）约为其 41× / 16× / 260×。LoCoMo 的随机 hit@10 已有 ≈37%。
- 现在我们也在 M 档（约 500 会话池）有了自己的数字：hit@5 76.6%。论文检索表（BM25 R@5 63–68%、Contriever/Stella R@5 72–76%）用 round 级 Recall@k，我们用会话级 hit@k——相近但非同口径，所以**仍不作同等性声明**。Memo 是词法检索这一类里接近天花板的稀疏方案。
- 已知天花板：助手复述类与偏好类是词法地板（S/M 档 hit@1 33.3% / 30.0%）——证据常与问句没有共同词。
- "词长 ≈ 内容词"的加权规律是英文统计特征，迁移到中文不成立。

## 维护者写在前面的话

我做 Memo 的起因，是被那些跑分数字无法复现的记忆工具坑过太多次。所以这个项目只有一条规则：**只发布产品实测的数字，并且把产生这些数字的完整过程一起公开。**

- **评测脚本是真实管线的副本**——分页、排序、截断一一对应。同样的数据字节，跑出同样的数字。当年发现脚本过度收集产品看不到的候选时，发布的数字是**下调**（0.3.1），不是上调。
- **被否决的实验也公开。** 等权 bigram 把 hit@1 干到 5.2%；加宽每词分页不值 2 倍 API 调用；一篇我很尊重的论文里的时间感知扩展想法，确定性复现后实测**反而更差**——负结果也是结果，精确数字都在实验日志里。
- **我的错误记在 CHANGELOG 里，不是删掉。** 会话 id 读错字段（0.3.0）；标题被静默置空（0.3.1）；0.5.0 修掉 review 发现的三个 bug，其中一个（停用词把内容词挤出查询窗口）让头条召回数字被低估了两个版本。修好、重测、写下来。
- **限制在最疼的地方说清楚。** 弱项题型带数字点名；英文加权的假设与中文后端限制都在上面明说，不藏。
- **没有稻草人基线，没有借来的数字。**

如果你发现这里的数字复现不出来，那将是这个项目能收到的最高价值的 bug 报告——请[开 issue](https://github.com/lesliechowsh/dsh-memo/issues)。

## 环境要求

- **DeepSeek Harness**，composition 里有 `sessionQuery` 服务（标准 `web` profile 自带）；部署的会话查询索引必须开启——索引关闭时 `memo_search` 如实报错而不是瞎猜。
- **中文 / CJK**：后端 unicode61 索引把连续汉字串存为单个 token。Memo 把这些串作为加权短语搜索（0.7.0），所以只要问句的某个完整串在会话里原文出现就能召回。串内部的字级/词级搜索必须等上游换 tokenizer——`memo_search` 通过 `cjkWarning` 如实说明（详见 [`bench/`](../bench/README.md)）。
- 笔记需要工具执行时能解析 `$DSH_HOME`。不需要其他服务、不需要 API key、没有任何网络调用。

## 路线图

- [x] LoCoMo10 辅测 · LongMemEval-CN 跨语言评测
- [x] 标签搜索与笔记去重 · 0.5.0 三 bug 修复（内容词优先分词、空 token 笔记泄漏、换行安全追加）
- [x] 确定性时间感知检索：实测后否决并公开证据
- [x] LongMemEval-M（500 会话池）规模 / 抗过拟合检验——hit@1 52.6%，题型排序与 S 档一致
- [x] 中文 run 级召回（0.7.0）+ 内置功能回归集（`bench/zh.cjs`，自建、非 benchmark）
- [ ] 中文会话评测语料（阻塞：公开语料不存在；benchmark 级中文数字需要它）· 串内部字级召回（阻塞：上游 tokenizer 变更）
- [ ] 端到端 QA（检索 + 答题）——需要模型配额批准
- [ ] 词面天花板的 dense 检索——在"别的都不用跑"承诺内刻意不做

## 支持与贡献

- 问题与 bug 报告：[GitHub Issues](https://github.com/lesliechowsh/dsh-memo/issues)
- 复现 benchmark 或新增评测：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 安全报告：[SECURITY.md](../SECURITY.md)——Memo 从不把数据送出你的机器。

## 许可证

MIT —— 见 `LICENSE`。

## 给读这个文件的 agent

```yaml
project:    dsh-memo
domain:     agent memory / session retrieval
audience:   DSH（DeepSeek Harness）用户：让 agent 记住历史
interfaces: 三个模型工具 — memo_search / memo_remember / memo_stats
runtime:    DSH host 插件（Node），无需额外服务、无向量数据库
storage:    DSH 官方会话语料 + 一个纯 JSONL 笔记文件
status:     beta — 0.x 线内无破坏性 API 变更；见 CHANGELOG
support:    GitHub Issues
```
