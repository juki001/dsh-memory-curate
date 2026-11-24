import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.js'

async function tempStore () {
  const dir = await mkdtemp(join(tmpdir(), 'memory-curate-'))
  const file = join(dir, 'store.ndjson')
  const store = await MemoryStore.open(file)
  return { dir, file, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('ST-01 first line is a schema header', async () => {
  const { file, cleanup } = await tempStore()
  try {
    const first = JSON.parse((await readFile(file, 'utf8')).split('\n')[0])
    assert.equal(first.kind, 'header')
    assert.equal(first.v, 1)
    assert.equal(first.plugin, 'dsh-memory-curate')
  } finally { await cleanup() }
})

test('ST-02 memory rows are self-contained', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const row = await store.saveMemory({
      text: '默认使用 pnpm',
      tags: ['构建'],
      triggers: ['安装依赖'],
      entities: ['pnpm'],
      writeReason: '用户明确要求',
      structureReason: '单句约定',
      sessionId: 's1',
      seqs: [3],
      promptVersion: 'p1'
    })
    assert.match(row.id, /^m_/)
    assert.equal(row.op, 'create')
    assert.equal(row.source.sessionId, 's1')
    assert.deepEqual(row.source.seqs, [3])
    assert.equal(row.promptVersion, 'p1')
    assert.equal(row.schemaVersion, 3)
    assert.equal(row.namespace, 'default')
    assert.equal(row.owner, null)
    assert.equal(row.visibility, 'shared')
    assert.equal(row.status, 'active')
    assert.equal(row.importance, 3)
    assert.equal(row.validUntil, null)
    assert.equal(row.writeReason, '用户明确要求')
  } finally { await cleanup() }
})

test('ST-04 update appends a row and never rewrites the old one', async () => {
  const { file, store, cleanup } = await tempStore()
  try {
    const first = await store.saveMemory({ text: '用 npm', sessionId: 's1', seqs: [1], promptVersion: 'p1' })
    const second = await store.saveMemory({ text: '改用 pnpm', supersedes: first.id, sessionId: 's1', seqs: [2], promptVersion: 'p1' })
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.filter((line) => JSON.parse(line).kind === 'memory').length, 2)
    assert.equal(store.statusOf(first.id), 'superseded')
    assert.equal(store.statusOf(second.id), 'active')
    assert.equal(store.activeMemories().length, 1)
    assert.equal(store.activeMemories()[0].text, '改用 pnpm')
  } finally { await cleanup() }
})

test('ST-05 delete appends a tombstone and hides the memory', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const row = await store.saveMemory({ text: '旧约', sessionId: 's1', seqs: [1] })
    await store.deleteMemory(row.id, { reason: '用户撤销', sessionId: 's1', seqs: [2] })
    assert.equal(store.statusOf(row.id), 'deleted')
    assert.equal(store.activeMemories().length, 0)
    const audit = await store.audit('delete', { targetId: row.id, reason: '用户撤销' })
    assert.equal(audit.op, 'delete')
  } finally { await cleanup() }
})

test('ST-07 concurrent appends stay complete lines', async () => {
  const { file, store, cleanup } = await tempStore()
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.saveMemory({ text: `约定 ${index}`, sessionId: 's1', seqs: [index] })))
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
    assert.equal(store.activeMemories().length, 20)
  } finally { await cleanup() }
})

test('ST-06 corrupt lines are skipped and audited', async () => {
  const { file, store, cleanup } = await tempStore()
  try {
    await store.saveMemory({ text: '保留这条', sessionId: 's1', seqs: [1] })
    await appendFile(file, '{"kind":"memory","broken":\n', 'utf8')
    const reopened = await MemoryStore.open(file)
    assert.equal(reopened.activeMemories().length, 1)
    assert.equal(reopened.auditRows().some((row) => row.op === 'store_corrupt'), true)
  } finally { await cleanup() }
})

test('unknown row kinds are preserved on disk', async () => {
  const { file, store, cleanup } = await tempStore()
  try {
    await appendFile(file, JSON.stringify({ kind: 'future_kind', payload: 1 }) + '\n', 'utf8')
    const reopened = await MemoryStore.open(file)
    const text = await readFile(file, 'utf8')
    assert.match(text, /future_kind/)
    assert.equal(reopened.activeMemories().length, 0)
  } finally { await cleanup() }
})

test('traceMemory returns write, update and recall rows', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const row = await store.saveMemory({ text: '审计链', sessionId: 's1', seqs: [7] })
    await store.audit('write', { memoryId: row.id, decision: 'written', sessionId: 's1', sourceSeqs: [7] })
    await store.audit('recall', { query: '审计', hits: [{ id: row.id }], returned: [row.id], sessionId: 's1' })
    const rows = store.traceMemory(row.id)
    assert.equal(rows.filter((entry) => entry.kind === 'memory').length, 1)
    assert.equal(rows.some((entry) => entry.op === 'recall'), true)
    assert.equal(store.traceSeq('s1', 7).length >= 2, true)
  } finally { await cleanup() }
})

test('store write failure surfaces STORE_WRITE_FAILED', async () => {
  const { file, store, cleanup } = await tempStore()
  try {
    await rm(file, { force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(file, { recursive: true })
    await assert.rejects(
      () => store.saveMemory({ text: '写入失败', sessionId: 's1', seqs: [1] }),
      (error) => error.code === 'STORE_WRITE_FAILED'
    )
  } finally { await cleanup() }
})
