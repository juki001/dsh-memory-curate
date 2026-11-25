import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.js'

async function tempStore (options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-curate-archive-'))
  const file = join(dir, 'store.ndjson')
  const store = await MemoryStore.open(file, options)
  return { dir, file, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('AR-01 audit rows roll into an archive and memories survive', async () => {
  const { dir, file, store, cleanup } = await tempStore({ archiveBytes: 2 * 1024 })
  try {
    const memory = await store.saveMemory({
      text: '数据库只读账号在 10.0.0.8',
      tags: ['数据库'],
      triggers: ['只读账号'],
      sessionId: 's1',
      seqs: [1]
    })
    const first = await store.audit('recall', {
      memoryId: memory.id,
      query: '只读账号',
      hits: [{ id: memory.id }],
      sessionId: 's1'
    })
    for (let index = 0; index < 30; index++) {
      await store.audit('recall', {
        memoryId: memory.id,
        query: `query-${index} ${'x'.repeat(120)}`,
        hits: [{ id: memory.id }],
        sessionId: 's1'
      })
    }

    const result = await store.maybeArchive({ force: true })
    assert.equal(result.ok, true)
    assert.ok(result.archived >= 1)
    assert.ok(store.auditRows().length < 31)
    assert.equal(store.memoryById(memory.id).text, memory.text)

    const archiveRows = store.traceMemory(memory.id)
    assert.ok(archiveRows.some((row) => row.archived === true), 'trace should include archived rows')
    assert.ok(archiveRows.some((row) => row.id === first.id || row.archived === true))

    const reopened = await MemoryStore.open(file, { readOnly: true })
    assert.equal(reopened.activeMemories().length, 1)
    assert.equal(reopened.memoryById(memory.id).text, memory.text)
    assert.ok(reopened.stats().archive.files >= 1)
    assert.ok(reopened.traceMemory(memory.id).some((row) => row.archived === true))

    const manifest = JSON.parse(await readFile(join(reopened.archiveDir, result.archiveFile + '.manifest.json'), 'utf8'))
    assert.equal(manifest.rows, result.archived)
    assert.equal(manifest.sha256, result.sha256)
  } finally {
    await cleanup()
  }
})

test('AR-02 retain marker keeps a chosen audit row out of the archive', async () => {
  const { store, cleanup } = await tempStore({ archiveBytes: 2 * 1024 })
  try {
    const kept = await store.audit('write', {
      memoryId: 'm_keep',
      decision: 'created',
      reason: 'important decision'
    })
    for (let index = 0; index < 30; index++) {
      await store.audit('recall', { query: `q-${index}`, hits: [] })
    }
    await store.retainAudit(kept.id, { reason: 'keep forever', actor: 'admin' })
    const result = await store.maybeArchive({ force: true })
    assert.equal(result.ok, true)
    assert.ok(store.auditRows().some((row) => row.id === kept.id), 'retained audit must stay active')
    assert.equal(store.traceMemory('m_keep').some((row) => row.id === kept.id), true)
  } finally {
    await cleanup()
  }
})

test('AR-04 auto roll triggers above the byte threshold', async () => {
  const { store, cleanup } = await tempStore({ archiveBytes: 2 * 1024 })
  try {
    for (let index = 0; index < 30; index++) {
      await store.audit('recall', { query: `auto-${index} ${'z'.repeat(120)}`, hits: [] })
    }
    const result = await store.maybeArchive()
    assert.equal(result.ok, true)
    assert.ok(result.archived >= 1)
    assert.ok(store.stats().archive.files >= 1)
  } finally {
    await cleanup()
  }
})

test('AR-03 archive keeps the latest recall timestamp through a summary', async () => {
  const { store, cleanup } = await tempStore({ archiveBytes: 2 * 1024 })
  try {
    const memory = await store.saveMemory({ text: '长期配置', sessionId: 's1', seqs: [1] })
    for (let index = 0; index < 30; index++) {
      await store.audit('recall', {
        returned: [memory.id],
        query: `q-${index} ${'y'.repeat(100)}`
      })
    }
    const before = store.lastUsedMap().get(memory.id)
    await store.maybeArchive({ force: true })
    const after = store.lastUsedMap().get(memory.id)
    assert.equal(after, before)
  } finally {
    await cleanup()
  }
})
