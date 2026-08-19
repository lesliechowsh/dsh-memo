# Memo

[English](./README.md)

**状态：开发中（0.0.1 占位版）**——功能插件将在首个正式版发布，当前包仅用于保留包名。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent 打造的会话记忆工具——直接构建在官方 `sessionQuery` 服务之上，你拥有过的每个会话都是可搜索的记忆：

- **`memo_search(query)`** —— 跨会话全文召回，带片段、标题与时间过滤。
- **`memo_remember(text, tags)`** —— 主动蒸馏笔记（决定、偏好、事实），与原始日志分开存放。
- **`memo_stats()`** —— 语料总览：会话数、最近标题、笔记条数。

零基础设施、本地优先、无向量数据库。Benchmark 目标：LongMemEval-S（检索 hit@k/MRR）、LoCoMo。

## 许可证

MIT —— 见 `LICENSE`。
