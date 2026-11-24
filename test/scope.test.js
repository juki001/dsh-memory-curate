import test from 'node:test'
import assert from 'node:assert/strict'
import { canRead, canWrite, visibleRows, normalizeNamespace } from '../src/scope.js'
import { resolveConfig } from '../src/index.js'
import { makeCurateService, tempStore } from './helpers.js'

const scopeA = { agentId: 'sess-a', namespace: 'default' }
const scopeB = { agentId: 'sess-b', namespace: 'default' }

function memory (overrides = {}) {
  return {
    id: 'm_test',
    text: '默认使用 pnpm',
    tags: ['构建'],
    triggers: [],
    entities: [],
    namespace: 'default',
    owner: 'sess-a',
    visibility: 'shared',
    ...overrides
  }
}

test('SC-01 private rows are readable and writable only by the owner', () => {
  const row = memory({ visibility: 'private' })
  assert.equal(canRead(row, scopeA), true)
  assert.equal(canWrite(row, scopeA), true)
  assert.equal(canRead(row, scopeB), false)
  assert.equal(canWrite(row, scopeB), false)
  assert.equal(canRead(row, { ...scopeB, admin: true }), true)
  assert.equal(canWrite(row, { ...scopeB, admin: true }), true)
})

test('SC-02 shared rows are readable by the namespace, writable by the owner', () => {
  const row = memory({ visibility: 'shared' })
  assert.equal(canRead(row, scopeB), true)
  assert.equal(canWrite(row, scopeB), false)
  assert.equal(canWrite(row, scopeA), true)
})

test('SC-03 open rows are readable and writable by every agent in the namespace', () => {
  const row = memory({ visibility: 'open' })
  assert.equal(canRead(row, scopeB), true)
  assert.equal(canWrite(row, scopeB), true)
})

test('SC-04 namespace mismatch hides the row even when it is shared', () => {
  const row = memory({ namespace: 'work' })
  assert.equal(canRead(row, { ...scopeB, namespace: 'personal' }), false)
  assert.equal(canRead(row, { ...scopeB, namespace: 'work' }), true)
  assert.equal(canRead(row, { ...scopeB, namespace: 'personal', admin: true }), true)
})

test('SC-05 legacy ownerless shared rows stay writable for migration', () => {
  const row = memory({ owner: null, visibility: 'shared' })
  assert.equal(canRead(row, scopeB), true)
  assert.equal(canWrite(row, scopeB), true)
  assert.equal(canWrite(memory({ owner: null, visibility: 'private' }), scopeB), false)
})

test('SC-06 visibleRows filters without mutating the input', () => {
  const rows = [memory({ id: 'm_a' }), memory({ id: 'm_b', visibility: 'private', owner: 'sess-b' })]
  assert.deepEqual(visibleRows(rows, scopeA).map((row) => row.id), ['m_a'])
  assert.deepEqual(visibleRows(rows, scopeB).map((row) => row.id), ['m_a', 'm_b'])
  assert.equal(rows.length, 2)
})

test('SC-07 namespaces normalize and never become empty', () => {
  assert.equal(normalizeNamespace('  work  '), 'work')
  assert.equal(normalizeNamespace(''), 'default')
  assert.equal(normalizeNamespace(undefined), 'default')
  assert.equal(normalizeNamespace('x'.repeat(200)).length, 64)
})

test('SC-08 service save/recall/trace respect private scope', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const service = makeCurateService({ store, config: { namespace: 'default', consolidateMode: 'off' } })
    const session = { id: 'sess-a', seq: 1, surface: { nodes: [] }, eventAt: () => undefined }
    const agentA = { id: 'sess-a', session }
    const agentB = { id: 'sess-b', session: { ...session, id: 'sess-b' } }
    const saved = await service.save({
      agent: agentA,
      text: '这条只属于会话 A',
      tags: ['私有'],
      triggers: ['只给A'],
      visibility: 'private'
    })
    assert.equal(saved.ok, true)
    assert.equal(service.activeRowsFor(agentB).length, 0)
    const recallB = await service.recallWithAudit({ query: '只属于会话 A', limit: 5, agent: agentB })
    assert.equal(recallB.hits.length, 0)
    assert.deepEqual(service.trace({ memoryId: saved.id, agent: agentB }), [])
    const recallA = await service.recallWithAudit({ query: '只属于会话 A', limit: 5, agent: agentA })
    assert.equal(recallA.hits[0].id, saved.id)
  } finally { await cleanup() }
})

test('SC-09 shared memory is readable but not writable by another session', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const service = makeCurateService({ store, config: { namespace: 'default', consolidateMode: 'off' } })
    const sessionA = { id: 'sess-a', seq: 1, surface: { nodes: [] }, eventAt: () => undefined }
    const agentA = { id: 'sess-a', session: sessionA }
    const agentB = { id: 'sess-b', session: { ...sessionA, id: 'sess-b' } }
    const saved = await service.save({ agent: agentA, text: '共享约定', visibility: 'shared' })
    assert.equal(service.activeRowsFor(agentB).length, 1)
    await assert.rejects(
      () => service.updateMemory({ memoryId: saved.id, text: 'B 试图改', agent: agentB }),
      (error) => error.code === 'PERMISSION_DENIED'
    )
    await assert.rejects(
      () => service.delete({ agent: agentB, memoryId: saved.id }),
      (error) => error.code === 'PERMISSION_DENIED'
    )
  } finally { await cleanup() }
})

test('SC-11 config resolves scope defaults and rejects unknown visibility', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.namespace, 'default')
  assert.equal(defaults.defaultVisibility, 'shared')
  assert.equal(defaults.singleWriter, true)
  const custom = resolveConfig({ namespace: '  work  ', defaultVisibility: 'private', singleWriter: false })
  assert.equal(custom.namespace, 'work')
  assert.equal(custom.defaultVisibility, 'private')
  assert.equal(custom.singleWriter, false)
  assert.equal(resolveConfig({ defaultVisibility: 'nonsense' }).defaultVisibility, 'shared')
})

test('SC-10 anchor text only contains the calling agent scope', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const service = makeCurateService({ store, config: { namespace: 'default', anchorDetail: '详细', consolidateMode: 'off' } })
    const sessionA = { id: 'sess-a', seq: 1, surface: { nodes: [] }, eventAt: () => undefined }
    const agentA = { id: 'sess-a', session: sessionA }
    const agentB = { id: 'sess-b', session: { ...sessionA, id: 'sess-b' } }
    await service.save({ agent: agentA, text: 'A 的私有记忆', tags: ['私有标签'], triggers: ['只给A'], visibility: 'private' })
    await service.save({ agent: agentA, text: '共享记忆', tags: ['共享标签'], triggers: ['大家'], visibility: 'shared' })
    service.readOnly = true // keep the anchor audit from racing the temporary-dir cleanup
    const anchorA = service.anchor(agentA)
    const anchorB = service.anchor(agentB)
    assert.match(anchorA.text, /共享标签/u)
    assert.match(anchorA.text, /私有标签/u)
    assert.doesNotMatch(anchorB.text, /私有标签/u)
    assert.match(anchorB.text, /共享标签/u)
  } finally { await cleanup() }
})
