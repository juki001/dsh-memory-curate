/**
 * Minimal in-memory session double for unit tests.
 *
 * Mirrors the append-only shape the plugin relies on: `append` returns an event
 * with a new seq, `surface.nodes` holds the current projection and a
 * `surfaceOp: {op:'replace', startSeq, endSeq}` swaps a position range.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.js'
import { CurateService, resolveConfig } from '../src/index.js'

export class FakeSession {
  constructor (id = 'session-test') {
    this.id = id
    this.origin = 'test'
    this.records = []
    this.surface = { nodes: [], replaceGeneration: 1, contentGeneration: 1 }
    this.next = 0
    this.header = undefined
  }

  get seq () { return this.next }

  append (type, data, options = {}) {
    const seq = this.next++
    const event = { seq, type, data, ts: new Date(1700000000000 + seq * 1000).toISOString() }
    this.records.push(event)
    const op = options.surfaceOp
    if (op === 'append' || op?.op === 'append') {
      this.surface.nodes.push(seq)
    } else if (op?.op === 'replace') {
      const startIndex = this.surface.nodes.indexOf(op.startSeq)
      const endIndex = this.surface.nodes.indexOf(op.endSeq)
      if (startIndex < 0 || endIndex < startIndex) throw new Error('fake session: bad replace range')
      this.surface.nodes.splice(startIndex, endIndex - startIndex + 1, seq)
      this.surface.replaceGeneration++
    }
    return event
  }

  eventAt (seq) {
    return this.records[seq]
  }

  deriveEventMessage (event) {
    if (event === undefined || event === null) return null
    if (event.type === 'tool/result') return event.data?.message ?? null
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'system/message') {
      return event.data?.message ?? event.data ?? null
    }
    return event.data?.message ?? null
  }

  requestHeader () { return this.header }
}

export function addSystem (session, text) {
  return session.append('system/message', {
    id: 's_' + session.next,
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: 'system' }
  }, { surfaceOp: 'append' })
}

export function addHuman (session, text, extra = {}) {
  return session.append('user/message', {
    id: 'u_' + session.next,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', ...extra }
  }, { surfaceOp: 'append' })
}

export function addRuntimeContext (session, text) {
  return session.append('user/message', {
    id: 'rc_' + session.next,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context' }
  }, { surfaceOp: 'append' })
}

export function addAssistant (session, text) {
  return session.append('assistant/message', {
    id: 'a_' + session.next,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model' }
  }, { surfaceOp: 'append' })
}

export function addToolResult (session, text, callId = 'call_' + session.next) {
  return session.append('tool/result', {
    callId,
    message: {
      id: 'tr_' + session.next,
      role: 'tool',
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId }
    }
  }, { surfaceOp: 'append' })
}

export function fakeTokenMeter (perSeq = 100) {
  return {
    measure (session) {
      return {
        logRevision: session.seq,
        baseline: 0,
        surfaceDeltaTokens: session.surface.nodes.length * perSeq,
        totalTokens: session.surface.nodes.length * perSeq,
        surfaceTokens: session.surface.nodes.length * perSeq,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: perSeq, heuristicTokens: perSeq }))
      }
    },
    estimateMessage () { return perSeq },
    contextPressure () { return { pressureTokens: 0, contextWindow: 100000 } }
  }
}

/** One NDJSON store in a throwaway temp directory. */
export async function tempStore () {
  const dir = await mkdtemp(join(tmpdir(), 'memory-curate-'))
  const file = join(dir, 'store.ndjson')
  const store = await MemoryStore.open(file)
  return { dir, file, store, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }) }
}

/**
 * Build a CurateService without the cordis Service constructor (the tests do
 * not boot a full host). Every field the real constructor sets is present so
 * prototype methods run unchanged.
 */
export function makeCurateService ({ store = null, config = {}, ctx = {} } = {}) {
  const service = Object.create(CurateService.prototype)
  service.config = resolveConfig(config)
  service.store = store
  service.storeError = null
  service.readOnly = false
  service.deferCount = new Map()
  service.forceNext = new Set()
  service.anchorCache = new Map()
  service.sectionCache = new Map()
  service.anchorHashes = new Map()
  service.promptState = { generating: false, failures: 0 }
  service.pendingCandidate = new Map()
  service.anchorDirty = new Set()
  service.currentAnchor = undefined
  service.attachedAgents = new WeakSet()
  service.wrappedEngines = new WeakSet()
  service.wrappedPruners = new WeakSet()
  service.approvedCompaction = new WeakSet()
  service.approvedGates = new WeakMap()
  service.overflowBypass = new WeakSet()
  service.expiredAudited = new Set()
  service.consolidating = false
  service.semantic = { embedder: null, lastError: null, lastErrorAt: 0 }
  service.indexCache = new Map()
  service.ctx = {
    get: () => undefined,
    logger: { info () {}, warn () {}, debug () {} },
    tokenMeter: fakeTokenMeter(),
    ...ctx
  }
  service.auditSafe = async (op, fields) => {
    if (store === null || store === undefined) return null
    try {
      return await store.audit(op, fields)
    } catch {
      return null
    }
  }
  return service
}

