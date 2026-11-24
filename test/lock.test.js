import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { acquireStoreLock } from '../src/lock.js'
import { MemoryStore } from '../src/store.js'

async function tempFile () {
  const dir = await mkdtemp(join(tmpdir(), 'memory-curate-lock-'))
  return { dir, file: join(dir, 'store.ndjson'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('LK-01 acquires, blocks a second writer, and releases', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const first = await acquireStoreLock(file)
    assert.equal(first.ok, true)
    assert.equal((await stat(`${file}.lock`)).isFile(), true)
    const second = await acquireStoreLock(file)
    assert.equal(second.ok, false)
    assert.equal(second.code, 'STORE_LOCKED')
    assert.equal(second.owner?.pid, process.pid)
    assert.equal(await first.release(), true)
    const third = await acquireStoreLock(file)
    assert.equal(third.ok, true)
    await third.release()
  } finally { await cleanup() }
})

test('LK-02 takes over a lock whose recorded PID is gone', async () => {
  const { file, cleanup } = await tempFile()
  try {
    await writeFile(`${file}.lock`, JSON.stringify({ pid: 999999, host: hostname(), startedAt: new Date().toISOString(), token: 'dead' }) + '\n', 'utf8')
    const lock = await acquireStoreLock(file)
    assert.equal(lock.ok, true)
    await lock.release()
  } finally { await cleanup() }
})

test('LK-03 release never deletes a lock that was taken over', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const lock = await acquireStoreLock(file)
    assert.equal(lock.ok, true)
    await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other' }) + '\n', 'utf8')
    assert.equal(await lock.release(), false)
    assert.match(await readFile(`${file}.lock`, 'utf8'), /other/)
  } finally { await cleanup() }
})

test('LK-04 read-only store load skips corrupt-line repair writes', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const store = await MemoryStore.open(file)
    await store.saveMemory({ text: '保留这条', sessionId: 's1', seqs: [1] })
    await writeFile(file, (await readFile(file, 'utf8')) + '{"kind":"memory","broken":\n', 'utf8')
    const before = (await stat(file)).size
    const readOnly = await MemoryStore.open(file, { readOnly: true })
    assert.equal(readOnly.activeMemories().length, 1)
    assert.equal((await stat(file)).size, before)
    assert.equal(readOnly.auditRows().some((row) => row.op === 'store_corrupt'), false)
  } finally { await cleanup() }
})
