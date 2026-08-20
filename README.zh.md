# Memo

[English](./README.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](LICENSE)

**你 agent 的记忆：它做过的每一件事，跨所有会话，零基础设施。**

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

> Agent：*"有——我们在 Weniger 主题项目里调研过：'DESIGN DIETER RAMS' 是注册商标，所以产品改名为 Weniger，还查了 Braun 的诉讼记录……"*

## 工具

| 工具 | 作用 |
|---|---|
| `memo_search(query, limit?, sessionId?, since?)` | 搜索所有历史会话 + 备忘笔记——片段、标题、时间过滤 |
| `memo_remember(text, tags?)` | 写一条持久笔记：跨会话存续的事实、决定、偏好 |
| `memo_stats()` | 语料总览：会话数、最近标题、笔记条数 |

## 工作原理

- **读官方语料**——DSH 的 `sessionQuery` 服务是唯一真相源；Memo 不重建索引、不重复存储。
- **双层召回**——短语精确命中优先，逐词匹配按命中数合并排序。提问式查询和关键词都能用。
- **笔记是纯 JSONL**——存在 `$DSH_HOME/memo/notes.jsonl`，人类可读、可编辑、可迁移。

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

在 [LongMemEval-S](https://arxiv.org/abs/2410.10813)（500 个问题，每题 54 个干扰会话）上实测，会话级检索，评测脚本忠实复刻 `memo_search` 内置管线（短语优先 + 逐词命中数合并，含官方后端的分页截断与代表事件排序），跑在与后端同类的 FTS5 引擎上。完整协议与环境：[`bench/`](bench/README.md)。

**总成绩：hit@1 36.4% · hit@5 68.4% · hit@10 80.0% · MRR 0.499**

| 题型 | n | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| multi-session | 133 | 38.3% | 76.7% | 0.551 |
| temporal-reasoning | 133 | 33.8% | 69.9% | 0.486 |
| knowledge-update | 78 | 55.1% | 89.7% | 0.701 |
| single-session-user | 70 | 52.9% | 77.1% | 0.635 |
| single-session-assistant | 56 | 1.8% | 17.9% | 0.073 |
| single-session-preference | 30 | 16.7% | 43.3% | 0.279 |

**口径说明：** 本评测测量"会话定位"——金标会话是否进入 top-k——而非端到端答题准确率（后者是路线图单列项）。弱项题型（助手复述类、偏好类）是已知前沿。

## 路线图

- [ ] LoCoMo 辅测
- [ ] 端到端 QA（检索 + 答题，100 问子集）
- [ ] preference 类问题召回改善
- [ ] 标签搜索与笔记去重

## 许可证

MIT —— 见 `LICENSE`。
