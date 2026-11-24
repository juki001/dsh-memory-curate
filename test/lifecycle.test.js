import test from 'node:test'
import assert from 'node:assert/strict'
import { tempStore, makeCurateService } from './helpers.js'
import { recencyFactor, importanceFactor, similarity, recall } from '../src/retrieval.js'

test('TTL-01 an expired assertion leaves active recall without being deleted', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const past = new Date(Date.now() - 86400000).toISOString()
    const row = await store.saveMemory({ text: '旧约定：周三前用旧接口', validUntil: past, sessionId: 's1', seqs: [1] })
    assert.equal(store.statusOf(row.id), 'expired')
    assert.equal(store.activeMemories().length, 0)
    assert.equal(store.activeMemories({ includeExpired: true }).length, 1)
    assert.equal(store.memoryById(row.id) !== null, true)
  } finally { await cleanup() }
})

test('TTL-02 the first expiry observation is audited once', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const past = new Date(Date.now() - 1000).toISOString()
    const row = await store.saveMemory({ text: '临时约定', validUntil: past, sessionId: 's1' })
    const service = makeCurateService({ store })
    assert.equal(await service.sweepExpired(), 1)
    assert.equal(await service.sweepExpired(), 0)
    const audits = store.auditRows().filter((entry) => entry.op === 'expire')
    assert.equal(audits.length, 1)
    assert.equal(audits[0].memoryId, row.id)
    assert.equal(audits[0].decision, 'expired')
  } finally { await cleanup() }
})

test('TTL-03 recency decay has a half life and a floor', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z')
  const fresh = { updatedAt: '2026-06-01T00:00:00.000Z' }
  const half = { updatedAt: '2026-03-03T00:00:00.000Z' }
  const ancient = { updatedAt: '2020-01-01T00:00:00.000Z' }
  assert.equal(recencyFactor(fresh, now, 90), 1)
  assert.ok(Math.abs(recencyFactor(half, now, 90) - 0.5) < 0.02)
  assert.ok(recencyFactor(ancient, now, 90) >= 0.25)
  assert.equal(recencyFactor(ancient, now, 0), 1)
})

test('TTL-04 importance scales the rank without hiding anything', () => {
  assert.equal(importanceFactor({ importance: 3 }), 0.8)
  assert.equal(importanceFactor({ importance: 5 }), 1)
  assert.equal(importanceFactor({}), 0.8)
  const rows = [
    { id: 'm_low', text: '同一句约定', tags: ['构建'], importance: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'm_high', text: '同一句约定', tags: ['构建'], importance: 5, updatedAt: '2026-01-01T00:00:00.000Z' }
  ]
  const result = recall('构建', rows, { now: Date.parse('2026-01-02T00:00:00.000Z') })
  assert.equal(result.hits[0].id, 'm_high')
  assert.ok(result.hits[0].why.importance > result.hits[1].why.importance)
})

test('TTL-05 recall usage is derived from the audit trail', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const row = await store.saveMemory({ text: '默认使用 pnpm', sessionId: 's1' })
    await store.audit('recall', { query: 'pnpm', returned: [row.id], totalHits: 1 })
    const lastUsed = store.lastUsedMap()
    assert.equal(typeof lastUsed.get(row.id), 'string')
  } finally { await cleanup() }
})

test('BROWSE-01 browse filters by tag and searches by query', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const pnpm = await store.saveMemory({ text: '默认使用 pnpm 安装依赖', tags: ['构建'], sessionId: 's1' })
    await store.saveMemory({ text: '日志不要打印访问令牌', tags: ['安全'], sessionId: 's1' })
    const service = makeCurateService({ store })
    const byTag = service.browse({ tags: ['构建'] })
    assert.equal(byTag.total, 1)
    assert.equal(byTag.rows[0].id, pnpm.id)
    const byQuery = service.browse({ query: 'pnpm 安装' })
    assert.equal(byQuery.rows[0].id, pnpm.id)
    assert.equal(byQuery.rows[0].source.sessionId, 's1')
    assert.equal(byQuery.rows[0].importance, 3)
  } finally { await cleanup() }
})

test('BROWSE-02 update supersedes and delete tombstones without erasing history', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const first = await store.saveMemory({ text: '提交前跑 npm test', tags: ['流程'], sessionId: 's1' })
    const service = makeCurateService({ store })
    const updated = await service.updateMemory({ memoryId: first.id, text: '提交前跑 npm test 与自检', reason: 'clarity' })
    assert.equal(store.statusOf(first.id), 'superseded')
    const active = store.activeMemories()
    assert.equal(active.length, 1)
    assert.equal(active[0].id, updated.id)
    assert.equal(active[0].supersedes, first.id)
    await service.deleteById({ memoryId: updated.id, reason: 'obsolete' })
    assert.equal(store.statusOf(updated.id), 'deleted')
    assert.equal(store.activeMemories().length, 0)
    assert.equal(store.traceMemory(first.id).some((row) => row.kind === 'memory'), true)
  } finally { await cleanup() }
})

test('CONS-01 overlapping rows become one proposal, apply supersedes both', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const left = await store.saveMemory({ text: '默认使用 pnpm 安装依赖', tags: ['构建'], sessionId: 's1' })
    const right = await store.saveMemory({ text: '统一使用 pnpm 安装依赖', tags: ['构建'], sessionId: 's1' })
    const score = similarity(left, right)
    assert.ok(score >= 0.6 && score < 0.82, `fixture similarity ${score}`)
    const service = makeCurateService({ store })
    const proposed = await service.proposeConsolidation(left.id, {})
    assert.equal(proposed.ok, true)
    const open = service.listSuggestions()
    assert.equal(open.length, 1)
    assert.equal(open[0].action, 'merge')
    assert.deepEqual([...open[0].targetIds].sort(), [left.id, right.id].sort())
    const applied = await service.applySuggestion({ suggestionId: open[0].id })
    assert.equal(applied.ok, true)
    assert.equal(store.statusOf(left.id), 'superseded')
    assert.equal(store.statusOf(right.id), 'superseded')
    const merged = store.memoryById(applied.id)
    assert.deepEqual([...merged.supersedes].sort(), [left.id, right.id].sort())
    assert.equal(store.suggestionById(open[0].id).status, 'applied')
  } finally { await cleanup() }
})

test('CONS-02 opposite polarity is proposed as a conflict, dismiss closes it', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const left = await store.saveMemory({ text: '默认启用遥测上报', tags: ['配置'], sessionId: 's1' })
    await store.saveMemory({ text: '默认不要启用遥测上报', tags: ['配置'], sessionId: 's1' })
    const service = makeCurateService({ store })
    await service.proposeConsolidation(left.id, {})
    const open = service.listSuggestions()
    assert.equal(open[0].action, 'conflict')
    await service.dismissSuggestion({ suggestionId: open[0].id })
    assert.equal(service.listSuggestions().length, 0)
    assert.equal(store.suggestionById(open[0].id).status, 'dismissed')
  } finally { await cleanup() }
})
