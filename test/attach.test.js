import test from 'node:test'
import assert from 'node:assert/strict'
import { CurateService, resolveConfig } from '../src/index.js'
import { FakeSession, addSystem, addHuman, addAssistant, fakeTokenMeter } from './helpers.js'

function makeService ({ engine, pruner }) {
  const service = Object.create(CurateService.prototype)
  service.config = resolveConfig({ softRatio: 0.8, hardRatio: 0.92, maxDeferSteps: 3 })
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

test('pressure below the soft threshold is left to the engine', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.pressureRatio = async () => 0.5
  const agent = { session: new FakeSession() }
  await service.attach(agent)
  const original = engine.calls.length
  const result = await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(original, 0)
  assert.equal(result, null)
})

test('a failed write gate defers instead of compacting', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.pressureRatio = async () => 0.85
  service.gateWrite = () => ({ ok: false, cited: [] })
  let deferred = null
  const realDefer = service.defer.bind(service)
  service.defer = async (...args) => {
    deferred = { gate: args[1], gates: args[4] }
    return realDefer(...args)
  }
  const session = new FakeSession()
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const result = await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(result, null)
  assert.equal(engine.calls.length, 0)
  assert.equal(deferred.gate, 'write')
  assert.equal(service.deferCount.get(session), 1)
})

test('the region handed to the engine never includes the protected window', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.pressureRatio = async () => 0.95
  service.gateWrite = () => ({ ok: true, cited: ['m1'] })
  service.gateRecall = () => ({ ok: true, hits: ['m1'] })
  const session = new FakeSession()
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  const fifthFromLastHuman = nodes[2] // humans live on even seqs: 0,2,4,6,8,10
  await engine.compactRegion(nodes[0], nodes[nodes.length - 1], agent, undefined)
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].start, nodes[0])
  assert.ok(nodes.indexOf(engine.calls[0].end) < nodes.indexOf(fifthFromLastHuman))
})

test('approved compaction skips the gates it already passed', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.gateWrite = () => { throw new Error('gate must not run twice') }
  service.gateRecall = () => { throw new Error('gate must not run twice') }
  const session = new FakeSession()
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  service.approvedCompaction.add(session)
  const nodes = [...session.surface.nodes]
  await engine.compactRegion(nodes[0], nodes[2], agent, undefined)
  assert.equal(engine.calls.length, 1)
})

test('CM-HEAD-01 the pressure path starts after the protected system head', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.pressureRatio = async () => 0.95
  service.gateWrite = () => ({ ok: true, cited: ['m1'] })
  service.gateRecall = () => ({ ok: true, hits: ['m1'] })
  const session = new FakeSession()
  addSystem(session, '你是 DSH 助手')
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  await engine.compactIfNeeded(agent, 'pressure', undefined)
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].start, nodes[1])
  assert.notEqual(engine.calls[0].start, nodes[0])
})

test('CM-HEAD-02 a span that starts on the system head is refused before any summary', async () => {
  const engine = makeEngine()
  const service = makeService({ engine, pruner: null })
  service.pressureRatio = async () => 0.5
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
  service.pressureRatio = async () => 0.95
  const audits = []
  service.auditSafe = async (_op, fields) => { audits.push(fields) }
  const session = new FakeSession()
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
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
  service.pressureRatio = async () => 0.95
  const audits = []
  service.auditSafe = async (_op, fields) => { audits.push(fields) }
  const session = new FakeSession()
  for (let i = 0; i < 6; i++) {
    addHuman(session, `human ${i}`)
    addAssistant(session, `assistant ${i}`)
  }
  const agent = { session }
  await service.attach(agent)
  const nodes = [...session.surface.nodes]
  const result = await engine.compactRegion(nodes[1], 99999, agent, undefined)
  assert.equal(result, null)
  assert.equal(engine.calls.length, 0)
  assert.equal(audits.at(-1)?.reason, 'region-not-on-surface')
})
