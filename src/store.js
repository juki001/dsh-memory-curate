import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeNamespace, normalizeVisibility } from './scope.js'

/**
 * Append-only NDJSON store for memories, tombstones, prompts, audits and meta.
 *
 * One line per record. Nothing is ever rewritten in place: updates append a new
 * memory row citing `supersedes`, deletions append a tombstone. The in-memory
 * index is derived from the file on every process start, so a crash mid-write
 * can at worst lose the tail line, never corrupt earlier records.
 */
export class MemoryStore {
  #filePath
  #queue = Promise.resolve()
  #rows = []
  #memories = new Map()
  #superseded = new Set()
  #tombstones = new Set()
  #prompts = new Map()
  #suggestions = new Map()
  #meta = new Map()
  #activePromptVersion
  #revision = 0
  #now
  #logger
  #lastUsed = new Map()
  #lastUsedRows = -1
  #readOnly = false

  constructor(filePath, options = {}) {
    this.#filePath = filePath
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#logger = options.logger
    this.#readOnly = options.readOnly === true
  }

  get filePath () { return this.#filePath }
  get revision () { return this.#revision }
  get activePromptVersion () { return this.#activePromptVersion }

  /** Open (creating the header line when absent) and replay the file. */
  static async open (filePath, options = {}) {
    const store = new MemoryStore(filePath, options)
    await store.load()
    return store
  }

  async load () {
    let raw
    try {
      raw = await fs.readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await fs.mkdir(dirname(this.#filePath), { recursive: true })
      const header = { kind: 'header', v: 1, createdAt: this.#now(), plugin: 'dsh-memory-curate' }
      if (this.#readOnly) {
        this.#rows.push(header)
        return
      }
      await fs.writeFile(this.#filePath, JSON.stringify(header) + '\n', 'utf8')
      this.#rows.push(header)
      return
    }
    const lines = raw.split('\n')
    const corrupt = []
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line.trim().length === 0) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        corrupt.push(index + 1)
        continue
      }
      if (row === null || typeof row !== 'object' || typeof row.kind !== 'string') {
        corrupt.push(index + 1)
        continue
      }
      this.#index(row)
    }
    if (corrupt.length > 0 && this.#readOnly) {
      this.#logger?.warn?.(`memory store: ${corrupt.length} corrupt line(s) skipped in read-only mode`)
      return
    }
    for (const line of corrupt) {
      await this.#append({
        kind: 'audit',
        id: 'a_' + randomUUID(),
        ts: this.#now(),
        op: 'store_corrupt',
        reason: `unparseable NDJSON line ${line}`,
        line
      })
    }
  }

  #index (row) {
    this.#rows.push(row)
    switch (row.kind) {
      case 'memory':
        if (typeof row.id === 'string' && row.text !== undefined) {
          this.#memories.set(row.id, row)
          if (typeof row.supersedes === 'string') this.#superseded.add(row.supersedes)
          else if (Array.isArray(row.supersedes)) {
            for (const target of row.supersedes) if (typeof target === 'string') this.#superseded.add(target)
          }
          this.#revision++
        }
        break
      case 'memory_tombstone':
        if (typeof row.targetId === 'string') this.#tombstones.add(row.targetId)
        this.#revision++
        break
      case 'prompt':
        if (typeof row.version === 'string') {
          this.#prompts.set(row.version, row)
          if (row.status === 'active') this.#activePromptVersion = row.version
        }
        break
      case 'suggestion':
        if (typeof row.id === 'string') this.#suggestions.set(row.id, row)
        break
      case 'meta':
        if (typeof row.key === 'string') this.#meta.set(row.key, row.value)
        break
      default:
        break
    }
  }

  /** Serialize one append behind every earlier append. */
  async #append (row) {
    if (this.#readOnly) {
      const error = new Error('memory store is read-only')
      error.code = 'STORE_READ_ONLY'
      throw error
    }
    const run = this.#queue.then(async () => {
      await fs.mkdir(dirname(this.#filePath), { recursive: true })
      await fs.appendFile(this.#filePath, JSON.stringify(row) + '\n', 'utf8')
      this.#index(row)
      return row
    })
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  #insertIndex (row) {
    this.#index(row)
  }

  static #writeFailure (error) {
    const failure = new Error(`memory store write failed: ${error?.message ?? String(error)}`)
    failure.code = 'STORE_WRITE_FAILED'
    failure.cause = error
    return failure
  }

  async saveMemory (input) {
    const ts = this.#now()
    const supersedes = normalizeSupersedes(input.supersedes)
    const row = {
      kind: 'memory',
      id: 'm_' + randomUUID(),
      ts,
      createdAt: ts,
      updatedAt: ts,
      op: supersedes.length > 0 ? 'update' : 'create',
      text: input.text,
      tags: input.tags ?? [],
      triggers: input.triggers ?? [],
      entities: input.entities ?? [],
      structureReason: input.structureReason ?? '',
      writeReason: input.writeReason ?? '',
      importance: clampImportance(input.importance),
      validFrom: normalizeTime(input.validFrom) ?? ts,
      validUntil: normalizeTime(input.validUntil),
      lastUsedAt: normalizeTime(input.lastUsedAt),
      namespace: normalizeNamespace(input.namespace),
      owner: typeof input.owner === 'string' && input.owner.length > 0 ? input.owner : null,
      visibility: normalizeVisibility(input.visibility),
      source: { sessionId: input.sessionId ?? null, seqs: [...(input.seqs ?? [])] },
      promptVersion: input.promptVersion ?? 'builtin-fallback',
      schemaVersion: 3,
      status: 'active',
      ...(supersedes.length === 1 ? { supersedes: supersedes[0] } : {}),
      ...(supersedes.length > 1 ? { supersedes } : {})
    }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }

  async deleteMemory (targetId, input = {}) {
    const row = {
      kind: 'memory_tombstone',
      id: 't_' + randomUUID(),
      ts: this.#now(),
      op: 'delete',
      targetId,
      reason: input.reason ?? '',
      source: { sessionId: input.sessionId ?? null, seqs: [...(input.seqs ?? [])] },
      promptVersion: input.promptVersion ?? this.#activePromptVersion ?? 'builtin-fallback'
    }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }

  async audit (op, fields = {}) {
    const row = {
      kind: 'audit',
      id: 'a_' + randomUUID(),
      ts: this.#now(),
      op,
      ...fields
    }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }

  async recordPrompt (prompt) {
    const row = { kind: 'prompt', ts: this.#now(), ...prompt }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }

  async setMeta (key, value, fields = {}) {
    const row = { kind: 'meta', ts: this.#now(), key, value, ...fields }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }

  getMeta (key) {
    return this.#meta.get(key)
  }

  getPrompt (version) {
    return this.#prompts.get(version) ?? null
  }

  getPromptRow (version) {
    return this.#prompts.get(version) ?? null
  }

  activePrompt () {
    return this.#activePromptVersion === undefined ? null : this.#prompts.get(this.#activePromptVersion) ?? null
  }

  prompts () {
    return [...this.#prompts.values()]
  }

  memoryById (id) {
    return this.#memories.get(id) ?? null
  }

  statusOf (id, nowMs = Date.now()) {
    if (this.#tombstones.has(id)) return 'deleted'
    if (this.#superseded.has(id)) return 'superseded'
    const row = this.#memories.get(id)
    if (row === undefined) return 'missing'
    const until = Date.parse(row.validUntil ?? '')
    if (Number.isFinite(until) && until <= nowMs) return 'expired'
    return 'active'
  }

  /** Active memories in append order, with derived status attached.
   * Expired assertions are excluded unless `includeExpired` is set; the caller
   * decides when a status sweep is cheap enough to run. */
  activeMemories (options = {}) {
    const nowMs = options.now ?? Date.now()
    const includeExpired = options.includeExpired === true
    const out = []
    for (const row of this.#memories.values()) {
      const status = this.statusOf(row.id, nowMs)
      if (status === 'active') out.push({ ...row, status })
      else if (includeExpired && status === 'expired') out.push({ ...row, status })
    }
    return out
  }

  /** Rows whose validUntil has passed; used for the one-time expiry audit. */
  expiredMemories (nowMs = Date.now()) {
    const out = []
    for (const row of this.#memories.values()) {
      if (this.statusOf(row.id, nowMs) === 'expired') out.push({ ...row, status: 'expired' })
    }
    return out
  }

  /** Last time each memory surfaced in a recall, derived from the recall audit
   * trail itself so usage needs no extra rows. */
  lastUsedMap () {
    if (this.#lastUsedRows === this.#rows.length) return this.#lastUsed
    const map = new Map()
    for (const row of this.#rows) {
      if (row.kind !== 'audit' || row.op !== 'recall') continue
      const ids = Array.isArray(row.returned)
        ? row.returned
        : Array.isArray(row.hits) ? row.hits.map((hit) => hit?.id) : []
      for (const id of ids) if (typeof id === 'string') map.set(id, row.ts)
    }
    this.#lastUsed = map
    this.#lastUsedRows = this.#rows.length
    return map
  }

  allRows () {
    return [...this.#rows]
  }

  auditRows () {
    return this.#rows.filter((row) => row.kind === 'audit')
  }

  /** Chronological record for one memory id: row, its audits, and recall hits. */
  traceMemory (memoryId) {
    return this.#rows.filter((row) => {
      if (row.kind === 'memory' && (row.id === memoryId || row.supersedes === memoryId)) return true
      if (row.kind === 'memory_tombstone' && row.targetId === memoryId) return true
      if (row.kind === 'audit') {
        if (row.memoryId === memoryId || row.targetId === memoryId) return true
        if (Array.isArray(row.hits) && row.hits.some((hit) => hit?.id === memoryId)) return true
      }
      return false
    })
  }

  /** Chronological record for one session seq: prune/compact audits and citing memories. */
  traceSeq (sessionId, seq) {
    return this.#rows.filter((row) => {
      const source = row.source
      if (row.kind === 'memory' && source?.sessionId === sessionId && Array.isArray(source.seqs) && source.seqs.includes(seq)) return true
      if (row.kind === 'audit' && row.sessionId === sessionId) {
        if (Array.isArray(row.sourceSeqs) && row.sourceSeqs.includes(seq)) return true
        if (Array.isArray(row.shadowedSeqs) && row.shadowedSeqs.includes(seq)) return true
        if (row.seq === seq) return true
      }
      return false
    })
  }

  stats () {
    return {
      file: this.#filePath,
      rows: this.#rows.length,
      active: this.activeMemories().length,
      expired: this.expiredMemories().length,
      tombstones: this.#tombstones.size,
      prompts: this.#prompts.size,
      suggestions: this.suggestions('proposed').length,
      activePromptVersion: this.#activePromptVersion ?? null,
      revision: this.#revision
    }
  }

  /* ------------------------------------------------------------ suggestions */

  /** Append one non-destructive consolidation proposal. */
  async saveSuggestion (input) {
    const row = {
      kind: 'suggestion',
      id: input.id ?? 's_' + randomUUID(),
      ts: this.#now(),
      status: input.status ?? 'proposed',
      action: input.action,
      targetIds: [...(input.targetIds ?? [])],
      proposedText: input.proposedText ?? '',
      rationale: input.rationale ?? '',
      similarity: input.similarity,
      namespace: normalizeNamespace(input.namespace),
      owner: typeof input.owner === 'string' && input.owner.length > 0 ? input.owner : null,
      visibility: normalizeVisibility(input.visibility),
      source: input.source ?? null,
      basedOnRevision: this.#revision
    }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }

  suggestions (status = 'proposed') {
    const all = [...this.#suggestions.values()]
    if (status === 'all') return all
    return all.filter((row) => row.status === status)
  }

  suggestionById (id) {
    return this.#suggestions.get(id) ?? null
  }

  /** Append the status transition of one proposal (latest row wins). */
  async markSuggestion (id, status, fields = {}) {
    const previous = this.#suggestions.get(id)
    if (previous === undefined) throw new Error(`suggestion not found: ${id}`)
    const row = {
      ...previous,
      kind: 'suggestion',
      ts: this.#now(),
      status,
      ...fields
    }
    try {
      return await this.#append(row)
    } catch (error) {
      throw MemoryStore.#writeFailure(error)
    }
  }
}

function normalizeSupersedes (value) {
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id.length > 0 && !out.includes(id)) out.push(id)
  }
  return out
}

function clampImportance (value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 3
  return Math.min(5, Math.max(1, Math.round(number)))
}

function normalizeTime (value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const ms = Date.parse(value.trim())
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
