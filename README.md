# dsh-memory-curate

> 跨对话记住偏好与项目约定；压缩归宿主、记忆走旁路绝不阻塞；每条记忆可追溯、可修改；零配置、本地优先，支持共享与私有范围。

> 普通用户请先阅读 [使用说明书（中英双语）](使用说明书.md)；本 README 面向开发、部署与排障。

给 DeepSeek Harness 的可审计长期记忆：运行时自己生成“该记什么、怎么记”的抽取提示，把记忆、审计与提示版本写进同一个 NDJSON 文件，用标签 + 触发词 + BM25（可选向量融合）召回。压缩由宿主引擎按 token 压力自动完成，插件不否决、不推迟、不注入提醒，只在包裹层保留防损坏护栏。

## 为什么需要它

Harness 的压缩引擎本身已经按 token 压力与保留尾部工作，不需要插件替它决定“能不能压”。本插件的定位是压缩旁边的记忆层，而不是压缩之前的闸门：

- **压缩归宿主，记忆走旁路**：压力与溢出都交给宿主 `compaction-basic`（阈值 + 按 token 预算保留最近尾部）；插件的包裹只拦截会写坏会话的区间（系统头、倒序、已离开 surface 的区间）。
- **记忆写入永不阻塞压缩**：写入是 best-effort 旁路，失败也不影响这一轮把上下文压下去——这是 MemGPT/Letta、OpenHands、OpenClaw 共同的取舍：摘要归运行时，记忆是旁路。
- **不删原文**：压缩只改模型可见投影，保留可恢复回执；折叠的工具结果可用 `memory_curate_trace` 找回 `fullTextRef`。
- **工具结果可折叠**：`pruneProtected` 按 `protectTurns` 保护最近回合内的工具输出，区外按 head + 标记 + tail 折叠。
- **系统提示头不动**：v4 会话的 `system/message` 固定占 surface 节点 0（受保护的系统头），包装层在区间起点落在节点 0 时直接拒绝，避免宿主先落盘摘要、再拒绝对 surface 的替换，把摘要留成一份遮蔽系统头的坏记录。
- **全部可审计**：写入、更新、删除、召回、折叠、压缩、过期、合并建议、提示版本变更都追加审计行，永不覆盖旧行。
- **审计不会无限撑大主文件**：超过 `auditArchiveBytes`（默认 50 MB）时，按 `auditArchiveRollRatio`（默认 40%）把最旧审计滚到 `<store>.archive/`，主库保留约 60%；`trace` 仍会跨归档读取，并可用 `retain_audit` 永久保留关键决策行。

## 安装

直接从 GitHub 安装：

```bash
dsh plugin --profile web add github:juki001/dsh-memory-curate
```

也可以直接从 npm 安装（已发布 0.3.2）：

```bash
dsh plugin --profile web add dsh-memory-curate
```

或在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入 `dsh-memory-curate` 后 `pnpm install`。本包自带 `cordis.patch.yml`，会插入一个 `memory-curate` 插件条目，不修改宿主压缩引擎的配置。

要求：DSH >= 0.2.2-rc.1（< 0.3.0-0）。

## 配置界面

所有配置项都是 `volatile()` 字段，DSH 设置页会自动渲染成选择/开关/数字控件，保存后即时生效：

| 字段 | 默认 | 说明 |
|---|---|---|
| `protectTurns` | 5 | 工具结果折叠与记忆溯源使用的最近真人回合数；不再否决压缩 |
| `protectToolResults` | true | 保护区内工具结果不折叠 |
| `softRatio` | 0.80 | 兼容项：记忆压力读数阈值；压缩路径已交还宿主，不参与否决 |
| `hardRatio` | 0.92 | 兼容项：同上，已不由插件用于强制压缩 |
| `headroomTokens` | 0 | 绝对余量覆盖：>0 时优先于比例；0 表示按 `headroomRatio` 自动计算 |
| `headroomRatio` | 0.0625 | 预算余量占上下文窗口的比例；按模型大小自适应，`headroomTokens=0` 时生效 |
| `maxDeferSteps` | 3 | 连续推迟上限，超过转强制 |
| `captureMode` | tool-only | `auto-remind` 时在候选出现后注入一次提醒 |
| `anchorDetail` | 标准 | 锚点里每条标签显示几个触发词 |
| `retrievalMode` | bm25 | `hybrid` 时把向量排序与 BM25 用 RRF 融合；端点缺失或调用失败自动回退 BM25 |
| `embeddingBaseURL` | 空 | OpenAI 兼容 embeddings 地址，例如 `http://127.0.0.1:1234/v1` |
| `embeddingModel` | 空 | embeddings 模型 id |
| `embeddingApiKeyEnv` | 空 | 存放 API Key 的环境变量名；本地端点可留空 |
| `embeddingWeight` | 0.5 | 融合时向量排序的 RRF 权重 |
| `consolidateMode` | suggest | 写入后生成合并/冲突建议；只提议、不覆盖，确认后才 supersede |
| `namespace` | default | 本地命名空间；不同 namespace 默认互相不可见 |
| `defaultVisibility` | shared | 新记忆默认可见性：`shared` 同命名空间可读；`private` 仅写入会话可读写（本地 UI 管理员始终可见） |
| `singleWriter` | true | 为 store 获取单写者锁；第二个 DSH 进程降级为只读，避免并发写坏 NDJSON |
| `decayHalfLifeDays` | 90 | 召回排序的时间衰减半衰期；0 关闭衰减 |
| `embedding` | off | 兼容项：`auto` 等价于 `retrievalMode=hybrid` |
| `storePath` | 空 | 留空用 `$DSH_HOME/data/memory-curate/memory-curate.ndjson` |
| `auditArchiveBytes` | 50 MB | 审计主文件超过该字节数后，把最旧审计滚动到 `<store>.archive/`；范围 1 MB–1 GB |
| `auditArchiveRollRatio` | 0.40 | 每次滚动迁走当前审计字节的比例；默认 40%，主库保留约 60% |

`softRatio` 必须小于 `hardRatio`，否则插件拒绝加载。

**关于阈值的口径**：`softRatio`/`hardRatio` 的分母是 `contextWindow − header.maxTokens − headroom`，其中 `headroom` 默认按 `headroomRatio × contextWindow` 随模型自适应（下限 **8192**；`headroomTokens=0` 时生效，置为 >0 则用绝对值覆盖）。以 deepseek-flash 为例：上下文 1,048,576、单请求预留输出 256,000，`headroomRatio=0.0625` 得余量 65,536，可用预算 727,040，默认软阈值在约 58% 窗口处触发；同样配置在 10 万上下文模型上余量按比例只有 6,250、被下限抬到 8,192，预算约 75,808，不再被固定值吃光。若按裸窗口计算 0.8（838,860），会高于服务端允许的消息上限 792,576，压缩永远等不到触发。

## 四个工具

- `memory_curate_save`：保存一条记忆（正文、标签、触发词、实体、写入理由、结构理由、重要性、有效期、可见性），自动带来源 session/seq。
- `memory_curate_recall`：按标签/触发词/BM25（可选向量融合）召回，返回命中原因与审计 id；只返回当前 agent 可见的记忆。
- `memory_curate_trace`：按记忆 id 或 seq 查写入、更新、召回、折叠、过期、压缩轨迹；跨 scope 的私有记忆不可见。
- `memory_curate_admin`：`stats` / `prompt_show` / `prompt_regenerate` / `prompt_rollback` / `delete` / `suggestions` / `apply_suggestion` / `dismiss_suggestion`。

## 存储格式

单文件 NDJSON，每行一个 JSON 对象，`kind` 区分：

- `header`：schema 版本；
- `memory`：自包含的记忆行（含 `source{sessionId,seqs}`、`writeReason`、`structureReason`、`importance`、`validFrom`、`validUntil`、`namespace`、`owner`、`visibility`、`promptVersion`）；
- `memory_tombstone`：删除墓碑；
- `suggestion`：合并/冲突建议（`proposed` / `applied` / `dismissed`），不覆盖任何记忆；
- `prompt`：运行时生成的抽取提示与版本状态（`proposed` / `active` / `retired` / `rejected`）；
- `audit`：所有决策轨迹；
- `meta`：索引与计数。

更新和删除都追加新行并指向目标 id，旧行保留。`supersedes` 允许是数组，用于把两条相近记忆合并为一条。

## 语义检索（可选）

默认零配置、纯 BM25。要打开混合检索：

1. 设置页把 `retrievalMode` 切到 `hybrid`；
2. 填 `embeddingBaseURL` 与 `embeddingModel`（OpenAI 兼容 `/embeddings`）；
3. 需要鉴权时把 key 放进环境变量，再把变量名写进 `embeddingApiKeyEnv`。

实现要点：向量只缓存在内存（NDJSON 保持可读）；查询与候选记忆一次批量嵌入；BM25 排名与余弦排名用 RRF 融合（两者分数尺度不同也无需校准）；任何一次嵌入失败都退回 BM25，并把 `fallback` 写进 recall 审计行。

## 整理建议（合并 / 冲突）

写入一条新记忆后，插件把它与现有记忆做相似度扫描（0.6 ≤ 相似度 < 0.82；≥0.82 已在写入时判重拒绝）。命中时追加一条 `suggestion`：

- `merge`：两条高度相似，建议合并为一条；
- `conflict`：两条相似但一正一反（如“默认启用遥测”对“默认不要启用遥测”），建议确认后合并。

建议**只提议**，不会自动覆盖。用 `memory_curate_admin action=suggestions` 查看，`apply_suggestion` 确认（可传 `text` 自定义合并后的正文），`dismiss_suggestion` 关闭；应用时旧行全部被新行的 `supersedes` 引用，历史仍可回放。

## 时效与重要性

- 每条记忆可带 `importance`（1–5，默认 3）与 `validUntil`；召回分数乘上 `0.6–1.0` 的重要性系数和 `0.25` 封底的半衰期衰减。
- `validUntil` 过期后**不删除**：记忆转为 `expired`，退出默认召回，并写一条 `expire` 审计；需要时用 `includeExpired` 查看。
- “上次使用时间”不额外写行，直接从 recall 审计流里派生，审计仍是唯一事实来源。

## 记忆浏览界面

插件自带一个浏览器侧设置分区（`dsh.client`）与宿主只读/受控写路由：搜索、按标签过滤、查看正文/来源/审计、内联编辑（追加式 supersede）、删除（追加墓碑），并含一个**"检索与压缩设置"表单**（检索模式、嵌入端点/模型/Key 环境变量、向量权重、余量比例、软/硬阈值），保存后即时生效。界面与命令行工具共用同一份 NDJSON 与审计，不引入第二套存储。

配置表单通过 `GET/POST /plugins/dsh-memory-curate/config` 读写；改动写入 store 同目录的 `config-override.json`，下次启动时覆盖 `cordis.patch.yml` 里的同名项，所以改参数不必再手改 YAML。

## 多 agent 共享与权限

同一 profile 的多个 agent 共用一个 store，但每条记忆带三个 scope 字段：

- `namespace`：默认取配置的 `namespace`；不同命名空间默认互相不可见，UI 管理员可以看到全部。
- `owner`：写入它的会话 id，用于审计和写权限。
- `visibility`：
  - `shared`（默认）：同命名空间可读，只有 owner 可改；
  - `private`：只有 owner 会话可读写（本地 UI 管理员仍可查看/编辑）；
  - `open`：同命名空间可读可改。

召回、trace、重复检测、整理建议、锚点、压缩写闸/召回闸都按调用 agent 的 scope 过滤，私有记忆不会漏进另一个 agent 的上下文。工具保存时可传 `visibility`；旧 v2 行加载为 ownerless `shared`，保持可读可写以便迁移。

**单写者锁**：`singleWriter=true` 时启动会创建 `<store>.lock`。第二个 DSH 进程拿不到锁时**降级为只读**（召回、浏览、回溯可用，写入/编辑/删除返回 `STORE_READ_ONLY`），避免两个进程同时 append 损坏 NDJSON。崩溃留下的锁只有在记录的 PID 已消失（同机可校验时）或锁超过 60 秒且无法校验 PID 时才被接管；释放时会校验随机 token，不会误删别人的锁。

## 评测

`bench/eval.mjs` 是可复现的召回评测：把数据集写入临时存储，跑 Recall@1/3/5/10、MRR 与 token 节省，输出 JSON + Markdown。内置 smoke 样本用于自查；接入 LoCoMo 时用 `bench/locomo-to-jsonl.mjs` 转换。数字与口径见 `docs/selfmem/tests/eval-report.md`——**在跑真实数据集之前，不对外宣称对标任何竞品**。

## 性能（本机实测）

1 万条记忆：顺序写入约 1,700 条/秒（5.8 秒）→ 文件 5.3MB，重启加载 75ms；召回按 store revision 缓存倒排索引，1 万条 p50 34ms、p99 43ms；5MB 工具结果折叠 122ms；1 万节点 surface 计算 5 轮窗口 1.3ms；1 万行存储 trace 查询 p50 0.43ms。完整数据见 `docs/selfmem/tests/perf-report.md`。

## 压缩接入方式

Web profile 把压缩引擎下沉到每个 agent preset 的隔离域，顶层没有 `compaction` 服务。插件因此不 `inject: ['compaction']`，而是在 `agent/created` 时用 `agentPresets.serviceFor(agent, 'compaction')` 取得该预设实际使用的引擎实例，一次性包裹：

1. **压力路径**：`compactIfNeeded` 直接委派宿主——阈值、保留尾部与压缩区间全部由宿主 `compaction-basic` 决定，插件不再计算保护窗口、不再推迟计数。
2. **溢出恢复**：`context-overflow` 同样直接委派宿主，服务端拒绝后由宿主用 `retainTokens: 0` 恢复。
3. **直接区间**：包裹 `compactRegion`，只保留防损坏护栏——区间起于受保护系统头（节点 0）、区间倒序、或区间已不在 surface 上都立即拒绝并审计；其余区间原样转交宿主。
4. **工具结果折叠**：包裹同域的 `toolResultPruner.pruneSession`，保护区内不折叠，区外按 head 4096 + 标记 + tail 1024 折叠，并复刻 `compaction/prune` 影子价事件。

若某个 preset 没有压缩引擎，插件降级为“只提供记忆工具/召回/锚点”，并写一条 `degraded` 审计，不阻塞加载。

## 开发

```bash
npm test        # 117 条单测，无需模型凭据
npm run selfcheck
npm run observe # 只读查看运行中的存储：记忆数、compact 决策、折叠与保护区跳过
node bench/eval.mjs --md /tmp/eval.md   # 召回评测（内置 smoke 样本）
```

单测通过一个解析钩子把 `@deepseek-ai/*` 指向本机 Harness 安装，因此插件目录不需要安装 peer 依赖。压缩委派与三条防损坏护栏、压力预算、折叠算法、NDJSON 存储、BM25/融合检索、时效衰减、合并建议与提示校验都有独立断言；`REG-01` 复现并锁定了旧版的“保护区吃满预算导致永不压缩”死锁。

## 与 billion-context 共存

Web profile 里若同时安装了 billion-context，它的 `bili-compaction-gate` 会在自己启用压缩时把各 agent preset 内的 `compaction-basic` 全部禁用；本插件此时取不到压缩引擎，只能提供记忆工具、检索、审计和锚点（会写一条 `compact decision=degraded` 审计）。

如果希望本插件（以及宿主压缩）正常工作，需要让 `compaction-basic` 不被 bili 禁用，在 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: bili-native
  disabled: true
```

保留 `bili-compaction-gate`（它提供 preset 需要的注入服务，不能一起关）。改完必须**重启 DSH 进程**：bili 的启用标记存在进程内存里，热加载不会清除；重启后新会话的审计应出现 `compact decision=attached`。

## 关于我们

本插件由 **久棋科技 · 火火团队** 维护，AI 助手 **火星（Mars）**。

- 邮箱：`5535483@qq.com`
- 微信：`juki005`
- 公众号：`juki115`

合作、集成、反馈和问题报告，欢迎通过以上方式联系。更多信息见 [CONTACT.md](CONTACT.md)。

## 边界

- 不实现压缩算法，摘要与表面替换始终由宿主 `compactRegion` 完成。
- 不重写保护区原文，只在压缩后刷新轻量锚点段。
- 自生成提示必须持久化、版本化、可回滚；每条记忆记录所用提示版本。
- 语义检索只做召回融合，不改变存储格式；向量不落盘。
- 权限是本地单机 scope，不是多租户 RBAC；跨进程共享靠单写者锁，不提供远程身份认证。
- 不依赖任何其他记忆插件或开发期工具链。

MIT License.
