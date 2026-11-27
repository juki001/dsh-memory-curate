# dsh-memory-curate 对外发布文案

- 版本：0.3.2
- 仓库：https://github.com/juki001/dsh-memory-curate
- npm：https://www.npmjs.com/package/dsh-memory-curate
- 反馈贴：https://github.com/juki001/dsh-memory-curate/issues/1

## 一句话

给 DeepSeek Harness 的可审计长期记忆：先记住，再压缩；最近 5 个真人回合不动；每条记忆都能追到来源并随时改。

## 中文主贴（约 300 字）

AI 忘事不是因为它笨，是因为它没有“可查的记性”。

很多记忆插件只做一件事：把一段文字塞进提示词。于是你会遇到三种情况：它记住了不该记的、忘了该记的、记错了还改不掉。

`dsh-memory-curate` 换了个方向：

- **先记忆，后压缩**：一段对话要进入压缩，必须先有落库记忆、且能被区间内的实体召回；否则推迟，而不是为了压而压。
- **最近 5 个真人回合不动**：按真实的人类消息计算，长回合整体保护。
- **全部可审计**：写入、修改、删除、召回、压缩、提示版本变更都追加审计行，永不覆盖旧行；可以用 trace 追到它当时为什么这么决定。
- **对用户诚实**：它不背着你做决定，改了哪条、删了哪条，都留痕。

零配置、本地优先，数据就一个可读的 NDJSON 文件；支持共享与私有范围，多助手之间不会互相看错记忆。

安装：

```bash
dsh plugin --profile web add github:juki001/dsh-memory-curate
# 或
npm i dsh-memory-curate
```

它现在还是 0.3.x，我会优先修真实使用中遇到的问题。用下来哪里别扭，欢迎在反馈贴里说。

## English blurb (for non-Chinese channels)

Auditable long-term memory for DeepSeek Harness.

Most memory plugins inject text into the prompt and hope. `dsh-memory-curate` does the opposite: before compaction is allowed, the conversation must already be covered by stored memories that the compacted range can recall. The last five human turns are never touched. Every write, recall, edit and compaction appends an audit row that is never rewritten, so you can always see why something was remembered, changed or forgotten.

Zero-config, local-first, one human-readable NDJSON file, per-assistant shared/private scopes.

```bash
dsh plugin --profile web add github:juki001/dsh-memory-curate
```

## 短版（社区消息、群公告）

> 给 DeepSeek Harness 的长期记忆插件：先记忆后压缩、最近 5 个真人回合不动、每条记忆可追溯可修改、零配置本地优先。
> 仓库：https://github.com/juki001/dsh-memory-curate
> 安装：`dsh plugin --profile web add github:juki001/dsh-memory-curate`

## 已发布位置

| 渠道 | 状态 | 链接 |
|---|---|---|
| npm | 已发布 0.3.2 | https://www.npmjs.com/package/dsh-memory-curate |
| GitHub Release | v0.3.2 | https://github.com/juki001/dsh-memory-curate/releases/tag/v0.3.2 |
| GitHub 反馈贴 | 已创建 | https://github.com/juki001/dsh-memory-curate/issues/1 |
| awesome-dsh-plugin | PR 待合并 | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/19267 |

## 待人工动作

- awesome-dsh-plugin-pro 的自荐区要求仓库 Star > 10，当前 0 Star，暂不可提交；
- Discord / QQ / 微信群、V2EX、掘金、X 等平台需要账号登录，我没有权限直接发，文案已备好。
