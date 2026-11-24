#!/usr/bin/env node
/**
 * Offline retrieval eval for dsh-memory-curate.
 *
 * Imports dataset memories into a throw-away NDJSON store under bench/.tmp,
 * scores them with the plugin's own recall(), then removes the temp store.
 * The real memory store is never opened. No network, no dependencies.
 *
 * Dataset forms (blank lines ignored):
 *   per-query JSONL:
 *     {"query":"...","gold":["memory-id-or-exact-text"],"memories":[...]}
 *   whole corpus:
 *     {"name"?:...,"memories":[...],"queries":[{"query","gold":[...]}]}
 *   A whole-corpus object may be one JSONL line or one pretty-printed JSON file.
 *   Several whole-corpus lines are evaluated per corpus (converter output uses
 *   one corpus per LoCoMo conversation).
 *
 * Usage:
 *   node bench/eval.mjs [--dataset path.jsonl] [--k 1,3,5,10]
 *                       [--out path.json] [--md path.md]
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch, release } from 'node:os'
import { WEIGHTS, buildIndex, recall } from '../src/retrieval.js'
import { MemoryStore } from '../src/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATASET = join(HERE, 'datasets', 'smoke.jsonl')
const TMP_ROOT = join(HERE, '.tmp')
const DEFAULT_K = [1, 3, 5, 10]
const CLOCK = Date.UTC(2026, 0, 1)
const CHARS_PER_TOKEN = 4
const USAGE = [
  'Usage: node bench/eval.mjs [options]',
  '',
  'Options:',
  '  --dataset <path>   JSONL dataset (default: bench/datasets/smoke.jsonl)',
  '  --k <list>         Comma-separated cutoffs (default: 1,3,5,10)',
  '  --out <path>       Write the JSON result to this file',
  '  --md <path>        Write a Markdown report to this file',
  '  -h, --help         Show this help',
  '',
  'Dataset forms (blank lines ignored):',
  '  per query:  {"query":"...","gold":["id-or-exact-text"],"memories":[...]}',
  '  corpus:     {"name"?:...,"memories":[...],"queries":[{"query","gold":[...]}]}',
  '  A corpus object may be one JSONL line or one pretty-printed JSON file.',
  '  Multiple corpus lines are evaluated independently (one corpus per conversation).'
].join('\n')

const MF = new Set(['id', 'text', 'tags', 'triggers', 'entities'])
const QF = new Set(['query', 'gold', 'contextTokens'])
const CF = new Set(['name', 'contextTokens', 'memories', 'queries'])
const EF = new Set(['query', 'gold', 'contextTokens', 'memories'])
class EvalError extends Error {}
const fail = (message) => { throw new EvalError(message) }
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const round = (value) => Math.round(value * 1e6) / 1e6
const pct = (value) => `${(value * 100).toFixed(1)}%`
const estimateTokens = (text) => Math.ceil(Array.from(String(text)).length / CHARS_PER_TOKEN)
const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const quote = (value) => (/\s/.test(value) ? `"${value}"` : value)

function display (filePath) {
  const rel = relative(process.cwd(), filePath)
  const shown = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) ? rel : filePath
  return shown.split(sep).join('/')
}

function today () {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function environment () {
  const platform = process.platform === 'win32'
    ? 'Windows'
    : process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'linux' ? 'Linux' : process.platform
  return { os: `${platform} ${release()}`, node: process.version, arch: process.arch }
}

function parseArgs (argv) {
  const out = { dataset: DEFAULT_DATASET, k: [...DEFAULT_K], out: null, md: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--help' || raw === '-h') { out.help = true; continue }
    if (!raw.startsWith('--')) fail(`unexpected argument: ${raw}`)
    const equals = raw.indexOf('=')
    const flag = equals === -1 ? raw : raw.slice(0, equals)
    const inline = equals === -1 ? undefined : raw.slice(equals + 1)
    const value = () => {
      if (inline !== undefined) {
        if (!inline) fail(`${flag} requires a value`)
        return inline
      }
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) fail(`${flag} requires a value`)
      return next
    }
    if (flag === '--dataset') out.dataset = resolve(process.cwd(), value())
    else if (flag === '--k') out.k = parseK(value())
    else if (flag === '--out') out.out = resolve(process.cwd(), value())
    else if (flag === '--md') out.md = resolve(process.cwd(), value())
    else fail(`unknown option: ${flag}`)
  }
  if (out.out !== null && out.md !== null && out.out === out.md) fail('--out and --md must differ')
  if (out.out === out.dataset || out.md === out.dataset) fail('outputs must differ from --dataset')
  return out
}

function parseK (raw) {
  const values = []
  for (const part of raw.split(',')) {
    if (!part.trim()) continue
    if (!/^\d+$/.test(part.trim())) fail(`invalid --k: ${part}`)
    const value = Number(part)
    if (!Number.isSafeInteger(value) || value < 1) fail(`invalid --k: ${part}`)
    if (!values.includes(value)) values.push(value)
  }
  if (!values.length) fail('--k needs at least one value')
  return values.sort((a, b) => a - b)
}

async function loadDataset (filePath) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    fail(`cannot read dataset ${display(filePath)}: ${error?.message ?? error}`)
  }
  const source = raw.replace(/^\uFEFF/, '')
  const text = source.trim()
  if (!text) fail(`dataset is empty: ${display(filePath)}`)
  if (text.startsWith('{')) {
    let whole = null
    try { whole = JSON.parse(text) } catch { whole = null }
    if (plain(whole) && Object.hasOwn(whole, 'queries')) {
      return finish(filePath, [parseCorpus(whole, 1, 0)], 'whole-corpus')
    }
  }
  const lines = source.split(/\r?\n/)
  const entries = []
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue
    let value
    try { value = JSON.parse(lines[index]) } catch (error) {
      fail(`malformed JSON on line ${index + 1}: ${error?.message ?? error}`)
    }
    if (!plain(value)) fail(`line ${index + 1}: expected a JSON object`)
    entries.push({ line: index + 1, value })
  }
  if (!entries.length) fail('dataset contains no JSON objects')
  const kinds = entries.map((entry) => {
    const hasQueries = Object.hasOwn(entry.value, 'queries')
    const hasOne = Object.hasOwn(entry.value, 'query') || Object.hasOwn(entry.value, 'gold')
    if (hasQueries && hasOne) fail(`line ${entry.line}: object mixes "queries" with "query"/"gold"`)
    if (hasQueries) return 'corpus'
    if (hasOne) return 'example'
    fail(`line ${entry.line}: expected per-query or whole-corpus object`)
  })
  if (kinds.includes('corpus') && kinds.includes('example')) fail('dataset mixes whole-corpus and per-query forms')
  if (kinds.includes('corpus')) {
    return finish(filePath, entries.map((entry, index) => parseCorpus(entry.value, entry.line, index)), 'whole-corpus')
  }
  return finish(filePath, groupExamples(entries), 'per-query')
}

function groupExamples (entries) {
  const groups = new Map()
  for (const entry of entries) {
    const where = `line ${entry.line}`
    only(entry.value, EF, where)
    const memories = unique(normMemories(entry.value.memories, where), where)
    const query = normQuery(entry.value, where, null)
    const key = JSON.stringify(memories)
    let group = groups.get(key)
    if (group === undefined) {
      group = { name: `corpus-${groups.size + 1}`, explicit: false, memories, queries: [], line: entry.line }
      groups.set(key, group)
    }
    group.queries.push(query)
  }
  return [...groups.values()]
}

function parseCorpus (value, line, index) {
  const where = `line ${line} (whole-corpus object)`
  only(value, CF, where)
  let name = `corpus-${index + 1}`
  let explicit = false
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !value.name.trim()) fail(`${where}: "name" must be a non-empty string`)
    name = value.name.trim()
    explicit = true
  }
  const defaultContext = value.contextTokens === undefined
    ? null
    : contextValue(value.contextTokens, `${where}.contextTokens`)
  const memories = unique(normMemories(value.memories, `corpus "${name}"`), `corpus "${name}"`)
  const queries = normQueries(value.queries, `corpus "${name}"`, defaultContext)
  return { name, explicit, memories, queries, line }
}

function finish (filePath, corpora, form) {
  const names = new Set()
  for (const corpus of corpora) {
    if (names.has(corpus.name)) fail(`duplicate corpus name "${corpus.name}"`)
    names.add(corpus.name)
  }
  const totalMemories = corpora.reduce((sum, corpus) => sum + corpus.memories.length, 0)
  const totalQueries = corpora.reduce((sum, corpus) => sum + corpus.queries.length, 0)
  if (totalQueries === 0) fail('dataset contains no queries')
  const base = basename(filePath, extname(filePath))
  return {
    path: filePath,
    name: corpora.length === 1 && corpora[0].explicit ? corpora[0].name : base,
    form,
    corpora,
    totalMemories,
    totalQueries
  }
}

function only (value, allowed, where) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${where}: unknown field "${key}"`)
}

function normMemories (value, where) {
  if (!Array.isArray(value) || value.length === 0) fail(`${where}: "memories" must be a non-empty array`)
  return value.map((raw, index) => normMemory(raw, `${where} memory #${index + 1}`))
}

function normMemory (raw, where) {
  if (!plain(raw)) fail(`${where}: expected an object`)
  only(raw, MF, where)
  if (typeof raw.text !== 'string' || !raw.text.trim()) fail(`${where}: "text" must be a non-empty string`)
  let id = null
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !raw.id.trim()) fail(`${where}: "id" must be a non-empty string`)
    id = raw.id
  }
  return {
    id,
    text: raw.text,
    tags: stringList(raw.tags, `${where}.tags`),
    triggers: stringList(raw.triggers, `${where}.triggers`),
    entities: stringList(raw.entities, `${where}.entities`)
  }
}

function stringList (value, where) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${where} must be an array`)
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) fail(`${where}[${index}] must be a non-empty string`)
    return item
  })
}

function unique (memories, where) {
  const ids = new Set()
  for (const memory of memories) {
    if (memory.id === null) continue
    if (ids.has(memory.id)) fail(`${where}: duplicate memory id "${memory.id}"`)
    ids.add(memory.id)
  }
  return memories
}

function normQueries (value, where, defaultContext) {
  if (!Array.isArray(value) || value.length === 0) fail(`${where}: "queries" must be a non-empty array`)
  return value.map((raw, index) => {
    const itemWhere = `${where} query #${index + 1}`
    if (!plain(raw)) fail(`${itemWhere}: expected an object`)
    only(raw, QF, itemWhere)
    return normQuery(raw, itemWhere, defaultContext)
  })
}

function normQuery (raw, where, defaultContext) {
  if (typeof raw.query !== 'string' || !raw.query.trim()) fail(`${where}: "query" must be a non-empty string`)
  if (!Array.isArray(raw.gold) || raw.gold.length === 0) fail(`${where}: "gold" must be a non-empty array`)
  const gold = []
  const seen = new Set()
  for (let index = 0; index < raw.gold.length; index++) {
    const item = raw.gold[index]
    if (typeof item !== 'string' || !item.trim()) fail(`${where}: gold[${index}] must be a non-empty string`)
    if (seen.has(item)) fail(`${where}: duplicate gold label "${item}"`)
    seen.add(item)
    gold.push(item)
  }
  const contextTokens = raw.contextTokens === undefined
    ? defaultContext
    : contextValue(raw.contextTokens, `${where}.contextTokens`)
  return { query: raw.query, gold, contextTokens }
}

function contextValue (value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${where} must be a positive number`)
  return value
}

async function evaluate (dataset, options) {
  const store = await MemoryStore.open(join(options.tmpDir, 'eval.ndjson'), {
    now: (() => {
      let tick = 0
      return () => new Date(CLOCK + tick++ * 1000).toISOString()
    })()
  })
  const ks = options.k
  const maxK = Math.max(...ks)
  const perQuery = []
  const recallSum = Object.fromEntries(ks.map((k) => [k, 0]))
  const topSum = Object.fromEntries(ks.map((k) => [k, 0]))
  const contextTopSum = Object.fromEntries(ks.map((k) => [k, 0]))
  let mrrSum = 0
  let queryCount = 0
  let baselineSum = 0
  let contextQueries = 0
  let contextSum = 0

  for (const corpus of dataset.corpora) {
    const labels = memoryLabels(corpus.memories, corpus.name)
    const rows = []
    for (let index = 0; index < corpus.memories.length; index++) {
      const memory = corpus.memories[index]
      rows.push(await store.saveMemory({
        text: memory.text,
        tags: memory.tags,
        triggers: memory.triggers,
        entities: memory.entities,
        sessionId: 'bench-eval',
        seqs: [index],
        writeReason: 'bench/eval.mjs',
        promptVersion: 'bench-eval'
      }))
    }
    const labelByRow = new Map(rows.map((row, index) => [row.id, labels[index]]))
    const idToRow = new Map()
    const textToRows = new Map()
    for (let index = 0; index < corpus.memories.length; index++) {
      const memory = corpus.memories[index]
      if (memory.id !== null) idToRow.set(memory.id, rows[index])
      const list = textToRows.get(memory.text) ?? []
      list.push(rows[index])
      textToRows.set(memory.text, list)
    }
    const searchIndex = buildIndex(rows)
    const corpusTokens = rows.reduce((sum, row) => sum + estimateTokens(row.text), 0)
    for (let queryIndex = 0; queryIndex < corpus.queries.length; queryIndex++) {
      const query = corpus.queries[queryIndex]
      const targets = query.gold.map((label) => {
        const byId = idToRow.get(label)
        if (byId !== undefined) return { label, ids: new Set([byId.id]) }
        const byText = textToRows.get(label)
        if (byText !== undefined) return { label, ids: new Set(byText.map((row) => row.id)) }
        return fail(`corpus "${corpus.name}" query #${queryIndex + 1}: gold "${label}" is neither an id nor an exact text`)
      })
      const result = recall(query.query, rows, { index: searchIndex, limit: maxK })
      const ranked = result.hits.map((hit) => {
        const label = labelByRow.get(hit.id)
        if (label === undefined) fail(`internal error: unlabeled hit ${hit.id}`)
        return { hit, label }
      })
      let rank = 0
      for (let position = 0; position < ranked.length; position++) {
        if (targets.some((target) => target.ids.has(ranked[position].hit.id))) {
          rank = position + 1
          break
        }
      }
      const recallAt = {}
      const tokensAt = {}
      for (const k of ks) {
        const top = ranked.slice(0, k)
        const topIds = new Set(top.map((item) => item.hit.id))
        const hitTargets = targets.reduce((count, target) => count + (hasAny(target.ids, topIds) ? 1 : 0), 0)
        const value = hitTargets / targets.length
        recallAt[k] = value
        recallSum[k] += value
        const count = top.reduce((sum, item) => sum + estimateTokens(item.hit.text), 0)
        tokensAt[k] = count
        topSum[k] += count
        if (query.contextTokens !== null) contextTopSum[k] += count
      }
      const reciprocal = rank > 0 ? 1 / rank : 0
      mrrSum += reciprocal
      queryCount += 1
      baselineSum += corpusTokens
      if (query.contextTokens !== null) {
        contextQueries += 1
        contextSum += query.contextTokens
      }
      perQuery.push({
        corpus: corpus.name,
        query: query.query,
        gold: query.gold,
        rank,
        recall: recallAt,
        topKTokens: tokensAt,
        contextTokens: query.contextTokens,
        topHits: ranked.slice(0, maxK).map((item) => ({ memory: item.label, score: item.hit.score }))
      })
    }
  }

  if (queryCount !== dataset.totalQueries) fail(`internal error: evaluated ${queryCount} of ${dataset.totalQueries} queries`)
  const active = store.activeMemories().length
  if (active !== dataset.totalMemories) fail(`internal error: imported ${active} of ${dataset.totalMemories} memories`)
  const averageBaseline = baselineSum / queryCount
  const metrics = ks.map((k) => ({ k, value: round(recallSum[k] / queryCount) }))
  const averageTop = ks.map((k) => ({ k, value: round(topSum[k] / queryCount) }))
  const savings = ks.map((k) => ({ k, value: round(1 - (topSum[k] / queryCount) / averageBaseline) }))
  const context = contextQueries === 0 ? null : {
    coverage: { queries: contextQueries, total: queryCount },
    averageContextTokens: round(contextSum / contextQueries),
    averageTopKTokens: ks.map((k) => ({ k, value: round(contextTopSum[k] / contextQueries) })),
    savings: ks.map((k) => ({ k, value: round(1 - (contextTopSum[k] / contextQueries) / (contextSum / contextQueries)) }))
  }

  return {
    date: options.date,
    timeZone: 'Asia/Shanghai',
    dataset: { name: dataset.name, path: display(dataset.path), form: dataset.form, corpora: dataset.corpora.length },
    environment: environment(),
    method: {
      retrieval: 'bm25+tag+trigger',
      embedding: 'off',
      weights: { tag: WEIGHTS.tag, trigger: WEIGHTS.trigger, bm25: WEIGHTS.bm25 },
      tokenEstimate: `ceil(code points / ${CHARS_PER_TOKEN})`,
      store: 'isolated temporary NDJSON store under bench/.tmp (removed after run)'
    },
    totals: { memories: dataset.totalMemories, queries: queryCount, corpora: dataset.corpora.length },
    k: ks,
    metrics: { recall: metrics, mrr: round(mrrSum / queryCount) },
    tokenSavings: {
      baseline: 'sum of all memory texts in each query corpus',
      averageBaselineTokens: round(averageBaseline),
      perK: ks.map((k, index) => ({ k, averageTopKTokens: averageTop[index].value, savings: savings[index].value })),
      context
    },
    perQuery
  }
}

function memoryLabels (memories, where) {
  const used = new Set()
  return memories.map((memory, index) => {
    const label = memory.id === null ? `mem#${index + 1}` : memory.id
    if (used.has(label)) fail(`corpus "${where}": duplicate memory label "${label}"`)
    used.add(label)
    return label
  })
}

function hasAny (left, right) {
  for (const value of left) if (right.has(value)) return true
  return false
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(USAGE + '\n'); return }
  const dataset = await loadDataset(options.dataset)
  await fs.mkdir(TMP_ROOT, { recursive: true })
  const tmpDir = await fs.mkdtemp(join(TMP_ROOT, 'eval-'))
  let result
  try {
    result = await evaluate(dataset, { tmpDir, date: today(), k: options.k })
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
      await fs.rmdir(TMP_ROOT)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
        process.stderr.write(`warning: could not remove temporary store ${tmpDir}: ${error?.message ?? error}\n`)
      }
    }
  }
  const json = JSON.stringify(result, null, 2) + '\n'
  if (options.out !== null) {
    await fs.mkdir(dirname(options.out), { recursive: true })
    await fs.writeFile(options.out, json, 'utf8')
  }
  if (options.md !== null) {
    await fs.mkdir(dirname(options.md), { recursive: true })
    await fs.writeFile(options.md, renderMarkdown(result, {
      command: command(options),
      outPath: options.out === null ? null : display(options.out)
    }), 'utf8')
  }
  if (options.out === null) process.stdout.write(json)
  else process.stdout.write(summary(result, options) + '\n')
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.message ?? String(error)}\n`)
  process.exitCode = 1
})

function summary (result, options) {
  const k = result.k.includes(5) ? 5 : result.k[result.k.length - 1]
  const item = result.tokenSavings.perK.find((entry) => entry.k === k)
  const lines = [
    `dataset: ${result.dataset.name} (${result.totals.queries} queries, ${result.totals.memories} memories, ${result.totals.corpora} corpora)`,
    result.metrics.recall.map((entry) => `Recall@${entry.k}: ${pct(entry.value)}`).join('  '),
    `MRR: ${result.metrics.mrr.toFixed(4)}`,
    `avg top-${k} tokens: ${item.averageTopKTokens} vs corpus ${result.tokenSavings.averageBaselineTokens} (${pct(item.savings)} saved)`
  ]
  if (options.out !== null) lines.push(`wrote JSON: ${display(options.out)}`)
  if (options.md !== null) lines.push(`wrote Markdown: ${display(options.md)}`)
  return lines.join('\n')
}

function command (options) {
  const parts = ['node bench/eval.mjs', `--dataset ${quote(display(options.dataset))}`]
  if (options.k.join(',') !== DEFAULT_K.join(',')) parts.push(`--k ${options.k.join(',')}`)
  if (options.out !== null) parts.push(`--out ${quote(display(options.out))}`)
  if (options.md !== null) parts.push(`--md ${quote(display(options.md))}`)
  return parts.join(' ')
}

function renderMarkdown (result, meta) {
  const smoke = /smoke/i.test(result.dataset.name) || /smoke/i.test(result.dataset.path)
  const w = result.method.weights
  const rawJson = meta.outPath === null ? 'stdout' : '`' + cell(meta.outPath) + '`'
  const lines = [
    '# dsh-memory-curate 检索评测报告',
    '',
    `- 时间：${result.date}（${result.timeZone}）`,
    `- 数据集：${cell(result.dataset.name)}（\`${cell(result.dataset.path)}\`）`,
    `- 规模：${result.totals.memories} 条记忆 / ${result.totals.queries} 条查询 / ${result.totals.corpora} 个语料`,
    `- 检索方式：\`src/retrieval.js\` 的 \`recall()\`，标签 ${w.tag} + 触发词 ${w.trigger} + BM25 ${w.bm25}；embedding 关闭`,
    `- 运行环境：${result.environment.os} / Node ${result.environment.node} / ${result.environment.arch}`,
    `- 临时存储：${result.method.store}`,
    `- 复现命令（插件根目录）：\`${meta.command}\``,
    `- 原始 JSON：${rawJson}`,
    '',
    '## 1. 检索质量',
    '',
    '| 指标 | 数值 |',
    '|---|---:|',
    ...result.metrics.recall.map((entry) => `| Recall@${entry.k} | ${pct(entry.value)}（${entry.value.toFixed(4)}） |`),
    `| MRR | ${result.metrics.mrr.toFixed(4)} |`,
    '',
    '## 2. Token 节省',
    '',
    `基线：每条查询所属语料的全部记忆文本之和；token 估算 = ${result.method.tokenEstimate}。`,
    '',
    '| k | 平均 top-k token | 平均语料基线 token | 节省 |',
    '|---|---:|---:|---:|',
    ...result.tokenSavings.perK.map((entry) => `| ${entry.k} | ${entry.averageTopKTokens} | ${result.tokenSavings.averageBaselineTokens} | ${pct(entry.savings)} |`)
  ]
  if (result.tokenSavings.context === null) {
    lines.push('', '数据集未提供 `contextTokens`，未计算相对完整会话的 token 节省。')
  } else {
    const context = result.tokenSavings.context
    lines.push('', `有 ${context.coverage.queries}/${context.coverage.total} 条查询提供上下文 token：`, '', '| k | 平均 top-k token | 平均上下文 token | 节省 |', '|---|---:|---:|---:|')
    for (const entry of context.averageTopKTokens) {
      const saving = context.savings.find((item) => item.k === entry.k)
      lines.push(`| ${entry.k} | ${entry.value} | ${context.averageContextTokens} | ${pct(saving.value)} |`)
    }
  }
  lines.push('', '## 3. 口径', '')
  lines.push('- Recall@k：`gold` 按“记忆 id 优先、否则精确文本”解析；top-k 命中任一对应记忆即该 gold 命中。Recall@k = 命中 gold 数 / gold 总数，再对查询取平均。')
  lines.push('- MRR：第一个命中任意 gold 的记忆排名的倒数（无命中记 0），对查询取平均。')
  lines.push('- 近重复干扰项是独立记忆；同一 gold 精确文本对应多条记忆时，命中任一即算该 gold 命中。')
  lines.push('- top-k token 是一次召回返回的记忆文本 token 之和；不足 k 条按实际返回计，无命中记 0。')
  lines.push('- 记忆导入 `bench/.tmp` 下的临时 NDJSON store 后再调用 `recall()`；不读取/写入真实主库，运行后删除临时目录。')
  lines.push('- 逐查询命中与 top-k 明细见原始 JSON。')
  lines.push('', '## 4. 限制与未验证', '')
  if (smoke) {
    lines.push(`- **内置 smoke 样本不是公开基准**：本次只有 ${result.totals.memories} 条记忆、${result.totals.queries} 条查询，用于回归与管线自检，不能代表真实记忆规模，也不能与 Mem0/Zep 的公开分数直接比较。`)
    lines.push('- **LoCoMo / LongMemEval 尚未运行**：本环境没有内置公开数据集，脚本也不联网下载；`bench/locomo-to-jsonl.mjs` 提供转换入口，但尚未在真实 LoCoMo 文件上执行或核对分数。')
  } else {
    lines.push('- 本次数据集来自外部文件；解析、切分和 gold 映射不保证与 LoCoMo/LongMemEval 官方评测协议完全一致，分数不等同于官方榜单。')
  }
  lines.push('- **检索仅使用 BM25 + 标签 + 触发词**：embedding 默认关闭，没有向量召回、LLM 重排或实体链接；这些数字只反映当前默认检索。')
  lines.push('- gold 采用精确 id/文本匹配，轻微改写、同义表达和跨语言改写不算命中，可能低估实际语义检索能力。')
  lines.push('- token 节省使用 4 字符/token 的粗略估算，中文可能被低估；该比例适合同口径自比较，不是真实 tokenizer 的精确账单。')
  lines.push('- 样本小，没有置信区间或显著性检验；单次结果对数据构造敏感。')
  lines.push('- 目前没有公开基准分数，**不能声称“与 Mem0 持平”**。')
  lines.push('', '## 5. 结论', '')
  lines.push('离线评测管线可复现：固定数据、固定导入顺序、临时 store、JSON 与 Markdown 输出。本次 smoke 数字只作为后续检索改动的回归基线；公开对标需要先用 LoCoMo/LongMemEval 实际文件复跑同一脚本，再报告可比较的 Recall@k 与 token 节省。')
  return lines.join('\n') + '\n'
}
