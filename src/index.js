import { homedir } from 'node:os'
import { promises as fs } from 'node:fs'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from './store.js'
import { acquireStoreLock } from './lock.js'
import { registerMemoryRoutes } from './browser-routes.js'
import { recall, buildIndex, duplicates, similarity } from './retrieval.js'
import { createEmbedder, cosine, rrfFuse } from './semantic.js'
import { proposePairs, suggestedText, pairKey } from './consolidate.js'
import { buildAnchor } from './anchor.js'
import {
  normalizeNamespace,
  normalizeVisibility,
  agentSessionId,
  actorOf,
  callerScope,
  scopeKeyOf,
  canRead,
  canWrite,
  visibleRows
} from './scope.js'
import { computeProtectedWindow, protectedHeadSeq, recentHumanText } from './window.js'
import { foldToolResults } from './prune.js'
import { regionText, regionQuery, routedTarget } from './compaction.js'
import {
  BUILTIN_PROMPT,
  deriveTags,
  extractEntities,
  looksLikeMemoryCandidate,
  parsePromptJson,
  policyText,
  replaySamples,
  validatePrompt
} from './prompt.js'

export const name = 'dsh-memory-curate'
export const inject = ['tools', 'systemPrompt', 'tokenMeter', 'llm']
export const SERVICE_NAME = 'memoryCurate'

const SECTION_ORDER = 750
const ANCHOR_MAX_CHARS = 400
/** Fields the settings UI may edit and persist as runtime overrides. */
const UI_CONFIG_KEYS = [
  'protectTurns', 'softRatio', 'hardRatio', 'maxDeferSteps',
  'retrievalMode', 'embedding', 'embeddingBaseURL', 'embeddingModel',
  'embeddingApiKeyEnv', 'embeddingWeight', 'headroomTokens', 'headroomRatio'
]

export const Config = Schema.object({
  protectTurns: Schema.number().step(1).min(1).max(20).default(5)
    .description('最近多少个真人回合不参与压缩/折叠').volatile(),
  protectToolResults: Schema.boolean().default(true)
    .description('保护区内工具结果是否不折叠；默认 true，关闭后保护区内的旧工具结果也会折叠').volatile(),
  softRatio: Schema.number().step(0.01).min(0.5).max(0.95).default(0.80)
    .description('软阈值：上下文占用达到该比例才考虑记忆驱动压缩').volatile(),
  hardRatio: Schema.number().step(0.01).min(0.5).max(0.99).default(0.92)
    .description('硬阈值：达到后即使记忆闸门未过也强制压缩').volatile(),
  maxDeferSteps: Schema.number().step(1).min(1).max(50).default(3)
    .description('连续推迟多少次后转为强制压缩').volatile(),
  captureMode: Schema.union(['tool-only', 'auto-remind']).default('tool-only')
    .description('捕获方式：只看工具写入，或额外在下一步注入一条保存提醒').volatile(),
  anchorDetail: Schema.union(['精简', '标准', '详细']).default('标准')
    .description('锚点里每个标签展示的触发词数量').volatile(),
  retrievalMode: Schema.union(['bm25', 'hybrid']).default('bm25')
    .description('检索模式：bm25 为零配置默认；hybrid 在配置了 embedding 端点后与向量融合，失败自动回退').volatile(),
  embedding: Schema.union(['off', 'auto']).default('off')
    .description('兼容项：auto 等价于 retrievalMode=hybrid；端点未配好时仍走 BM25').volatile(),
  embeddingBaseURL: Schema.string().default('')
    .description('OpenAI 兼容的 embeddings 地址，例如 http://127.0.0.1:1234/v1').volatile(),
  embeddingModel: Schema.string().default('')
    .description('embeddings 模型 id').volatile(),
  embeddingApiKeyEnv: Schema.string().default('')
    .description('存放 API Key 的环境变量名；本地端点可留空').volatile(),
  embeddingWeight: Schema.number().step(0.05).min(0.05).max(0.95).default(0.5)
    .description('混合检索中向量排序的 RRF 权重（0.05-0.95）').volatile(),
  consolidateMode: Schema.union(['off', 'suggest']).default('suggest')
    .description('写入后是否生成合并/冲突建议；只提议不覆盖，确认后才 supersede').volatile(),
  namespace: Schema.string().default('default')
    .description('本地记忆命名空间；同一 store 内不同 namespace 默认互相不可见').volatile(),
  defaultVisibility: Schema.union(['shared', 'private']).default('shared')
    .description('新记忆默认可见性：shared 同命名空间可读；private 仅写入会话可读写（本地 UI 管理员始终可见）').volatile(),
  singleWriter: Schema.boolean().default(true)
    .description('是否为 store 获取单写者锁；第二个 DSH 进程会降级为只读，避免并发写坏 NDJSON').volatile(),
  decayHalfLifeDays: Schema.number().step(1).min(1).max(3650).default(90)
    .description('检索时间衰减半衰期（天）；0 关闭衰减').volatile(),
  headroomTokens: Schema.number().step(1024).min(0).max(1048576).default(0)
    .description('绝对余量覆盖：>0 时优先于比例；0 表示按 headroomRatio 随模型大小自动计算').volatile(),
  headroomRatio: Schema.number().step(0.0001).min(0).max(1).default(0.0625)
    .description('预算余量占上下文窗口的比例；headroomTokens=0 时生效，用于按模型大小自适应').volatile(),
  storePath: Schema.string().default('')
    .description('自定义 NDJSON 路径；留空使用 DSH_HOME/data/memory-curate/').volatile(),
  auditArchiveBytes: Schema.number().step(1048576).min(1048576).max(1073741824).default(50 * 1024 * 1024)
    .description('审计日志滚动归档阈值（字节）；超过后把最旧审计迁到 <store>.archive/，默认 50 MB').volatile(),
  auditArchiveRollRatio: Schema.number().step(0.05).min(0.1).max(0.9).default(0.4)
    .description('每次滚动归档当前审计字节的比例；默认 40%，主库保留约 60% 热读').volatile()
})

function resolveStorePath (configured) {
  const custom = typeof configured === 'string' ? configured.trim() : ''
  if (custom.length > 0) return isAbsolute(custom) ? custom : resolve(custom)
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'data', 'memory-curate', 'memory-curate.ndjson')
}

/**
 * Runtime overrides written by the settings UI. They sit next to the store and
 * are merged over the loader config, so changing a field in the browser does not
 * require editing cordis.patch.yml by hand. Non-loopback writers cannot reach it.
 */
function configOverridePath (storeFile) {
  return join(dirname(storeFile), 'config-override.json')
}

async function readConfigOverride (storeFile) {
  try {
    const text = await fs.readFile(configOverridePath(storeFile), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sourceSeqsOf (session, protectTurns) {
  const window = computeProtectedWindow(session, protectTurns)
  const humans = window.humans.slice(-3)
  if (humans.length > 0) return humans
  return [Math.max(0, session.seq - 1)]
}

export class CurateService extends Service {
  constructor (ctx, config, store) {
    super(ctx, SERVICE_NAME)
    this.config = config
    this.store = store
    this.readOnly = false
    this.storeError = null
    this.deferCount = new Map()
    this.forceNext = new Set()
    this.anchorCache = new Map()
    this.sectionCache = new Map()
    this.anchorHashes = new Map()
    this.promptState = { generating: false, failures: 0 }
    this.pendingCandidate = new Map()
    this.anchorDirty = new Set()
    this.currentAnchor = undefined
    this.attachedAgents = new WeakSet()
    this.wrappedEngines = new WeakSet()
    this.wrappedPruners = new WeakSet()
    this.approvedCompaction = new WeakSet()
    this.approvedGates = new WeakMap()
    this.overflowBypass = new WeakSet()
    this.expiredAudited = new Set()
    this.consolidating = false
    this.semantic = { embedder: null, lastError: null, lastErrorAt: 0 }
    this.indexCache = new Map()
  }

  get enabled () {
    return this.store !== null && this.store !== undefined
  }

  /** Scope of the calling agent, or the local UI admin when requested. */
  scopeFor (agent, { admin = false } = {}) {
    return callerScope({ agent, namespace: this.config.namespace, admin })
  }

  /** Active rows the caller may read, already filtered by namespace/owner. */
  activeRowsFor (agent, options = {}) {
    return visibleRows(this.activeRows(options), this.scopeFor(agent, options))
  }

  /** Throw a stable error instead of silently widening a write. */
  assertWritable (agent, memoryId, { admin = false } = {}) {
    const existing = this.store.memoryById(memoryId)
    if (existing === null) throw Object.assign(new Error(`memory not found: ${memoryId}`), { code: 'INVALID_ARGUMENT' })
    if (!canWrite(existing, this.scopeFor(agent, { admin }))) {
      throw Object.assign(new Error('memory is not writable by this agent'), { code: 'PERMISSION_DENIED' })
    }
    return existing
  }

  assertWritableRow (agent, row, { admin = false } = {}) {
    if (row === null || row === undefined) throw Object.assign(new Error('memory not found'), { code: 'INVALID_ARGUMENT' })
    if (!canWrite(row, this.scopeFor(agent, { admin }))) {
      throw Object.assign(new Error('memory is not writable by this agent'), { code: 'PERMISSION_DENIED' })
    }
    return row
  }

  promptVersion () {
    return this.store?.activePromptVersion ?? 'builtin-fallback'
  }

  activePromptText () {
    const row = this.store?.activePrompt()
    return row?.text ?? BUILTIN_PROMPT
  }

  /* ---------------------------------------------------------------- storage */

  async save ({ agent, text, tags, triggers, entities, reason, structureReason, supersedes, importance, validFrom, validUntil, visibility }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    if (this.readOnly) throw Object.assign(new Error('memory store is read-only because another process owns the writer lock'), { code: 'STORE_READ_ONLY' })
    const session = agent?.session
    if (session === undefined || session === null) {
      await this.auditSafe('write', { decision: 'refused', reason: 'SOURCE_REQUIRED' })
      throw Object.assign(new Error('memory_curate_save requires a live session (exec.agent is missing)'), { code: 'SOURCE_REQUIRED' })
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw Object.assign(new Error('text must be a non-empty string'), { code: 'INVALID_ARGUMENT' })
    }
    const scope = this.scopeFor(agent)
    const owner = agentSessionId(agent)
    const visibilityValue = normalizeVisibility(visibility, this.config.defaultVisibility)
    const namespace = this.config.namespace
    const candidate = { text: text.trim(), tags: cleanList(tags), triggers: cleanList(triggers), entities: cleanList(entities) }
    const active = this.activeRowsFor(agent)
    if (supersedes === undefined || supersedes === null) {
      const near = duplicates(candidate, active)
      if (near.length > 0) {
        await this.auditSafe('write', {
          decision: 'duplicate-suspected',
          duplicates: near.map(({ id, score }) => ({ id, score: Number(score.toFixed(4)) })),
          sessionId: session.id,
          namespace,
          visibility: visibilityValue,
          actor: actorOf(agent),
          promptVersion: this.promptVersion(),
          reason: reason ?? ''
        })
        return { ok: false, code: 'DUPLICATE_SUSPECTED', duplicates: near.map(({ id, score, text: body }) => ({ id, score: Number(score.toFixed(4)), text: body })) }
      }
    }
    if (typeof supersedes === 'string') {
      const target = this.store.memoryById(supersedes)
      if (target === null) throw Object.assign(new Error(`supersedes target not found: ${supersedes}`), { code: 'INVALID_ARGUMENT' })
      this.assertWritableRow(agent, target)
      if (!canRead(target, scope)) throw Object.assign(new Error('supersedes target is not visible to this agent'), { code: 'PERMISSION_DENIED' })
    }
    const seqs = sourceSeqsOf(session, this.config.protectTurns)
    const row = await this.store.saveMemory({
      ...candidate,
      writeReason: reason ?? '',
      structureReason: structureReason ?? '',
      importance,
      validFrom,
      validUntil,
      namespace,
      owner,
      visibility: visibilityValue,
      sessionId: session.id,
      seqs,
      promptVersion: this.promptVersion(),
      supersedes
    })
    await this.store.audit('write', {
      memoryId: row.id,
      decision: 'written',
      reason: reason ?? '',
      structureReason: structureReason ?? '',
      tags: candidate.tags,
      importance: row.importance,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      namespace,
      owner,
      visibility: visibilityValue,
      actor: actorOf(agent),
      sourceSeqs: seqs,
      sessionId: session.id,
      promptVersion: this.promptVersion(),
      supersedes: supersedes ?? null
    })
    this.markAnchorDirty()
    if (this.config.consolidateMode === 'suggest') {
      void this.proposeConsolidation(row.id, agent).catch((error) => {
        this.ctx.logger?.warn?.(`memory-curate: consolidation proposal failed: ${error?.message ?? error}`)
      })
    }
    return { ok: true, id: row.id, memory: row }
  }

  async delete ({ agent, memoryId, reason }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    if (this.readOnly) throw Object.assign(new Error('memory store is read-only because another process owns the writer lock'), { code: 'STORE_READ_ONLY' })
    const session = agent?.session
    if (session === undefined || session === null) {
      throw Object.assign(new Error('memory_curate_admin delete requires a live session'), { code: 'SOURCE_REQUIRED' })
    }
    const existing = this.assertWritable(agent, memoryId)
    const seqs = sourceSeqsOf(session, this.config.protectTurns)
    const row = await this.store.deleteMemory(memoryId, { reason: reason ?? '', sessionId: session.id, seqs })
    await this.store.audit('delete', {
      targetId: memoryId,
      reason: reason ?? '',
      namespace: existing.namespace ?? this.config.namespace,
      visibility: existing.visibility ?? 'shared',
      actor: actorOf(agent),
      sessionId: session.id,
      sourceSeqs: seqs,
      promptVersion: this.promptVersion()
    })
    this.markAnchorDirty()
    return { ok: true, tombstone: row.id, targetId: memoryId }
  }

  /** Memory rows enriched with derived usage; the only shape recall sees. */
  activeRows ({ includeExpired = false, now = Date.now() } = {}) {
    if (!this.enabled) return []
    const lastUsed = typeof this.store.lastUsedMap === 'function' ? this.store.lastUsedMap() : new Map()
    return this.store.activeMemories({ includeExpired, now }).map((row) => ({
      ...row,
      lastUsedAt: lastUsed.get(row.id) ?? row.lastUsedAt ?? null
    }))
  }

  recall (query, limit, options = {}) {
    if (!this.enabled) return { hits: [], totalHits: 0 }
    const admin = options.admin === true
    const scope = this.scopeFor(options.agent, { admin })
    const memories = options.memories ?? (admin ? this.activeRows({ includeExpired: options.includeExpired === true }) : this.activeRowsFor(options.agent, { includeExpired: options.includeExpired === true }))
    return recall(query, memories, {
      limit,
      includeExpired: options.includeExpired === true,
      index: this.indexFor(memories, admin ? 'admin' : scopeKeyOf(scope)),
      now: Date.now(),
      decayHalfLifeDays: this.config.decayHalfLifeDays,
      ...(options.minScore === undefined ? {} : { minScore: options.minScore })
    })
  }

  /** Reusable inverted index per revision + scope, rebuilt only on change. */
  indexFor (memories, scopeKey = 'admin') {
    const key = `${this.store.revision}|${scopeKey}|${memories.length}|${idsHash(memories)}`
    const cached = this.indexCache.get(key)
    if (cached !== undefined) return cached
    const index = buildIndex(memories)
    this.indexCache.set(key, index)
    if (this.indexCache.size > 16) {
      const oldest = this.indexCache.keys().next().value
      this.indexCache.delete(oldest)
    }
    return index
  }

  embedder () {
    if (this.semantic.embedder !== null) return this.semantic.embedder
    const embedder = createEmbedder({
      baseURL: this.config.embeddingBaseURL,
      model: this.config.embeddingModel,
      apiKeyEnv: this.config.embeddingApiKeyEnv
    })
    this.semantic.embedder = embedder
    return embedder
  }

  hybridEnabled () {
    return this.config.retrievalMode === 'hybrid' && this.embedder().configured
  }

  /** Cosine ranking for one query; throws so the caller can fall back to BM25. */
  async semanticRanking (query, memories) {
    const rows = memories.filter((row) => typeof row?.text === 'string' && row.text.length > 0)
    if (rows.length === 0) return []
    const vectors = await this.embedder().embed([query, ...rows.map((row) => row.text)])
    const queryVector = vectors[0]
    return rows
      .map((row, index) => ({ id: row.id, cosine: cosine(queryVector, vectors[index + 1]) }))
      .filter((entry) => entry.cosine > 0)
      .sort((left, right) => right.cosine - left.cosine)
  }

  /**
   * Recall, optionally fused with the semantic ranking.
   *
   * RRF fuses the BM25 order and the cosine order, so the two signals never
   * need a shared score scale. Any embedding failure degrades to the BM25
   * result and is recorded in the audit row instead of surfacing as an error.
   */
  async recallWithAudit ({ query, limit, agent }) {
    const scope = this.scopeFor(agent)
    const memories = this.activeRowsFor(agent)
    const base = this.recall(query, limit, { agent, memories })
    let semantic = null
    let fallback = null
    if (this.hybridEnabled()) {
      try {
        semantic = await this.semanticRanking(query, memories)
      } catch (error) {
        fallback = error?.message ?? String(error)
        this.semantic.lastError = fallback
        this.semantic.lastErrorAt = Date.now()
      }
    }
    const fused = semantic === null ? base : fuseHits(base, semantic, memories, {
      weight: this.config.embeddingWeight,
      limit
    })
    if (this.enabled) {
      await this.auditSafe('recall', {
        query,
        mode: this.hybridEnabled() ? 'hybrid' : 'bm25',
        fallback,
        namespace: scope.namespace,
        actor: actorOf(agent),
        hits: fused.hits.map((hit) => ({ id: hit.id, score: hit.score, why: hit.why })),
        returned: fused.hits.map((hit) => hit.id),
        totalHits: fused.totalHits,
        sessionId: agent?.session?.id ?? null,
        promptVersion: this.promptVersion()
      })
    }
    return fused
  }

  /** Browsing surface for the settings UI: list or search, never throws. */
  browse ({ query, tags, limit = 50, includeExpired = false, agent = null, admin = false } = {}) {
    if (!this.enabled) return { ok: true, rows: [], total: 0 }
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(200, limit) : 50
    const rows = admin ? this.activeRows({ includeExpired }) : this.activeRowsFor(agent, { includeExpired })
    const tagFilter = cleanList(tags)
    const filtered = tagFilter.length === 0
      ? rows
      : rows.filter((row) => tagFilter.every((tag) => (row.tags ?? []).includes(tag)))
    if (typeof query === 'string' && query.trim().length > 0) {
      const result = this.recall(query, Math.max(size, 10), { memories: filtered, includeExpired, admin, agent })
      const byId = new Map(filtered.map((row) => [row.id, row]))
      const hits = result.hits.map((hit) => toBrowseRow(byId.get(hit.id) ?? { id: hit.id, text: hit.text }))
      return { ok: true, rows: hits, total: result.totalHits }
    }
    const ordered = filtered
      .slice()
      .sort((left, right) => String(right.updatedAt ?? right.ts ?? '').localeCompare(String(left.updatedAt ?? left.ts ?? '')))
    return { ok: true, rows: ordered.slice(0, size).map((row) => toBrowseRow(row)), total: filtered.length }
  }

  /** Append-only edit: the old row stays, the new row cites it through `supersedes`. */
  async updateMemory ({ memoryId, text, tags, triggers, entities, importance, validUntil, reason, agent, admin = false }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    if (this.readOnly) throw Object.assign(new Error('memory store is read-only because another process owns the writer lock'), { code: 'STORE_READ_ONLY' })
    const existing = admin ? this.store.memoryById(memoryId) : this.assertWritable(agent, memoryId)
    if (existing === null) throw Object.assign(new Error(`memory not found: ${memoryId}`), { code: 'INVALID_ARGUMENT' })
    const nextText = typeof text === 'string' && text.trim().length > 0 ? text.trim() : existing.text
    const session = agent?.session
    const seqs = session === undefined || session === null ? [] : sourceSeqsOf(session, this.config.protectTurns)
    const row = await this.store.saveMemory({
      text: nextText,
      tags: tags === undefined ? existing.tags ?? [] : cleanList(tags),
      triggers: triggers === undefined ? existing.triggers ?? [] : cleanList(triggers),
      entities: entities === undefined ? existing.entities ?? [] : cleanList(entities),
      importance: importance === undefined ? existing.importance : importance,
      validUntil: validUntil === undefined ? existing.validUntil : validUntil,
      namespace: existing.namespace ?? this.config.namespace,
      owner: existing.owner ?? agentSessionId(agent),
      visibility: existing.visibility ?? 'shared',
      writeReason: reason ?? 'ui edit',
      structureReason: existing.structureReason ?? '',
      sessionId: session?.id ?? existing.source?.sessionId ?? null,
      seqs,
      promptVersion: this.promptVersion(),
      supersedes: memoryId
    })
    await this.store.audit('update', {
      memoryId: row.id,
      decision: 'written',
      supersedes: memoryId,
      reason: reason ?? 'ui edit',
      namespace: row.namespace,
      visibility: row.visibility,
      actor: admin ? actorOf(null, 'ui') : actorOf(agent),
      sessionId: session?.id ?? null,
      promptVersion: this.promptVersion()
    })
    this.markAnchorDirty()
    return { ok: true, id: row.id }
  }

  /** Tombstone one memory without needing a live agent session (UI path). */
  async deleteById ({ memoryId, reason, admin = false, agent = null }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    if (this.readOnly) throw Object.assign(new Error('memory store is read-only because another process owns the writer lock'), { code: 'STORE_READ_ONLY' })
    const existing = admin ? this.store.memoryById(memoryId) : this.assertWritable(agent, memoryId)
    if (existing === null) throw Object.assign(new Error(`memory not found: ${memoryId}`), { code: 'INVALID_ARGUMENT' })
    const row = await this.store.deleteMemory(memoryId, { reason: reason ?? 'admin delete', sessionId: null, seqs: [] })
    await this.store.audit('delete', {
      targetId: memoryId,
      reason: reason ?? 'admin delete',
      namespace: existing.namespace ?? this.config.namespace,
      visibility: existing.visibility ?? 'shared',
      actor: admin ? actorOf(null, 'ui') : actorOf(agent),
      sessionId: null,
      promptVersion: this.promptVersion()
    })
    this.markAnchorDirty()
    return { ok: true, tombstoneId: row.id, targetId: memoryId }
  }

  /* ----------------------------------------------------- consolidation (item 2) */

  /** Propose merge/conflict pairs touched by the memory just written. */
  async proposeConsolidation (memoryId, agent) {
    if (!this.enabled || this.readOnly || this.consolidating) return { ok: false, reason: 'busy' }
    this.consolidating = true
    try {
      const rows = this.activeRowsFor(agent)
      const pairs = proposePairs(rows, {
        minSimilarity: 0.6,
        limit: 12,
        similarityFn: similarity
      }).filter((pair) => pair.targetIds.includes(memoryId))
      const open = this.store.suggestions('proposed')
      const openKeys = new Set(open.map((row) => pairKey(row.targetIds?.[0], row.targetIds?.[1])))
      const written = []
      for (const pair of pairs) {
        if (openKeys.has(pair.key)) continue
        const left = rows.find((row) => row.id === pair.targetIds[0])
        const right = rows.find((row) => row.id === pair.targetIds[1])
        if (left === undefined || right === undefined) continue
        const row = await this.store.saveSuggestion({
          action: pair.action,
          targetIds: pair.targetIds,
          proposedText: suggestedText(left, right),
          rationale: pair.rationale,
          similarity: pair.similarity,
          namespace: left.namespace ?? this.config.namespace,
          owner: left.owner ?? agentSessionId(agent),
          visibility: left.visibility ?? 'shared',
          source: { sessionId: agent?.session?.id ?? null, triggerMemoryId: memoryId }
        })
        written.push(row.id)
        openKeys.add(pair.key)
        await this.auditSafe('consolidate', {
          decision: 'proposed',
          suggestionId: row.id,
          action: pair.action,
          targetIds: pair.targetIds,
          similarity: pair.similarity,
          namespace: row.namespace,
          actor: actorOf(agent),
          sessionId: agent?.session?.id ?? null,
          promptVersion: this.promptVersion()
        })
      }
      return { ok: true, proposed: written }
    } finally {
      this.consolidating = false
    }
  }

  listSuggestions (status = 'proposed', agent = null, admin = false) {
    if (!this.enabled) return []
    const scope = this.scopeFor(agent, { admin })
    return this.store.suggestions(status).filter((suggestion) => {
      if (admin) return true
      const targets = (suggestion.targetIds ?? []).map((id) => this.store.memoryById(id)).filter((row) => row !== null)
      return targets.length > 0 && targets.every((row) => canRead(row, scope))
    })
  }

  async applySuggestion ({ suggestionId, text, agent, admin = false }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    if (this.readOnly) throw Object.assign(new Error('memory store is read-only because another process owns the writer lock'), { code: 'STORE_READ_ONLY' })
    const suggestion = this.store.suggestionById(suggestionId)
    if (suggestion === null) throw Object.assign(new Error(`suggestion not found: ${suggestionId}`), { code: 'INVALID_ARGUMENT' })
    if (suggestion.status !== 'proposed') throw Object.assign(new Error(`suggestion is ${suggestion.status}`), { code: 'INVALID_ARGUMENT' })
    const targets = (suggestion.targetIds ?? []).filter((id) => typeof id === 'string' && this.store.memoryById(id) !== null)
    if (targets.length === 0) throw Object.assign(new Error('suggestion targets are missing'), { code: 'INVALID_ARGUMENT' })
    for (const id of targets) {
      const row = this.store.memoryById(id)
      if (!admin && !canWrite(row, this.scopeFor(agent))) {
        throw Object.assign(new Error('suggestion targets are not writable by this agent'), { code: 'PERMISSION_DENIED' })
      }
    }
    const preferred = typeof text === 'string' && text.trim().length > 0 ? text.trim() : String(suggestion.proposedText ?? '').trim()
    if (preferred.length === 0) throw Object.assign(new Error('no merged text to write'), { code: 'INVALID_ARGUMENT' })
    const primary = this.store.memoryById(targets[0])
    const importance = Math.max(...targets.map((id) => Number(this.store.memoryById(id)?.importance ?? 3)))
    const session = agent?.session
    const seqs = session === undefined || session === null ? [] : sourceSeqsOf(session, this.config.protectTurns)
    const row = await this.store.saveMemory({
      text: preferred,
      tags: primary?.tags ?? [],
      triggers: primary?.triggers ?? [],
      entities: primary?.entities ?? [],
      importance,
      namespace: primary?.namespace ?? suggestion.namespace ?? this.config.namespace,
      owner: primary?.owner ?? agentSessionId(agent),
      visibility: primary?.visibility ?? suggestion.visibility ?? 'shared',
      writeReason: `consolidation:${suggestion.action}`,
      structureReason: suggestion.rationale ?? '',
      sessionId: session?.id ?? null,
      seqs,
      promptVersion: this.promptVersion(),
      supersedes: targets
    })
    await this.store.markSuggestion(suggestionId, 'applied', { appliedMemoryId: row.id })
    await this.store.audit('consolidate', {
      decision: 'applied',
      suggestionId,
      action: suggestion.action,
      targetIds: targets,
      memoryId: row.id,
      namespace: row.namespace,
      actor: admin ? actorOf(null, 'ui') : actorOf(agent),
      sessionId: session?.id ?? null,
      promptVersion: this.promptVersion()
    })
    this.markAnchorDirty()
    return { ok: true, id: row.id, applied: suggestionId }
  }

  async dismissSuggestion ({ suggestionId, agent, admin = false }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    if (this.readOnly) throw Object.assign(new Error('memory store is read-only because another process owns the writer lock'), { code: 'STORE_READ_ONLY' })
    const suggestion = this.store.suggestionById(suggestionId)
    if (suggestion === null) throw Object.assign(new Error(`suggestion not found: ${suggestionId}`), { code: 'INVALID_ARGUMENT' })
    const targets = (suggestion.targetIds ?? []).map((id) => this.store.memoryById(id)).filter((row) => row !== null)
    if (!admin && targets.some((row) => !canRead(row, this.scopeFor(agent)))) {
      throw Object.assign(new Error('suggestion is not visible to this agent'), { code: 'PERMISSION_DENIED' })
    }
    await this.store.markSuggestion(suggestionId, 'dismissed', { dismissedBy: agent?.session?.id ?? null })
    await this.auditSafe('consolidate', {
      decision: 'dismissed',
      suggestionId,
      targetIds: suggestion.targetIds ?? [],
      namespace: suggestion.namespace ?? this.config.namespace,
      actor: admin ? actorOf(null, 'ui') : actorOf(agent),
      sessionId: agent?.session?.id ?? null,
      promptVersion: this.promptVersion()
    })
    return { ok: true, dismissed: suggestionId }
  }

  /** Record the first observation of an expired assertion; never delete it. */
  async sweepExpired () {
    if (!this.enabled || this.readOnly) return 0
    let expired = []
    try {
      expired = this.store.expiredMemories()
    } catch {
      return 0
    }
    let recorded = 0
    for (const row of expired) {
      if (this.expiredAudited.has(row.id)) continue
      this.expiredAudited.add(row.id)
      const ok = await this.auditSafe('expire', {
        memoryId: row.id,
        decision: 'expired',
        validUntil: row.validUntil,
        reason: 'validUntil passed; archived from active recall',
        promptVersion: this.promptVersion()
      })
      if (ok !== null) recorded++
    }
    return recorded
  }

  trace ({ memoryId, sessionId, seq, agent, admin = false }) {
    if (!this.enabled) return []
    const scope = this.scopeFor(agent, { admin })
    if (typeof memoryId === 'string' && memoryId.length > 0) {
      const row = this.store.memoryById(memoryId)
      if (row === null || !canRead(row, scope)) return []
      return this.store.traceMemory(memoryId)
    }
    if (typeof sessionId === 'string' && Number.isInteger(seq)) {
      if (!admin && sessionId !== agentSessionId(agent)) return []
      return this.store.traceSeq(sessionId, seq)
    }
    return []
  }

  async auditSafe (op, fields) {
    if (!this.enabled || this.readOnly) return null
    try {
      return await this.store.audit(op, fields)
    } catch (error) {
      this.ctx.logger?.warn?.(`memory-curate: audit write failed: ${error?.message ?? error}`)
      return null
    }
  }

  markAnchorDirty () {
    this.anchorCache.clear()
    this.sectionCache.clear()
    this.currentAnchor = undefined
  }

  /* ------------------------------------------------------------------ anchor */

  anchor (agent = null, reason = 'version-changed', { admin = false } = {}) {
    if (!this.enabled) return { text: '', truncated: false, tags: 0, memories: 0 }
    const scope = this.scopeFor(agent, { admin })
    const scopeKey = admin ? 'admin' : scopeKeyOf(scope)
    const cached = this.anchorCache.get(scopeKey)
    if (cached !== undefined && cached.revision === this.store.revision) return cached.anchor
    const rows = admin ? this.store.activeMemories() : this.activeRowsFor(agent)
    const anchor = buildAnchor(rows, {
      detail: this.config.anchorDetail,
      maxChars: ANCHOR_MAX_CHARS
    })
    const hash = simpleHash(anchor.text)
    const changed = this.anchorHashes?.get(scopeKey) !== hash
    this.anchorCache.set(scopeKey, { revision: this.store.revision, anchor })
    if (this.anchorHashes === undefined) this.anchorHashes = new Map()
    this.anchorHashes.set(scopeKey, hash)
    this.currentAnchor = anchor
    if (changed) {
      void this.auditSafe('anchor', {
        reason,
        hash,
        namespace: scope.namespace,
        scope: admin ? 'admin' : 'agent',
        actor: admin ? actorOf(null, 'ui') : actorOf(agent),
        tags: anchor.tags,
        memories: anchor.memories,
        truncated: anchor.truncated,
        promptVersion: this.promptVersion()
      })
    }
    return anchor
  }

  sectionText (agent = null) {
    if (!this.enabled) return ''
    const scope = this.scopeFor(agent)
    const scopeKey = scopeKeyOf(scope)
    const anchor = this.anchor(agent)
    const policy = policyText(this.activePromptText())
    const key = `${scopeKey}|${this.promptVersion()}|${simpleHash(anchor.text)}|${this.config.anchorDetail}`
    const cached = this.sectionCache.get(key)
    if (cached !== undefined) return cached
    const pieces = []
    if (policy.length > 0) pieces.push(policy)
    if (anchor.text.length > 0) pieces.push(anchor.text)
    const text = pieces.join('\n\n')
    this.sectionCache.set(key, text)
    if (this.sectionCache.size > 16) this.sectionCache.delete(this.sectionCache.keys().next().value)
    return text
  }

  /* ------------------------------------------------------------------ prompt */

  async ensurePrompt (agent, signal) {
    if (!this.enabled || this.readOnly) return
    if (this.store.activePrompt() !== null) return
    const failures = this.store.getMeta('promptFailures') ?? 0
    if (failures >= 2) return
    if (this.promptState.generating) return
    this.promptState.generating = true
    try {
      const candidate = await this.generatePrompt(agent, signal)
      const validation = await this.applyCandidate(agent, candidate, 'runtime')
      if (!validation.ok) await this.recordPromptFailure(agent, validation.errors.join('; ') || 'validation rejected')
    } catch (error) {
      await this.recordPromptFailure(agent, error?.message ?? String(error))
    } finally {
      this.promptState.generating = false
    }
  }

  async recordPromptFailure (agent, reason) {
    const next = (this.store.getMeta('promptFailures') ?? 0) + 1
    await this.store.setMeta('promptFailures', next)
    await this.auditSafe('prompt', {
      action: 'generate',
      decision: 'failed',
      attempt: next,
      reason,
      sessionId: agent?.session?.id ?? null
    })
    if (next >= 2) await this.fallbackPrompt(agent, { assertions: { A: false, B: false, C: false }, errors: [reason] })
  }

  async generatePrompt (agent, signal) {
    const target = routedTarget(agent?.session) ?? optionsTarget(agent)
    if (target === null) throw new Error('no provider/model route available for prompt generation')
    const session = agent.session
    const sample = this.sampleText(session)
    const assembler = new BlockAssembler()
    const system = [
      '你在为长期记忆系统设计抽取提示。',
      '阅读对话摘录，产出三段中文提示：what（记什么）、structure（一条记忆如何组织）、tagging（标签与触发词如何选）。',
      '只输出一个完整的 JSON 对象，键为 what / structure / tagging，每段不超过 200 字，三段合计不超过 600 字。',
      'JSON 必须闭合，不要在 JSON 前后写任何解释。',
      '不得复述摘录里的专有名词、文件名、引号内容或 @ 提及；用领域词描述规则。'
    ].join('\n')
    const user = `对话摘录：\n${sample}\n\n只输出 JSON。`
    const stream = this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 2400,
      sessionId: session.id,
      ...(signal === undefined ? {} : { signal })
    })
    for await (const chunk of stream) assembler.push(chunk)
    const blocks = assembler.blocks()
    const textOfType = (type) => blocks.filter((block) => block.type === type).map((block) => block.text).join('')
    let text = textOfType('text').trim()
    if (text.length === 0) {
      // Reasoning models may emit the JSON inside a reasoning block before the
      // visible answer; parse it there rather than failing the whole attempt.
      text = textOfType('reasoning').trim()
    }
    if (text.length === 0) {
      const kinds = blocks.map((block) => block.type).join(',') || 'none'
      const finish = assembler.finish?.kind ?? 'unknown'
      throw new Error(`prompt generation produced no text (blocks=${kinds}, finish=${finish})`)
    }
    let parsed
    try {
      parsed = parsePromptJson(text)
    } catch (error) {
      throw new Error(`${error?.message ?? error} | raw=${text.slice(0, 400)}`)
    }
    const candidate = {
      what: String(parsed.what ?? '').trim(),
      structure: String(parsed.structure ?? '').trim(),
      tagging: String(parsed.tagging ?? '').trim()
    }
    return candidate
  }

  sampleText (session) {
    const parts = []
    for (const seq of [...session.surface.nodes].reverse()) {
      if (parts.length >= 8) break
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      const message = event.data?.message ?? event.data
      const text = textOf(message)
      if (text.length > 0) parts.unshift(text.slice(0, 400))
    }
    return parts.join('\n---\n').slice(0, 2400)
  }

  sourceEntities (session) {
    return extractEntities(this.sampleText(session))
  }

  async nextPromptVersion () {
    const versions = this.store.prompts().map((row) => row.version).filter((version) => /^p\d+$/.test(String(version)))
    const numbers = versions.map((version) => Number(String(version).slice(1)))
    return 'p' + (Math.max(0, ...numbers) + 1)
  }

  async applyCandidate (agent, candidate, generatedBy) {
    const version = await this.nextPromptVersion()
    const previous = this.store.activePromptVersion
    const samples = replaySamples(this.sampleText(agent.session).split('\n').filter(Boolean))
    const validation = validatePrompt(candidate, {
      samples,
      sourceEntities: this.sourceEntities(agent.session)
    })
    await this.store.recordPrompt({
      version,
      status: validation.ok ? 'active' : 'rejected',
      generatedBy,
      text: candidate,
      assertions: validation.assertions,
      errors: validation.errors,
      sessionId: agent?.session?.id ?? null
    })
    await this.auditSafe('prompt', {
      action: 'propose',
      version,
      decision: validation.ok ? 'applied' : 'rejected',
      assertions: validation.assertions,
      errors: validation.errors,
      generatedBy,
      sessionId: agent?.session?.id ?? null,
      promptVersion: version
    })
    if (validation.ok) {
      await this.store.setMeta('promptFailures', 0)
      if (previous !== undefined && previous !== version) await this.retirePrompt(previous, version)
      this.sectionCache.clear()
    }
    return validation
  }

  async retirePrompt (version, byVersion) {
    const row = this.store.getPrompt(version)
    if (row === null) return
    await this.store.recordPrompt({
      version,
      status: 'retired',
      generatedBy: row.generatedBy,
      text: row.text,
      assertions: row.assertions,
      retiredBy: byVersion
    })
  }

  async fallbackPrompt (agent, validation) {
    if (this.store.activePrompt() !== null) return
    await this.store.recordPrompt({
      version: 'builtin-fallback',
      status: 'active',
      generatedBy: 'fallback',
      text: BUILTIN_PROMPT,
      assertions: validation.assertions,
      errors: validation.errors,
      sessionId: agent?.session?.id ?? null
    })
    await this.auditSafe('prompt', {
      action: 'fallback',
      version: 'builtin-fallback',
      decision: 'applied',
      assertions: validation.assertions,
      errors: validation.errors,
      sessionId: agent?.session?.id ?? null,
      promptVersion: 'builtin-fallback'
    })
    this.sectionCache.clear()
  }

  async rollbackPrompt (agent, version) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    const target = this.store.getPrompt(version)
    if (target === null) throw Object.assign(new Error(`prompt version not found: ${version}`), { code: 'INVALID_ARGUMENT' })
    const current = this.store.activePromptVersion
    await this.store.recordPrompt({
      version,
      status: 'active',
      generatedBy: target.generatedBy,
      text: target.text,
      assertions: target.assertions,
      rollbackFrom: current ?? null
    })
    if (current !== undefined && current !== version) await this.retirePrompt(current, version)
    await this.auditSafe('prompt_rollback', {
      from: current ?? null,
      to: version,
      sessionId: agent?.session?.id ?? null,
      promptVersion: version
    })
    this.sectionCache.clear()
    return { ok: true, activePromptVersion: version }
  }

  /* -------------------------------------------------------------- compaction */

  /**
   * Usable message budget for one request.
   *
   * The provider charges the prompt and the completion to the same window, so
   * a model that reserves `maxTokens` for output leaves only
   * `contextWindow - maxTokens` (minus a safety headroom) for messages. Using
   * the raw window as the denominator makes any ratio above
   * `(window - maxTokens) / window` unreachable: compaction then only happens
   * after the provider has already rejected the request.
   */
  async pressureBudget (session, windowOverride) {
    const window = windowOverride ?? await this.resolveWindow(session)
    if (!Number.isFinite(window) || window <= 0) return null
    const reserved = Number(session?.requestHeader?.()?.config?.maxTokens)
    const reserve = Number.isFinite(reserved) && reserved > 0 ? reserved : 0
    const budget = window - reserve - this.resolveHeadroom(window)
    return budget > 0 ? budget : null
  }

  /**
   * Headroom is an absolute reserve by default only when the user pins it.
   * Otherwise it scales with the model's actual context window, so a 100k model
   * does not lose ~65% of its budget to a constant tuned for a 1M model.
   */
  resolveHeadroom (window) {
    const absolute = Number(this.config.headroomTokens)
    if (Number.isFinite(absolute) && absolute > 0) return absolute
    const ratio = Number(this.config.headroomRatio)
    if (Number.isFinite(ratio) && ratio > 0 && Number.isFinite(window) && window > 0) {
      return Math.max(8192, Math.round(window * ratio))
    }
    return 0
  }

  /** UI-facing subset of the effective config (no secrets). */
  configSnapshot () {
    const c = this.config
    return {
      retrievalMode: c.retrievalMode,
      embeddingBaseURL: c.embeddingBaseURL,
      embeddingModel: c.embeddingModel,
      embeddingApiKeyEnv: c.embeddingApiKeyEnv,
      embeddingWeight: c.embeddingWeight,
      headroomRatio: c.headroomRatio,
      headroomTokens: c.headroomTokens,
      headroomFloor: 8192,
      softRatio: c.softRatio,
      hardRatio: c.hardRatio,
      maxDeferSteps: c.maxDeferSteps,
      protectTurns: c.protectTurns
    }
  }

  /**
   * Merge UI edits over the current config, persist them next to the store and
   * apply them live. The embedder is rebuilt so a new endpoint/model takes effect
   * without a restart, and the retrieval index cache is dropped for the same reason.
   */
  async saveConfig (partial) {
    const clean = {}
    for (const key of UI_CONFIG_KEYS) {
      if (partial !== null && typeof partial === 'object' && Object.prototype.hasOwnProperty.call(partial, key)) {
        clean[key] = partial[key]
      }
    }
    const next = resolveConfig(this.config, clean)
    if (typeof this.configPath === 'string' && this.configPath.length > 0) {
      await fs.writeFile(this.configPath, JSON.stringify(clean, null, 2), 'utf8')
    }
    this.config = next
    try { this.semantic.embedder = null } catch {}
    if (this.indexCache instanceof Map) this.indexCache.clear()
    if (this.sectionCache instanceof Map) this.sectionCache.clear()
    if (this.anchorCache instanceof Map) this.anchorCache.clear()
    if (this.anchorHashes instanceof Map) this.anchorHashes.clear()
    await this.auditSafe('config', {
      decision: 'updated',
      fields: Object.keys(clean),
      retrievalMode: next.retrievalMode,
      actor: { kind: 'ui', id: 'settings' },
      promptVersion: this.promptVersion()
    })
    return this.configSnapshot()
  }

  async pressureRatio (session, windowOverride) {
    try {
      // Price the same envelope the host engine will send: passing the request
      // header lets the meter anchor on the last real provider usage instead of
      // re-estimating the whole surface with the 4-chars-per-token heuristic.
      const header = session?.requestHeader?.()
      const measurement = this.ctx.tokenMeter.measure(session, header)
      const budget = await this.pressureBudget(session, windowOverride)
      if (budget === null) return null
      return measurement.totalTokens / budget
    } catch {
      return null
    }
  }

  async resolveWindow (session) {
    const pressure = this.ctx.tokenMeter.contextPressure(session)
    if (Number.isFinite(pressure?.contextWindow) && pressure.contextWindow > 0) return pressure.contextWindow
    const target = routedTarget(session)
    if (target === null) return null
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model)
      const window = info?.context?.contextWindow
      return Number.isFinite(window) && window > 0 ? window : null
    } catch {
      return null
    }
  }

  gateWrite (region, agent = null) {
    if (!this.enabled) return { ok: false, cited: [] }
    const seqSet = new Set(region.seqs)
    const cited = this.activeRowsFor(agent).filter((memory) =>
      (memory.source?.seqs ?? []).some((seq) => seqSet.has(seq)))
    const audits = this.store.auditRows()
    const grounded = cited.filter((memory) => audits.some((row) =>
      row.op === 'write' &&
      row.memoryId === memory.id &&
      typeof row.reason === 'string' &&
      row.reason.length > 0 &&
      Array.isArray(row.sourceSeqs) &&
      row.sourceSeqs.some((seq) => seqSet.has(seq))))
    return { ok: grounded.length > 0, cited: grounded.map((memory) => memory.id) }
  }

  gateRecall (session, region, cited, agent = null) {
    if (cited.length === 0) return { ok: false, hits: [] }
    const query = regionQuery(regionText(session, region.seqs))
    if (query.length === 0) return { ok: false, hits: [] }
    const result = this.recall(query, 10, { agent })
    const hitIds = result.hits.map((hit) => hit.id)
    return { ok: hitIds.some((id) => cited.includes(id)), hits: hitIds, query }
  }

  resolveEngine (agent) {
    const presets = this.ctx.get('agentPresets')
    try {
      const scoped = presets?.serviceFor?.(agent, 'compaction')
      if (scoped && typeof scoped.compactRegion === 'function') return scoped
    } catch {
      // never fall back to the global service table when the scoped lookup fails
      return null
    }
    return null
  }

  async attach (agent) {
    if (!this.enabled || agent === undefined || agent === null) return
    if (this.attachedAgents.has(agent)) return
    this.attachedAgents.add(agent)
    const engine = this.resolveEngine(agent)
    if (engine === null) {
      await this.auditSafe('compact', {
        decision: 'degraded',
        reason: 'no compaction engine in this agent preset; memory tools still active',
        namespace: this.config.namespace,
        actor: actorOf(agent),
        sessionId: agent.session?.id ?? null,
        promptVersion: this.promptVersion()
      })
      return
    }
    if (this.wrappedEngines.has(engine)) return
    this.wrappedEngines.add(engine)
    const service = this
    const originalRegion = engine.compactRegion
    engine.compactRegion = function (start, end, scopedAgent, signal) {
      return service.filteredCompactRegion(this, originalRegion, start, end, scopedAgent, signal)
    }
    if (typeof engine.compactIfNeeded === 'function') {
      const originalIfNeeded = engine.compactIfNeeded
      engine.compactIfNeeded = function (scopedAgent, trigger, signal) {
        return service.filteredCompactIfNeeded(this, originalIfNeeded, scopedAgent, trigger, signal)
      }
    }
    const pruner = this.resolvePruner(agent)
    if (pruner !== null && typeof pruner.pruneSession === 'function' && !this.wrappedPruners.has(pruner)) {
      this.wrappedPruners.add(pruner)
      pruner.pruneSession = function (session) {
        return service.pruneProtected(session, 'engine')
      }
    }
    await this.auditSafe('compact', {
      decision: 'attached',
      reason: 'wrapped preset-scoped compaction engine and tool-result pruner',
      pruner: pruner !== null,
      namespace: this.config.namespace,
      actor: actorOf(agent),
      sessionId: agent.session?.id ?? null,
      promptVersion: this.promptVersion()
    })
  }

  resolvePruner (agent) {
    const presets = this.ctx.get('agentPresets')
    try {
      const scoped = presets?.serviceFor?.(agent, 'toolResultPruner')
      if (scoped && typeof scoped.pruneSession === 'function') return scoped
    } catch {
      return null
    }
    return null
  }

  /**
   * Compaction is host-owned. The plugin never vetoes, defers, or injects a
   * reminder: the host engine applies its own pressure threshold and
   * retained-tail policy, and `filteredCompactRegion` keeps only the corruption
   * guards (protected system head, stale or reversed ranges). Memory capture
   * stays best-effort and non-blocking, so a failed write can never keep the
   * context from being shed. This is the MemGPT / OpenHands / OpenClaw shape:
   * the runtime owns summarization, memory is a sidecar.
   */
  async filteredCompactIfNeeded (engine, original, agent, trigger, signal) {
    return original.call(engine, agent, trigger, signal)
  }

  async filteredCompactRegion (engine, original, start, end, agent, signal) {
    const session = agent?.session
    if (session === undefined || session === null) return original.call(engine, start, end, agent, signal)
    const nodes = [...session.surface.nodes]
    const startIndex = nodes.indexOf(start)
    const endIndex = nodes.indexOf(end)
    if (startIndex < 0 || endIndex < 0) {
      await this.auditSafe('compact', {
        decision: 'refused',
        reason: 'region-not-on-surface',
        recoverable: true,
        region: { start, end },
        sessionId: session.id,
        promptVersion: this.promptVersion()
      })
      return null
    }
    if (endIndex < startIndex) {
      // A stale host range can arrive reversed after a surface node was rewritten
      // (for example a system-head refresh). Delegating it would let the engine
      // commit a summary before the replacement fails, poisoning the log.
      await this.auditSafe('compact', {
        decision: 'refused',
        reason: 'invalid-region-order',
        recoverable: true,
        region: { start, end },
        sessionId: session.id,
        promptVersion: this.promptVersion()
      })
      return null
    }
    if (startIndex === 0 && protectedHeadSeq(session) !== null) {
      // A span from node 0 would shadow the protected system head. The host
      // engine commits `compaction/summary` before the surface replacement, and
      // only the replacement is refused, so a poisoned summary would stay in the
      // log and break every later resume. Fail closed before any summary exists.
      await this.auditSafe('compact', {
        decision: 'refused',
        reason: 'protected-system-head',
        recoverable: true,
        region: { start, end },
        sessionId: session.id,
        promptVersion: this.promptVersion()
      })
      return null
    }
    const region = { start, end, seqs: nodes.slice(startIndex, endIndex + 1) }
    const generation = session.surface.replaceGeneration
    try {
      const result = await original.call(engine, start, end, agent, signal)
      const replaced = session.surface.replaceGeneration > generation
      if (!replaced) {
        await this.auditSafe('compact', {
          decision: 'refused',
          reason: 'engine returned without replacing the surface',
          recoverable: false,
          region: { start, end },
          sessionId: session.id,
          sourceSeqs: region.seqs,
          promptVersion: this.promptVersion()
        })
        return result
      }
      this.anchorDirty.add(session)
      const shadowedSeqs = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs : region.seqs
      await this.auditSafe('compact', {
        decision: 'compressed',
        region: { start, end },
        shadowedSeqs,
        shadowedTokenCount: result?.shadowedTokenCount,
        recoverable: true,
        sessionId: session.id,
        sourceSeqs: shadowedSeqs,
        promptVersion: this.promptVersion()
      })
      this.markAnchorDirty()
      return result
    } catch (error) {
      await this.auditSafe('compact', {
        decision: 'refused',
        gate: 'replace',
        recoverable: false,
        reason: error?.message ?? String(error),
        region: { start, end },
        sessionId: session.id,
        sourceSeqs: region.seqs,
        promptVersion: this.promptVersion()
      })
      throw error
    }
  }

  async defer (session, gate, ratio, region, gates) {
    this.deferCount.set(session, (this.deferCount.get(session) ?? 0) + 1)
    await this.auditSafe('compact', {
      decision: 'defer',
      gate,
      gateState: gates,
      ratio: Number(ratio.toFixed(4)),
      region: { start: region.start, end: region.end },
      deferCount: this.deferCount.get(session),
      namespace: this.config.namespace,
      actor: { kind: 'session', id: session.id },
      sessionId: session.id,
      sourceSeqs: region.seqs,
      promptVersion: this.promptVersion()
    })
  }

  pruneProtected (session, reason = 'manual') {
    if (!this.enabled) return { pruned: [], skipped: [], charsRemoved: 0 }
    if (session === undefined || session === null) return { pruned: [], skipped: [], charsRemoved: 0 }
    const window = computeProtectedWindow(session, this.config.protectTurns)
    const result = foldToolResults({
      session,
      tokenMeter: this.ctx.tokenMeter,
      protectedWindow: window,
      protectToolResults: this.config.protectToolResults === true
    })
    if (result.pruned.length > 0) this.markAnchorDirty()
    void this.auditPrune(session, result, reason)
    return result
  }

  async auditPrune (session, result, reason) {
    for (const item of result.pruned) {
      await this.auditSafe('prune', {
        seq: item.originalSeq,
        replacementSeq: item.replacementSeq,
        charsBefore: item.charsBefore,
        charsAfter: item.charsAfter,
        protected: item.protected,
        skipped: false,
        reason,
        namespace: this.config.namespace,
        actor: { kind: 'session', id: session.id },
        sessionId: session.id,
        sourceSeqs: [item.originalSeq],
        fullTextRef: { sessionId: session.id, seq: item.originalSeq },
        promptVersion: this.promptVersion()
      })
    }
    for (const item of result.skipped) {
      await this.auditSafe('prune', {
        seq: item.seq,
        skipped: true,
        reason: item.reason,
        namespace: this.config.namespace,
        actor: { kind: 'session', id: session.id },
        sessionId: session.id,
        sourceSeqs: [item.seq],
        promptVersion: this.promptVersion()
      })
    }
  }

  async pruneResults (agent, reason = 'manual') {
    if (!this.enabled) return { pruned: [], skipped: [], charsRemoved: 0 }
    const session = agent?.session
    if (session === undefined || session === null) return { pruned: [], skipped: [], charsRemoved: 0 }
    const window = computeProtectedWindow(session, this.config.protectTurns)
    const result = foldToolResults({
      session,
      tokenMeter: this.ctx.tokenMeter,
      protectedWindow: window,
      protectToolResults: this.config.protectToolResults === true
    })
    await this.auditPrune(session, result, reason)
    if (result.pruned.length > 0) this.markAnchorDirty()
    return result
  }

  /* -------------------------------------------------------------- per-step */

  async beforeStep (agent, signal) {
    if (!this.enabled) return
    await this.attach(agent)
    try {
      if (typeof this.store.maybeArchive === 'function') await this.store.maybeArchive()
    } catch (error) {
      this.ctx.logger?.warn?.(`memory-curate: audit archive failed: ${error?.message ?? error}`)
    }
    await this.ensurePrompt(agent, signal)
    const session = agent?.session
    if (session !== undefined) {
      const reason = this.anchorDirty.has(session) ? 'post-compaction' : 'version-changed'
      this.anchorDirty.delete(session)
      this.anchor(agent, reason)
    }
    void this.sweepExpired()
    await this.maybeRemind(agent)
  }

  onTurnStopping (agent) {
    if (!this.enabled || agent?.session === undefined) return
    const text = recentHumanText(agent.session, this.config.protectTurns, 2000)
    if (!looksLikeMemoryCandidate(text)) return
    this.pendingCandidate.set(agent.session, text)
    void this.auditSafe('candidate', {
      decision: 'not-written',
      reason: 'C1 pattern detected; model must decide, no memory row written here',
      excerpt: text.slice(0, 160),
      sessionId: agent.session.id,
      promptVersion: this.promptVersion()
    })
  }

  async maybeRemind (agent) {
    if (this.config.captureMode !== 'auto-remind') return
    const session = agent?.session
    if (session === undefined) return
    const pending = this.pendingCandidate.get(session)
    if (pending === undefined) return
    this.pendingCandidate.delete(session)
    const text = '刚才的对话似乎包含一条以后仍然适用的约定；如需长期保留，调用 memory_curate_save 记录，无需打断当前任务。'
    try {
      agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'memory-curate' } }))
      await this.auditSafe('remind', {
        decision: 'injected',
        chars: text.length,
        sessionId: session.id,
        promptVersion: this.promptVersion()
      })
    } catch (error) {
      await this.auditSafe('remind', {
        decision: 'failed',
        reason: error?.message ?? String(error),
        sessionId: session.id,
        promptVersion: this.promptVersion()
      })
    }
  }

  /* ------------------------------------------------------------------ admin */

  async admin ({ action, version, memoryId, suggestionId, text, status, auditId, reason, agent }) {
    if (!this.enabled) throw Object.assign(new Error('memory store unavailable'), { code: 'STORE_UNAVAILABLE' })
    switch (action) {
      case 'stats':
        return {
          ok: true,
          readOnly: this.readOnly,
          scope: this.scopeFor(agent),
          visible: this.activeRowsFor(agent).length,
          stats: this.store.stats()
        }
      case 'prompt_show': {
        const row = version === undefined ? this.store.activePrompt() : this.store.getPrompt(version)
        return { ok: true, prompt: row, activePromptVersion: this.store.activePromptVersion ?? null }
      }
      case 'prompt_regenerate': {
        if (this.readOnly) throw Object.assign(new Error('memory store is read-only'), { code: 'STORE_READ_ONLY' })
        const candidate = await this.generatePrompt(agent, undefined)
        const validation = await this.applyCandidate(agent, candidate, 'runtime')
        if (!validation.ok && this.store.activePrompt() === null) await this.fallbackPrompt(agent, validation)
        return { ok: validation.ok, assertions: validation.assertions, errors: validation.errors, activePromptVersion: this.store.activePromptVersion ?? null }
      }
      case 'prompt_rollback':
        if (this.readOnly) throw Object.assign(new Error('memory store is read-only'), { code: 'STORE_READ_ONLY' })
        if (typeof version !== 'string') throw Object.assign(new Error('version is required'), { code: 'INVALID_ARGUMENT' })
        return this.rollbackPrompt(agent, version)
      case 'delete':
        if (typeof memoryId !== 'string') throw Object.assign(new Error('memoryId is required'), { code: 'INVALID_ARGUMENT' })
        return this.delete({ agent, memoryId, reason: 'admin delete' })
      case 'suggestions':
        return { ok: true, suggestions: this.listSuggestions(typeof status === 'string' ? status : 'proposed', agent) }
      case 'apply_suggestion':
        if (typeof suggestionId !== 'string') throw Object.assign(new Error('suggestionId is required'), { code: 'INVALID_ARGUMENT' })
        return this.applySuggestion({ suggestionId, text, agent })
      case 'dismiss_suggestion':
        if (typeof suggestionId !== 'string') throw Object.assign(new Error('suggestionId is required'), { code: 'INVALID_ARGUMENT' })
        return this.dismissSuggestion({ suggestionId, agent })
      case 'retain_audit':
        if (this.readOnly) throw Object.assign(new Error('memory store is read-only'), { code: 'STORE_READ_ONLY' })
        if (typeof auditId !== 'string') throw Object.assign(new Error('auditId is required'), { code: 'INVALID_ARGUMENT' })
        return { ok: true, audit: await this.store.retainAudit(auditId, { reason: reason ?? 'admin retain', actor: actorOf(agent) }) }
      case 'archive':
        if (this.readOnly) throw Object.assign(new Error('memory store is read-only'), { code: 'STORE_READ_ONLY' })
        return this.store.maybeArchive({ force: true })
      default:
        throw Object.assign(new Error(`unknown admin action: ${action}`), { code: 'INVALID_ARGUMENT' })
    }
  }
}

function optionsTarget (agent) {
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model }
  }
  return null
}

/** One row in the shape the settings UI and admin listings consume. */
function toBrowseRow (row) {
  return {
    id: row.id,
    text: row.text ?? '',
    tags: row.tags ?? [],
    triggers: row.triggers ?? [],
    entities: row.entities ?? [],
    importance: row.importance ?? 3,
    validFrom: row.validFrom ?? row.createdAt ?? null,
    validUntil: row.validUntil ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt ?? row.ts ?? null,
    updatedAt: row.updatedAt ?? row.ts ?? null,
    status: row.status ?? 'active',
    namespace: row.namespace ?? 'default',
    owner: row.owner ?? null,
    visibility: row.visibility ?? 'shared',
    source: { sessionId: row.source?.sessionId ?? null, seqs: row.source?.seqs ?? [] }
  }
}

/**
 * Fuse the BM25 hit order with the cosine order through RRF.
 *
 * Semantic-only hits are materialized from the memory rows so a paraphrase
 * match can surface even when no shared term exists. `totalHits` reports the
 * union the fusion considered rather than the BM25-only count.
 */
function fuseHits (base, semantic, memories, options = {}) {
  const weight = Number.isFinite(options.weight) ? options.weight : 0.5
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : undefined
  const byId = new Map()
  for (const hit of base?.hits ?? []) byId.set(hit.id, { ...hit, why: { ...(hit.why ?? {}) } })
  const memoryById = new Map((memories ?? []).map((row) => [row.id, row]))
  for (const entry of semantic ?? []) {
    if (byId.has(entry.id)) continue
    const row = memoryById.get(entry.id)
    if (row === undefined) continue
    byId.set(entry.id, {
      id: row.id,
      text: row.text,
      tags: row.tags ?? [],
      triggers: row.triggers ?? [],
      importance: row.importance ?? 3,
      status: row.status ?? 'active',
      validUntil: row.validUntil ?? null,
      lastUsedAt: row.lastUsedAt ?? null,
      score: 0,
      why: { tags: [], triggers: [], bm25: 0, terms: [] }
    })
  }
  const bm25Ids = (base?.hits ?? []).map((hit) => hit.id)
  const semanticIds = (semantic ?? []).map((entry) => entry.id)
  const fused = rrfFuse([
    { ids: bm25Ids, weight: 1 - weight },
    { ids: semanticIds, weight }
  ])
  const bm25Rank = new Map(bm25Ids.map((id, index) => [id, index + 1]))
  const semanticRank = new Map(semanticIds.map((id, index) => [id, index + 1]))
  const cosineById = new Map((semantic ?? []).map((entry) => [entry.id, entry.cosine]))
  const hits = [...byId.values()]
    .map((hit) => {
      const score = fused.get(hit.id) ?? 0
      return {
        ...hit,
        score: Number(score.toFixed(6)),
        why: {
          ...hit.why,
          rrf: Number(score.toFixed(6)),
          bm25Rank: bm25Rank.get(hit.id) ?? null,
          semanticRank: semanticRank.get(hit.id) ?? null,
          cosine: cosineById.has(hit.id) ? Number(cosineById.get(hit.id).toFixed(6)) : null
        }
      }
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return String(left.id).localeCompare(String(right.id))
    })
  return {
    hits: limit === undefined ? hits : hits.slice(0, limit),
    totalHits: Math.max(base?.totalHits ?? 0, byId.size)
  }
}

function cleanList (value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function textOf (message) {
  const blocks = message?.content ?? []
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

function simpleHash (text) {
  let hash = 2166136261
  for (const char of text) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/** Cheap identity of a filtered memory set, so cached indexes cannot collide. */
function idsHash (memories) {
  let hash = 2166136261
  for (const memory of memories) {
    for (const char of String(memory?.id ?? '')) {
      hash ^= char.codePointAt(0)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0x2c
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/* -------------------------------------------------------------------- entry */

export async function apply (ctx, config = {}) {
  const initial = resolveConfig(config)
  const storeFile = resolveStorePath(initial.storePath)
  const override = await readConfigOverride(storeFile)
  const resolved = override === null ? initial : resolveConfig(config, override)
  let store = null
  let storeError = null
  let lock = null
  if (resolved.singleWriter) {
    lock = await acquireStoreLock(storeFile, { logger: ctx.logger })
    if (!lock.ok) {
      ctx.logger?.warn?.(`memory-curate: store is locked by another process (${lock.owner?.pid ?? 'unknown'}); running read-only`)
    }
  }
  try {
    store = await MemoryStore.open(storeFile, {
      logger: ctx.logger,
      readOnly: lock !== null && !lock.ok,
      archiveBytes: resolved.auditArchiveBytes,
      archiveRollRatio: resolved.auditArchiveRollRatio
    })
  } catch (error) {
    storeError = error
    ctx.logger?.warn?.(`memory-curate: store unavailable at ${storeFile}: ${error?.message ?? error}`)
    if (lock?.ok) await lock.release()
  }

  if (ctx.get(SERVICE_NAME) !== undefined) {
    ctx.logger?.warn?.('memory-curate: another instance already provides memoryCurate; skipping registration')
    if (lock?.ok) await lock.release()
    return
  }

  const service = new CurateService(ctx, resolved, store)
  service.configPath = configOverridePath(storeFile)
  service.storeError = storeError
  service.readOnly = lock !== null && !lock.ok
  if (lock?.ok) {
    ctx.effect(() => () => {
      void lock.release()
    })
  }

  if (store === null) {
    try {
      await service.auditSafe('store_unavailable', { reason: storeError?.message ?? 'unknown' })
    } catch {
      // No store means nowhere to persist this diagnosis.
    }
  }

  ctx.systemPrompt.section({
    name: 'memory-curate',
    order: SECTION_ORDER,
    text: (context) => service.sectionText(context?.agent)
  })

  // Browser half: the settings panel talks to these routes. A failure here must
  // never affect the tools, recall or the compaction wrapper.
  const memoryRoutes = registerMemoryRoutes(ctx, service)
  if (!memoryRoutes.ok) {
    ctx.logger?.warn?.(`memory-curate: memory browser routes unavailable: ${memoryRoutes.error}`)
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal?.aborted !== true) {
      try {
        await service.beforeStep(agent, signal)
      } catch (error) {
        ctx.logger?.warn?.(`memory-curate: pre-step failed: ${error?.message ?? error}`)
      }
    }
    return next()
  }, { prepend: true })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (signal?.aborted !== true) {
      try {
        await service.onTurnStopping(agent, signal)
      } catch (error) {
        ctx.logger?.warn?.(`memory-curate: candidate scan failed: ${error?.message ?? error}`)
      }
    }
  })

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await service.attach(agent)
    } catch (error) {
      ctx.logger?.warn?.(`memory-curate: attach failed: ${error?.message ?? error}`)
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'compaction/summary') service.anchorDirty.add(session)
  })

  await registerTools(ctx, service)
}

function configValue (value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const read = value.get()
    return read === undefined ? fallback : read
  }
  return value === undefined ? fallback : value
}

function flattenConfig (config) {
  if (config !== null && typeof config === 'object' && typeof config.get === 'function') {
    const read = config.get()
    return read !== null && typeof read === 'object' && !Array.isArray(read) ? read : {}
  }
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
}

export function resolveConfig (config, override = {}) {
  const base = flattenConfig(config)
  const extra = override !== null && typeof override === 'object' && !Array.isArray(override) ? override : {}
  const value = { ...base, ...extra }
  const softRatio = Number(configValue(value.softRatio, 0.80))
  const hardRatio = Number(configValue(value.hardRatio, 0.92))
  if (!(softRatio > 0 && softRatio < 1) || !(hardRatio > 0 && hardRatio <= 1)) {
    throw new Error('memory-curate: softRatio/hardRatio must be within (0,1]')
  }
  if (softRatio >= hardRatio) {
    throw new Error(`memory-curate: softRatio (${softRatio}) must be lower than hardRatio (${hardRatio})`)
  }
  return {
    protectTurns: clampInt(configValue(value.protectTurns, 5), 5, 1, 20),
    protectToolResults: configValue(value.protectToolResults, true) !== false,
    softRatio,
    hardRatio,
    maxDeferSteps: clampInt(configValue(value.maxDeferSteps, 3), 3, 1, 50),
    captureMode: configValue(value.captureMode, 'tool-only') === 'auto-remind' ? 'auto-remind' : 'tool-only',
    anchorDetail: ['精简', '标准', '详细'].includes(configValue(value.anchorDetail, '标准')) ? configValue(value.anchorDetail, '标准') : '标准',
    retrievalMode: resolveRetrievalMode(value),
    embedding: configValue(value.embedding, 'off') === 'auto' ? 'auto' : 'off',
    embeddingBaseURL: stringValue(configValue(value.embeddingBaseURL, '')),
    embeddingModel: stringValue(configValue(value.embeddingModel, '')),
    embeddingApiKeyEnv: stringValue(configValue(value.embeddingApiKeyEnv, '')),
    embeddingWeight: clampFloat(configValue(value.embeddingWeight, 0.5), 0.5, 0.05, 0.95),
    consolidateMode: configValue(value.consolidateMode, 'suggest') === 'off' ? 'off' : 'suggest',
    namespace: normalizeNamespace(configValue(value.namespace, 'default')),
    defaultVisibility: normalizeVisibility(configValue(value.defaultVisibility, 'shared'), 'shared'),
    singleWriter: configValue(value.singleWriter, true) !== false,
    decayHalfLifeDays: clampInt(configValue(value.decayHalfLifeDays, 90), 90, 0, 3650),
    headroomTokens: clampInt(configValue(value.headroomTokens, 0), 0, 0, 1048576),
    headroomRatio: clampFloat(configValue(value.headroomRatio, 0.0625), 0.0625, 0, 1),
    storePath: typeof configValue(value.storePath, '') === 'string' ? configValue(value.storePath, '') : ''
  }
}

function resolveRetrievalMode (config) {
  const explicit = configValue(config.retrievalMode, undefined)
  if (explicit === 'bm25' || explicit === 'hybrid') return explicit
  return configValue(config.embedding, 'off') === 'auto' ? 'hybrid' : 'bm25'
}

function stringValue (value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampFloat (value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function clampInt (value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

async function registerTools (ctx, service) {
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    ctx.logger?.warn?.(`memory-curate: dsh-tools unavailable, tools not registered: ${error?.message ?? error}`)
    return
  }
  if (ctx.tools?.register === undefined) return

  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const output = { schema: { type: 'object', additionalProperties: true }, render }

  ctx.tools.register(defineTool({
    name: 'memory_curate_save',
    description: 'Save one durable long-term memory: a preference, convention, decision or project fact that stays true beyond this conversation. Use it when the user states "from now on", "remember", a default, or a settled decision. Provide a standalone sentence, 1-4 short tags, and future trigger words. Pass supersedes to replace an outdated memory; pass validUntil for a time-bound assertion and importance 1-5 when it matters more or less than ordinary conventions. visibility=shared (default) is readable by other agents in the namespace; private is readable only by this session; open also lets other agents update it. Returns the new memory id.',
    parameters: {
      text: { type: 'string', description: 'One standalone sentence: object, condition and conclusion.' },
      tags: { type: 'array', items: { type: 'string' }, description: '1-4 short domain tags.' },
      triggers: { type: 'array', items: { type: 'string' }, description: 'Words the user may say in a future session.' },
      entities: { type: 'array', items: { type: 'string' }, description: 'Files, tools, identifiers named by the user.' },
      reason: { type: 'string', description: 'Why this is worth remembering now (audit trail).' },
      structureReason: { type: 'string', description: 'Why this structure/tagging was chosen.' },
      supersedes: { type: 'string', description: 'Id of the outdated memory this row replaces.' },
      importance: { type: 'integer', description: '1-5; 5 = must-follow constraint, 3 = ordinary convention (default).' },
      validUntil: { type: 'string', description: 'ISO time after which the memory stops being recalled as active (archived, not deleted).' },
      visibility: { type: 'string', enum: ['shared', 'private', 'open'], description: 'shared: other agents can read; private: only this session; open: other agents can also edit. Defaults to the configured policy.' }
    },
    output,
    async execute (args, exec) {
      try {
        return await service.save({ agent: exec?.agent, ...args })
      } catch (error) {
        return { ok: false, code: error?.code ?? 'SAVE_FAILED', message: error?.message ?? String(error) }
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'memory_curate_recall',
    description: 'Recall long-term memories relevant to a query. Search uses tags, trigger words and BM25 over the single NDJSON store; each hit returns why it matched. Call this before relying on an earlier convention, and after a compaction checkpoint when unsure what was remembered.',
    parameters: {
      query: { type: 'string', description: 'What you are trying to remember, in the user\'s words.' },
      limit: { type: 'integer', description: 'Maximum hits (1-20).' }
    },
    output,
    async execute (args, exec) {
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'query must be a non-empty string' }
      }
      const result = await service.recallWithAudit({
        query: args.query,
        limit: Number.isInteger(args.limit) ? Math.min(20, Math.max(1, args.limit)) : 10,
        agent: exec?.agent
      })
      return { ok: true, query: args.query, hits: result.hits, totalHits: result.totalHits }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'memory_curate_trace',
    description: 'Audit trail lookup. With memoryId: the memory row, its write/update/delete audits and every recall that hit it. With sessionId+seq: the prune/compaction audits and memories citing that surface position. Use it to explain why a memory exists, why it was recalled, or what was compacted.',
    parameters: {
      memoryId: { type: 'string', description: 'Memory id (m_...).' },
      sessionId: { type: 'string', description: 'Session id for a surface-position lookup.' },
      seq: { type: 'integer', description: 'Surface seq to trace together with sessionId.' }
    },
    output,
    async execute (args, exec) {
      const rows = service.trace({ memoryId: args.memoryId, sessionId: args.sessionId, seq: args.seq, agent: exec?.agent })
      return { ok: true, count: rows.length, rows }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'memory_curate_admin',
    description: 'Operate the memory store: stats, show/regenerate/roll back the self-generated prompt, delete a memory (append-only tombstone), review consolidation proposals (suggestions), mark one audit row as permanently retained, or force an audit archive roll. apply_suggestion merges overlapping or contradictory rows by appending a superseding memory; dismiss_suggestion closes one without writing.',
    parameters: {
      action: { type: 'string', description: 'stats | prompt_show | prompt_regenerate | prompt_rollback | delete | suggestions | apply_suggestion | dismiss_suggestion | retain_audit | archive' },
      version: { type: 'string', description: 'Prompt version for prompt_show/prompt_rollback.' },
      memoryId: { type: 'string', description: 'Memory id for delete.' },
      suggestionId: { type: 'string', description: 'Suggestion id for apply_suggestion/dismiss_suggestion.' },
      text: { type: 'string', description: 'Optional merged text for apply_suggestion; omit to use the stored proposal.' },
      status: { type: 'string', description: 'Suggestion filter: proposed (default), applied, dismissed, all.' },
      auditId: { type: 'string', description: 'Audit row id for retain_audit.' },
      reason: { type: 'string', description: 'Reason for retain_audit.' }
    },
    output,
    async execute (args, exec) {
      try {
        return await service.admin({
          action: args.action,
          version: args.version,
          memoryId: args.memoryId,
          suggestionId: args.suggestionId,
          text: args.text,
          status: args.status,
          auditId: args.auditId,
          reason: args.reason,
          agent: exec?.agent
        })
      } catch (error) {
        return { ok: false, code: error?.code ?? 'ADMIN_FAILED', message: error?.message ?? String(error) }
      }
    }
  }))
}

export default { name, inject, Config, apply }
