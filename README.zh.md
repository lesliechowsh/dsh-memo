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

Memo 的架构直接对应 [《A Survey on the Memory Mechanism of Large Language Model based Agents》](https://arxiv.org/abs/2404.13501)（清华大学 THUNLP，唐杰教授团队）提出的记忆分类法：

| 综述维度 | Memo |
|---|---|
| 记忆来源 | Agent 生成：DSH 自动记录每条消息、每次工具调用与结果 |
| 记忆形态 | 外部记忆——纯 JSONL 日志与笔记；无向量数据库、无权重训练 |
| 记忆写入 | 自动（会话日志即写路径）+ `memo_remember` 手动蒸馏 |
| 记忆读取 | 基于检索的读取：全文搜索 + 片段、标题、时间过滤（`memo_search`） |
| 记忆管理 | v1 为原始全量记忆；总结、压缩与遗忘在路线图中 |

## Benchmark 目标

主测 LongMemEval-S（检索 hit@k/MRR），辅测 LoCoMo。结果出来后会在本 README 公布。

## 许可证

MIT —— 见 `LICENSE`。
