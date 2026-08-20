# Memo

[English](../README.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](../LICENSE)
[![status](https://img.shields.io/badge/status-beta-8B7E5A)](../CHANGELOG.md)

**你 agent 的记忆：它做过的每一件事，跨所有会话，零基础设施。**

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

> **面向**想要让 agent 回答"三天前我们决定了什么？"的 DSH 用户——**Memo 是**一个零基础设施的记忆插件，**把 DSH 本来就记录的会话语料变成可搜索记忆**。与外部记忆框架不同，它不重建索引、不在你的机器之外存任何东西，直接跑在官方 `sessionQuery` 后端上。

DeepSeek Harness 本身就在记录每个会话、每条消息、每次工具调用。Memo 把这套语料变成 agent 真正能用的可搜索记忆：问任何过去会话里的事，一次工具调用拿回证据。

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
      "seq": 391234,
      "source": "event",
      "mode": "phrase"
    }
  ],
  "notes": [],
  "limit": 10
}
```

> Agent：*"有——我们在 Weniger 主题项目里调研过：'DESIGN DIETER RAMS' 是注册商标，所以产品改名为 Weniger……"*

## 为什么选 Memo

- **零基础设施**——没有向量数据库、没有 embedding API、没有后台索引器。一行插件配置，仅此而已。
- **官方语料即真相源**——Memo 不重建索引；它查询 DSH 自带的 `sessionQuery`（FTS5）服务。DSH 记录了什么，你就能召回什么。
- **本地优先**——每个字节都留在你的机器上：会话留在 DSH 的存储里，笔记就是一个人类可读的 JSONL 文件。
- **诚实的数字**——检索质量在 LongMemEval-S 上实测，评测脚本忠实复刻发布算法，好坏都如实公布（见 [Benchmark](#benchmark)）。没有挑好的基线。

外部记忆框架（Mem0、Letta 等）会把你的数据嵌入并重存进它们管理的基础设施；Memo 以 DSH 自己的存储为唯一真相源，且不需要你运维任何东西。如果你需要 DSH 之外的跨应用记忆，那些工具更合适。

## 环境要求

- **DeepSeek Harness**，composition 里有 `sessionQuery` 服务（标准 `web` profile 自带）。
- 部署的会话查询索引必须是开启状态——若配置为 `openAt: "never"`，会话搜索被禁用，`memo_search` 会如实报错而不是瞎猜。
- 笔记需要工具执行时能解析 `$DSH_HOME`（所有标准 DSH 部署都满足）。
- 不需要其他服务、不需要 API key、没有任何网络调用。

## 安装

```sh
dsh plugin --profile web add dsh-memo@latest
```

重启 `dsh web`——agent 的工具列表里出现三个 `memo_*` 工具。

<details>
<summary>没有 <code>dsh plugin</code> 子命令的部署（手动安装）</summary>

1. `cd "$DSH_HOME/profiles/web" && npm install dsh-memo`
2. 在 profile 的 `cordis.patch.yml` 中追加：

   ```yaml
   - insert:
       - id: memo
         name: 'dsh-memo'
   ```

3. 重启 `dsh web`。

</details>

卸载：`dsh plugin --profile web remove dsh-memo`。

## 工具

### `memo_search`

搜索工作区里所有历史会话 + 备忘笔记。

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词；匹配会话文本与备忘笔记。 |
| `limit` | number | 10（上限 50） | 每个来源的最大命中数。 |
| `sessionId` | string | — | 限定在单个会话内搜索（搜索其事件）。 |
| `since` | number | — | 只返回该 epoch-ms 时间之后的命中。 |
| `tags` | string | — | 逗号分隔标签；笔记须至少带其中一个才会返回。 |

返回：

```json
{
  "sessions": [
    {
      "sessionId": "session-49924467-…",
      "title": "Weniger theme design",   // 会话没有标题快照时为 null
      "snippet": "…匹配文本…",
      "time": 1787078839061,              // 命中事件的 epoch 毫秒
      "source": "event",
      "mode": "phrase"                    // "phrase" = 原句命中；"terms" = 加权词/词对命中
    }
  ],
  "notes": [
    { "time": 1787212144789, "text": "…", "tags": ["release"] }
  ],
  "limit": 10
}
```

- `sessions` 排序：短语命中优先，再按加权词/词对得分；`notes` 为最近的匹配，新的在后。
- 当部署的会话查询索引关闭或服务缺失时，结果携带 `error` 字符串，而不是捏造命中。

### `memo_remember`

写一条持久笔记——跨会话存续的事实、决定、偏好，会出现在 `memo_search` 的结果里。

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `text` | string | 必填 | 笔记内容——一条具体的事实、决定或偏好。 |
| `tags` | string | — | 逗号分隔标签。 |

返回 `{ ok, note, path }`；若已存在相同文本的笔记，则不追加，返回 `{ ok: true, duplicate: true, note }`（含已有笔记）。笔记以每行一条 JSON 记录的形式存在 `$DSH_HOME/memo/notes.jsonl`。

### `memo_stats`

语料总览——无参数。

```json
{
  "sessions": 19,
  "recent": [{ "id": "session-…", "cwd": "…", "createdAt": 1787…, "title": "…" }],
  "notes": 4
}
```

## 工作原理

```
                       ┌─────────────────────────────────────────┐
  memo_search(query) ─▶│  1. 短语步   整句查询，FTS5 引号短语      │
                       │     匹配 → top 10 会话                  │
                       │  2. 加权步   ≤8 词 + 相邻词对，各自       │
                       │      top 10，按权重求和合并              │
                       │     （词长 / 词对长度），时间降序 tiebreak │
                       │  3. 短语优先，再加权结果，去重            │
                       └───────────────┬──────────────────────────┘
                                       │ 官方 sessionQuery (FTS5)
                                       ▼
        DSH 会话语料（live + persisted 事件）        notes.jsonl
                                       │                            │
                                       ▼                            ▼
                    会话 + 标题 + 片段                      命中的笔记
```

- **读官方语料**——DSH 的 `sessionQuery` 服务是唯一真相源；Memo 不重建索引、不重复存储。
- **双层召回**——短语精确命中优先，然后每个查询词与相邻词对各自作为短语匹配，按权重（词长、词对长度——本地稀有度代理）求和合并排序。提问式查询和关键词都能用。
- **笔记是纯 JSONL**——存在 `$DSH_HOME/memo/notes.jsonl`，人类可读、可编辑、可迁移。

## 用法

### 召回任意历史会话

自然提问即可——当答案依赖历史时，agent 会主动调用 `memo_search`：

> "我们有没有讨论过基于 SSH 的编码 agent？结论是什么？"

知道大概范围时用时间或会话过滤：

```
memo_search(query: "benchmark", since: 1787000000000)
memo_search(query: "theme tokens", sessionId: "session-49924467-…")
```

### 写持久笔记

```
memo_remember(text: "命名规范：dsh- 前缀 + snake_case 的 memo_* 工具名；不用真人姓名（Dieter Rams 教训）。", tags: "naming,convention")
```

重写相同文本会返回已有笔记而不是重复写入。按标签找笔记：

```
memo_search(query: "naming", tags: "convention")
```

### 查看语料

```
memo_stats()  →  { sessions: 19, notes: 4, recent: […] }
```

## 设计与研究基础

Memo 的定位落在 [《Memory for Large Language Models》](https://arxiv.org/abs/2607.25380)（清华 THUNLP 唐杰教授团队 / NUS）提出的架构化记忆分类法上，该综述以三个正交轴刻画记忆：

| 轴 | Memo |
|---|---|
| 表征 | **显式** —— 可独立寻址的 JSONL 日志与笔记，与模型计算解耦 |
| 更新动态 | **在线** —— DSH 实时追加每条消息、工具调用与结果；`memo_remember` 写入蒸馏笔记 |
| 持久性 | **长期** —— 跨上下文窗口、跨会话、跨进程重启存续 |

写入（`memo_remember`）与读取（`memo_search`）对应综述的记忆操作视角；记忆整合与压缩在路线图中。

## Benchmark

在两个数据集上实测，评测脚本忠实复刻 `memo_search` 内置管线（短语优先 + 加权词/词对合并，含官方后端的分页截断与代表事件排序），跑在与后端同类的 FTS5 引擎上。完整协议、环境与变体选择实验记录：[`bench/`](../bench/README.md)。

**LongMemEval-S**（[arXiv:2410.10813](https://arxiv.org/abs/2410.10813)，500 个问题，每题 54 个干扰会话）：

**hit@1 54.6% · hit@5 75.0% · hit@10 82.8% · MRR 0.636**

| 题型 | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 59.4% | 80.5% | 0.691 |
| temporal-reasoning | 133 | 46.6% | 74.4% | 0.587 |
| knowledge-update | 78 | 83.3% | 97.4% | 0.893 |
| single-session-user | 70 | 70.0% | 88.6% | 0.784 |
| single-session-assistant | 56 | 17.9% | 26.8% | 0.220 |
| single-session-preference | 30 | 26.7% | 53.3% | 0.378 |

**LoCoMo10**（[snap-research/LoCoMo](https://github.com/snap-research/LoCoMo)，10 段超长对话共 1986 个问题，跨数据集验证）：

**hit@1 43.7% · hit@5 73.7% · hit@10 87.3% · MRR 0.568**

**口径说明：** 评测测量"会话定位"——金标会话是否进入 top-k——而非端到端答题准确率（后者是路线图单列项，需要模型配额）。0.4.0 的检索算法在 LongMemEval-S 上选定、在 LoCoMo10 上验证；助手复述类与偏好类仍是相对弱项。

## 路线图

- [x] LoCoMo10 辅测
- [x] 标签搜索与笔记去重
- [x] 弱项召回——加权词/词对合并（0.4.0）：助手复述类 hit@1 1.8% → 17.9%，偏好类 16.7% → 26.7%
- [ ] 端到端 QA（检索 + 答题，100 问子集）——需要模型配额批准
- [ ] 助手复述类与偏好类问题的进一步召回工作（仍是前沿）

## 支持与贡献

- 问题与 bug 报告：[GitHub Issues](https://github.com/lesliechowsh/dsh-memo/issues)
- 复现 benchmark 或新增评测：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 安全报告：[SECURITY.md](../SECURITY.md)——Memo 从不把数据送出你的机器；它唯一的依赖是本地的 DSH 会话存储，无网络调用。

## 许可证

MIT —— 见 `LICENSE`。
