import test from 'node:test'
import assert from 'node:assert/strict'
import { CurateService, resolveConfig } from '../src/index.js'
import { FakeSession, addSystem, addHuman, addAssistant, fakeTokenMeter } from './helpers.js'

function makeService ({ engine, pruner, config = {} }) {
  const service = Object.create(CurateService.prototype)
  service.config = resolveConfig({ softRatio: 0.8, hardRatio: 0.92, maxDeferSteps: 3, protectTurns: 1, ...config })
  service.store = { activeMemories: () => [], auditRows: () => [] }
  service.storeError = null
  service.deferCount = new Map()
  service.forceNext = new Set()
  service.anchorCache = { revision: -1, dirty: true, text: '', hash: '' }
  service.sectionCache = { key: '', text: '' }
  service.promptState = { generating: false, failures: 0 }
  service.pendingCandidate = new Map()
  service.anchorDirty = new Set()
  service.currentAnchor = undefined
  service.attachedAgents = new WeakSet()
  service.wrappedEngines = new WeakSet()
  service.wrappedPruners = new WeakSet()
  service.approvedCompaction = new WeakSet()
  service.approvedGates = new WeakMap()
  service.ctx = {
    get: (name) => name === 'agentPresets'
      ? { serviceFor: (_agent, serviceName) => serviceName === 'compaction' ? engine : pruner }
      : undefined,
    tokenMeter: fakeTokenMeter(),
    logger: {}
  }
  service.auditSafe = async () => {}
  return service
}

function makeEngine () {
  const calls = []
  return {
    calls,
    async compactRegion (start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [start, end], shadowedTokenCount: 42 }
    },
    async compactIfNeeded () {
      calls.push({ ifNeeded: true })
      return { kind: 'compacted' }
    }
  }
}

function sixTurns () {
  const session = new FakeSession()
  for (let index = 0; index < 6; index++) {
    addHuman(session, `human ${index}`)
    addAssistant(session, `assistant ${index}`)
  }
  return session
}

test('attach wraps the preset-scoped engine and pruner exactly once', async () => {
  const engine = makeEngine()
  const pruner = { calls: 0, pruneSession () { this.calls++ } }
  const service = makeService({ engine, pruner })
  const agent = { session: new FakeSession() }
  await service.attach(agent)
  assert.notEqual(engine.compactRegion.name, 'compactRegion')
  assert.notEqual(pruner.pruneSession.name, 'pruneSession')
  const wrappedRegion = engine.compactRegion
  const wrappedPruner = pruner.pruneSession
  const other = { session: new FakeSession() }
  await service.attach(other)
  assert.equal(engine.compactRegion, wrappedRegion)
  assert.equal(pruner.pruneSession, wrappedPruner)
  assert.equal(pruner.calls, 0)
})

test('attach degrades without throwing when the preset has no engine', async () => {
  const service = makeService({ engine: null, pruner: null })
  await service.attach({ session: new FakeSession() })
  assert.equal(service.attachedAgents.has, service.attachedAgents.has)
})

test('the plugin delegates every pressure decision to the host engine', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  const agent = { session: new FakeSession() }
  await service.attach(agent)
  const result = await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(engine.calls.length, 1, 'the host compactIfNeeded must run once')
  assert.equal(result.kind, 'compacted')
})

test('a failed write gate can no longer block compaction', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.gateWrite = () => ({ ok: false, cited: [] })
  const session = sixTurns()
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  const result = await engine.compactRegion(nodes[0], nodes[nodes.length - 1], agent, undefined)
  assert.equal(engine.calls.length, 1)
  assert.equal(result.shadowedTokenCount, 42)
  assert.equal(service.deferCount.get(session), undefined, 'no defer bookkeeping is kept')
})

test('the wrapper forwards the host region unchanged', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  const session = sixTurns()
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  await engine.compactRegion(nodes[0], nodes[nodes.length - 1], agent, undefined)
  assert.equal(engine.calls[0].start, nodes[0])
  assert.equal(engine.calls[0].end, nodes[nodes.length - 1])
})

test('CM-HEAD-01 a host range that starts after the system head is forwarded', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  const session = new FakeSession()
  addSystem(session, '你是 DSH 助手')
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  await engine.compactRegion(nodes[1], nodes[nodes.length - 1], agent, undefined)
  assert.equal(engine.calls[0].start, nodes[1])
  assert.notEqual(engine.calls[0].start, nodes[0])
})

test('CM-HEAD-02 a span that starts on the system head is refused before any summary', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  const session = new FakeSession()
  addSystem(session, 'system prompt')
  for (let i = 0; i < 3; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  const result = await engine.compactRegion(nodes[0], nodes[2], agent, undefined)
  assert.equal(result, null)
  assert.equal(engine.calls.length, 0)
})

test('CM-RANGE-01 a reversed stale range is refused before the engine sees it', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  const audits = []
  service.auditSafe = async (_op, fields) => { audits.push(fields) }
  const session = sixTurns()
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  const result = await engine.compactRegion(nodes.at(-1), nodes[0], agent, undefined)
  assert.equal(result, null)
  assert.equal(engine.calls.length, 0)
  assert.equal(audits.at(-1)?.decision, 'refused')
  assert.equal(audits.at(-1)?.reason, 'invalid-region-order')
})

test('CM-RANGE-02 a range missing from the current surface is refused', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  const audits = []
  service.auditSafe = async (_op, fields) => { audits.push(fields) }
  const session = sixTurns()
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  const result = await engine.compactRegion(nodes[1], 99999, agent, undefined)
  assert.equal(result, null)
  assert.equal(engine.calls.length, 0)
  assert.equal(audits.at(-1)?.reason, 'region-not-on-surface')
})

/**
 * Regression for the live deadlock: with the old five-human-turn window, a
 * session whose entire surface sits inside that window refused compaction with
 * `protected-window-exceeds-budget` on every step and only re-injected a
 * reminder. Compaction is now host-owned, so the same surface must compact.
 */
test('REG-01 a surface fully inside the old five-turn window still compacts', async () => {  const calls = []
  const engine = {
    async compactIfNeeded (agent) {
      const nodes = [...agent.session.surface.nodes]
      return this.compactRegion(nodes[0], nodes[nodes.length - 1], agent)
    },
    async compactRegion (start, end) {
      calls.push({ start, end })
      return { shadowedSeqs: [start, end], shadowedTokenCount: 7 }
    }
  }
  const service = makeService({ engine, pruner: null, config: { protectTurns: 5 } })
  service.ctx.tokenMeter = {
    measure: () => ({ totalTokens: 200000, nodes: [], surfaceTokens: 200000 }),
    estimateMessage: () => 0,
    contextPressure: () => ({ pressureTokens: 0, contextWindow: 80000 })
  }
  const session = new FakeSession()
  for (let i = 0; i < 3; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const result = await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(calls.length, 1, 'the host range must reach compactRegion instead of being refused')
  assert.equal(result.shadowedTokenCount, 7)
})

/**
 * Second half of the old deadlock: the host refuses a summary that is not
 * smaller than the span it shadows. The wrapper must surface that error once
 * and inject nothing, so the next step is not spammed by the plugin.
 */
test('REG-02 a host "summary not smaller" refusal propagates without injecting a reminder', async () => {
  const engine = {
    async compactIfNeeded (agent) {
      const nodes = [...agent.session.surface.nodes]
      return this.compactRegion(nodes[0], nodes[nodes.length - 1], agent)
    },
    async compactRegion () {
      throw new Error('summary is not smaller than the shadowed content (982 >= 980)')
    }
  }
  const service = makeService({ engine, pruner: null })
  const injected = []
  const session = sixTurns()
  const agent = { session, inject: (message) => { injected.push(message) } }
  await service.attach(agent)
  await assert.rejects(
    () => engine.compactIfNeeded(agent, 'pressure', undefined),
    /summary is not smaller/
  )
  assert.equal(injected.length, 0, 'the plugin must never inject a compaction reminder')
})
