import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSession, addHuman, addAssistant, fakeTokenMeter, makeCurateService } from './helpers.js'

function pricedMeter (totalTokens) {
  const calls = []
  return {
    calls,
    measure (session, header) {
      calls.push({ session, header })
      return { totalTokens, nodes: [] }
    },
    estimateMessage () { return 0 },
    contextPressure () { return { pressureTokens: 0, contextWindow: 1048576 } }
  }
}

function header (maxTokens) {
  return { config: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens } }
}

test('CM-BUDGET-01 pressure is measured against messages-only budget', async () => {
  const meter = pricedMeter(700000)
  const service = makeCurateService({ ctx: { tokenMeter: meter } })
  const session = new FakeSession()
  session.header = header(256000)
  const budget = await service.pressureBudget(session)
  assert.equal(budget, 1048576 - 256000 - 65536)
  const ratio = await service.pressureRatio(session)
  assert.ok(Math.abs(ratio - 700000 / budget) < 1e-9)
  assert.equal(meter.calls.length, 1)
  assert.equal(meter.calls[0].header, session.header, 'measure must receive the request header')
})

test('CM-BUDGET-02 an unheaded session reserves no completion tokens', async () => {
  const service = makeCurateService({ ctx: { tokenMeter: pricedMeter(10) } })
  const session = new FakeSession()
  assert.equal(await service.pressureBudget(session), 1048576 - 65536)
})

test('CM-BUDGET-03 a zero headroom ratio removes the reserve', async () => {
  const service = makeCurateService({ config: { headroomRatio: 0 }, ctx: { tokenMeter: pricedMeter(10) } })
  const session = new FakeSession()
  session.header = header(256000)
  assert.equal(await service.pressureBudget(session), 1048576 - 256000)
})

test('CM-BUDGET-04 a budget smaller than the reservation yields no ratio', async () => {
  const service = makeCurateService({ ctx: { tokenMeter: pricedMeter(10) } })
  const session = new FakeSession()
  session.header = header(1048576)
  assert.equal(await service.pressureBudget(session), null)
  assert.equal(await service.pressureRatio(session), null)
})

test('CM-BUDGET-05 the old window denominator would never reach 0.8', () => {
  const window = 1048576
  const ceiling = (window - 256000) / window
  assert.ok(ceiling < 0.8, `ceiling ${ceiling.toFixed(4)} must sit below the old softRatio`)
})

test('CM-BUDGET-06 headroom scales with the model window', async () => {
  const service = makeCurateService({ ctx: { tokenMeter: pricedMeter(10) } })
  const session = new FakeSession()
  session.header = header(16000)
  // 100k context, 16k completion, ratio 0.0625 -> 6,250, floored to 8,192
  assert.equal(await service.pressureBudget(session, 100000), 100000 - 16000 - 8192)
})

function gatedEngine () {
  return {
    calls: [],
    async compactRegion (start, end) {
      this.calls.push({ start, end })
      return { shadowedSeqs: [start, end], shadowedTokenCount: 1 }
    },
    async compactIfNeeded (agent) {
      const nodes = [...agent.session.surface.nodes]
      return this.compactRegion(nodes[0], nodes[nodes.length - 1], agent)
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

function presetsCtx (engine) {
  return {
    get: (name) => name === 'agentPresets' ? { serviceFor: () => engine } : undefined,
    tokenMeter: fakeTokenMeter()
  }
}

test('CM-OVERFLOW-01 context-overflow bypasses the memory gates', async () => {
  const engine = gatedEngine()
  const service = makeCurateService({ ctx: presetsCtx(engine) })
  service.gateWrite = () => { throw new Error('write gate must not run on overflow') }
  service.gateRecall = () => { throw new Error('recall gate must not run on overflow') }
  const agent = { session: sixTurns() }
  await service.attach(agent)
  const result = await engine.compactIfNeeded(agent, 'context-overflow')
  assert.equal(engine.calls.length, 1)
  assert.equal(result.shadowedSeqs.length, 2)
  assert.equal(service.approvedCompaction.has(agent.session), false, 'approval must be scoped to the call')
})

test('CM-OVERFLOW-02 an unmeasurable pressure delegates to the host engine', async () => {
  const engine = { pressureCalls: 0, async compactIfNeeded () { this.pressureCalls++; return null }, async compactRegion () {} }
  const service = makeCurateService({ ctx: presetsCtx(engine) })
  service.pressureRatio = async () => null
  const agent = { session: sixTurns() }
  await service.attach(agent)
  await engine.compactIfNeeded(agent, 'pressure')
  assert.equal(engine.pressureCalls, 1)
})
