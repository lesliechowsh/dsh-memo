# Memo

[English](./README.md)

[![npm](https://img.shields.io/npm/v/dsh-memo)](https://www.npmjs.com/package/dsh-memo)
[![license](https://img.shields.io/npm/l/dsh-memo)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent 打造的会话记忆工具——直接构建在官方 `sessionQuery` 服务之上，你拥有过的每个会话都是可搜索的记忆。本地优先、零基础设施、无向量数据库。

## 工具

| 工具 | 作用 |
|---|---|
| `memo_search(query)` | 搜索本工作区所有历史会话 + 你的备忘笔记——带片段、标题、时间过滤 |
| `memo_remember(text, tags)` | 写一条持久笔记：跨会话存续的事实、决定、偏好 |
| `memo_stats()` | 语料总览：会话数、最近标题、笔记条数 |

## 安装

```sh
dsh plugin --profile web add dsh-memo@latest
```

重启 `dsh web`，agent 的工具列表里会出现三个 `memo_*` 工具。

手动安装（没有 `dsh plugin` 子命令的部署）：

1. `cd "$DSH_HOME/profiles/web" && npm install dsh-memo`
2. 在 profile 的 `cordis.patch.yml` 中追加：

   ```yaml
   - insert:
       - id: memo
         name: 'dsh-memo'
   ```

3. 重启 `dsh web`。

## 笔记存放位置

`memo_remember` 追加写入 `$DSH_HOME/memo/notes.jsonl`——纯 JSONL 文件，可自由编辑、备份或删除。

## 设计与研究基础

Memo 的定位落在 [《Memory for Large Language Models》](https://arxiv.org/abs/2607.25380)（清华 THUNLP 唐杰教授团队 / NUS）提出的架构化记忆分类法上，该综述以三个正交轴刻画记忆：

| 轴 | Memo |
|---|---|
| 表征 | **显式** —— 可独立寻址的 JSONL 日志与笔记，与模型计算解耦 |
| 更新动态 | **在线** —— DSH 实时追加每条消息、工具调用与结果；`memo_remember` 写入蒸馏笔记 |
| 持久性 | **长期** —— 跨上下文窗口、跨会话、跨进程重启存续 |

写入（`memo_remember`）与读取（`memo_search` 检索 + 片段/标题/时间过滤）对应综述的记忆操作视角；记忆整合与压缩是下一里程碑。

## Benchmark 目标

主测 LongMemEval-S（检索 hit@k/MRR），辅测 LoCoMo。结果出来后会在本 README 公布。

## 许可证

MIT —— 见 `LICENSE`。
