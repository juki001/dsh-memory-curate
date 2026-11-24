import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSession, addHuman, addAssistant, addToolResult, fakeTokenMeter } from './helpers.js'
import {
  PRUNE_MARKER,
  PRUNE_DEFAULTS,
  codePointLength,
  measureContent,
  pruneContent,
  foldToolResults
} from '../src/prune.js'

const blocks = (text) => [{ type: 'text', text }]

test('FD-01 marker is the host marker and head/tail/defaults match', () => {
  assert.equal(PRUNE_MARKER, '\n\n[... tool result middle pruned ...]\n\n')
  assert.equal(codePointLength(PRUNE_MARKER), 39)
  assert.deepEqual(PRUNE_DEFAULTS, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
})

test('FD-02 a 10000-code-point result folds to head + marker + tail', () => {
  const text = 'a'.repeat(10000)
  const folded = pruneContent(blocks(text))
  assert.equal(codePointLength(folded[0].text), 4096 + 39 + 1024)
  assert.equal(folded[0].text.startsWith('a'.repeat(4096)), true)
  assert.equal(folded[0].text.endsWith('a'.repeat(1024)), true)
  assert.equal(folded[0].text.includes(PRUNE_MARKER), true)
})

test('FD-03 exactly at the threshold is not folded', () => {
  assert.equal(pruneContent(blocks('a'.repeat(8192))), null)
  assert.equal(pruneContent(blocks('a'.repeat(8193))) !== null, true)
})

test('FD-04 code points, not UTF-16 units, decide the budget', () => {
  const emoji = '😀'.repeat(4000)
  assert.equal(codePointLength(emoji), 4000)
  assert.equal(measureContent(blocks(emoji)), 4000)
  assert.equal(pruneContent(blocks(emoji)), null)
})

test('FD-05 folding appends a shadow-price event before the replacement', async () => {
  const session = new FakeSession()
  addHuman(session, '第一轮')
  addAssistant(session, '回答')
  const original = addToolResult(session, 'x'.repeat(10000))
  const result = foldToolResults({
    session,
    tokenMeter: fakeTokenMeter(50),
    protectedWindow: { start: null, startIndex: null, protectedSeqs: [] }
  })
  assert.equal(result.pruned.length, 1)
  assert.equal(result.skipped.length, 0)
  assert.ok(result.charsRemoved > 0)
  const [shadow, replacement] = session.records.slice(-2)
  assert.equal(shadow.type, 'compaction/prune')
  assert.deepEqual(shadow.data.shadowedSeqs, [original.seq])
  assert.equal(shadow.data.shadowedTokenCount, 50)
  assert.equal(replacement.type, 'tool/result')
  assert.equal(replacement.data.message.content[0].text.length, 4096 + 39 + 1024)
  assert.notEqual(replacement.seq, original.seq)
  assert.equal(session.surface.nodes.at(-1), replacement.seq)
  assert.equal(session.records[original.seq].data.message.content[0].text.length, 10000)
})

test('FD-06 protected tool results are skipped when asked', () => {
  const session = new FakeSession()
  addHuman(session, '第一轮')
  addAssistant(session, '回答')
  addHuman(session, '第二轮')
  addToolResult(session, 'y'.repeat(10000))
  const result = foldToolResults({
    session,
    tokenMeter: fakeTokenMeter(50),
    protectedWindow: { start: session.surface.nodes[2], startIndex: 2, protectedSeqs: session.surface.nodes.slice(2) },
    protectToolResults: true
  })
  assert.equal(result.pruned.length, 0)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].reason, 'protected')
  assert.equal(session.surface.nodes.length, 4)
})

test('FD-07 protection can be turned off for tool results only', () => {
  const session = new FakeSession()
  addHuman(session, '第一轮')
  addAssistant(session, '回答')
  addHuman(session, '第二轮')
  addToolResult(session, 'z'.repeat(10000))
  const result = foldToolResults({
    session,
    tokenMeter: fakeTokenMeter(50),
    protectedWindow: { start: session.surface.nodes[2], startIndex: 2, protectedSeqs: session.surface.nodes.slice(2) },
    protectToolResults: false
  })
  assert.equal(result.pruned.length, 1)
  assert.equal(result.pruned[0].protected, true)
  assert.equal(session.surface.nodes.length, 4)
})
