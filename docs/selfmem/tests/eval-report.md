# dsh-memory-curate 检索评测报告

- 时间：2026-11-23（Asia/Shanghai）
- 数据集：smoke-40x12（`bench/datasets/smoke.jsonl`）
- 规模：40 条记忆 / 12 条查询 / 1 个语料
- 检索方式：`src/retrieval.js` 的 `recall()`，标签 0.35 + 触发词 0.35 + BM25 0.3；embedding 关闭
- 运行环境：Windows 10.0.19044 / Node v24.22.1 / x64
- 临时存储：isolated temporary NDJSON store under bench/.tmp (removed after run)
- 复现命令（插件根目录）：`node bench/eval.mjs --dataset bench/datasets/smoke.jsonl --out bench/results/smoke.json --md docs/selfmem/tests/eval-report.md`
- 原始 JSON：`bench/results/smoke.json`

## 1. 检索质量

| 指标 | 数值 |
|---|---:|
| Recall@1 | 95.8%（0.9583） |
| Recall@3 | 100.0%（1.0000） |
| Recall@5 | 100.0%（1.0000） |
| Recall@10 | 100.0%（1.0000） |
| MRR | 1.0000 |

## 2. Token 节省

基线：每条查询所属语料的全部记忆文本之和；token 估算 = ceil(code points / 4)。

| k | 平均 top-k token | 平均语料基线 token | 节省 |
|---|---:|---:|---:|
| 1 | 6.166667 | 212 | 97.1% |
| 3 | 15.083333 | 212 | 92.9% |
| 5 | 20.833333 | 212 | 90.2% |
| 10 | 25.333333 | 212 | 88.1% |

数据集未提供 `contextTokens`，未计算相对完整会话的 token 节省。

## 3. 口径

- Recall@k：`gold` 按“记忆 id 优先、否则精确文本”解析；top-k 命中任一对应记忆即该 gold 命中。Recall@k = 命中 gold 数 / gold 总数，再对查询取平均。
- MRR：第一个命中任意 gold 的记忆排名的倒数（无命中记 0），对查询取平均。
- 近重复干扰项是独立记忆；同一 gold 精确文本对应多条记忆时，命中任一即算该 gold 命中。
- top-k token 是一次召回返回的记忆文本 token 之和；不足 k 条按实际返回计，无命中记 0。
- 记忆导入 `bench/.tmp` 下的临时 NDJSON store 后再调用 `recall()`；不读取/写入真实主库，运行后删除临时目录。
- 逐查询命中与 top-k 明细见原始 JSON。

## 4. 限制与未验证

- **内置 smoke 样本不是公开基准**：本次只有 40 条记忆、12 条查询，用于回归与管线自检，不能代表真实记忆规模，也不能与 Mem0/Zep 的公开分数直接比较。
- **LoCoMo / LongMemEval 尚未运行**：本环境没有内置公开数据集，脚本也不联网下载；`bench/locomo-to-jsonl.mjs` 提供转换入口，但尚未在真实 LoCoMo 文件上执行或核对分数。
- **检索仅使用 BM25 + 标签 + 触发词**：embedding 默认关闭，没有向量召回、LLM 重排或实体链接；这些数字只反映当前默认检索。
- gold 采用精确 id/文本匹配，轻微改写、同义表达和跨语言改写不算命中，可能低估实际语义检索能力。
- token 节省使用 4 字符/token 的粗略估算，中文可能被低估；该比例适合同口径自比较，不是真实 tokenizer 的精确账单。
- 样本小，没有置信区间或显著性检验；单次结果对数据构造敏感。
- 目前没有公开基准分数，**不能声称“与 Mem0 持平”**。

## 5. 结论

离线评测管线可复现：固定数据、固定导入顺序、临时 store、JSON 与 Markdown 输出。本次 smoke 数字只作为后续检索改动的回归基线；公开对标需要先用 LoCoMo/LongMemEval 实际文件复跑同一脚本，再报告可比较的 Recall@k 与 token 节省。
