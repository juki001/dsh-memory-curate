import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FakeSession,
  addHuman,
  addAssistant,
  addRuntimeContext,
  addToolResult
} from './helpers.js'
import { computeProtectedWindow, humanMessageSeqs, isProtected, recentHumanText } from '../src/window.js'

test('PT-01 window starts at the fifth most recent human message', () => {
  const session = new FakeSession()
  const humans = []
  for (let index = 0; index < 7; index++) {
    humans.push(addHuman(session, `第 ${index} 轮`))
    addAssistant(session, `回答 ${index}`)
  }
  const window = computeProtectedWindow(session, 5)
  assert.equal(window.start, humans[humans.length - 5].seq)
  assert.equal(window.start, humanMessageSeqs(session)[2])
  assert.equal(window.protectedSeqs[0], window.start)
})

test('PT-02 runtime-context and compaction checkpoints never count as turns', () => {
  const session = new FakeSession()
  const first = addHuman(session, '第一轮')
  addRuntimeContext(session, '当前工作目录')
  addAssistant(session, '回答')
  addHuman(session, '第二轮')
  addAssistant(session, '回答')
  assert.deepEqual(humanMessageSeqs(session), [first.seq, 3])
  assert.equal(computeProtectedWindow(session, 5).start, first.seq)
})

test('PT-03 fewer than N human messages protects from the earliest one', () => {
  const session = new FakeSession()
  const first = addHuman(session, '只有一轮')
  addAssistant(session, '回答')
  const window = computeProtectedWindow(session, 5)
  assert.equal(window.start, first.seq)
  assert.equal(window.protectedSeqs.length, session.surface.nodes.length)
})

test('PT-04 tool traffic inside a long turn stays protected', () => {
  const session = new FakeSession()
  addHuman(session, '第一轮')
  addAssistant(session, '回答')
  const second = addHuman(session, '第二轮')
  addAssistant(session, '回答')
  const human = addHuman(session, '做一件很长的任务')
  const tool = addToolResult(session, 'x'.repeat(20000))
  addAssistant(session, '完成')
  const window = computeProtectedWindow(session, 2)
  assert.equal(window.start, second.seq)
  assert.equal(human.seq > second.seq, true)
  assert.equal(isProtected(window, tool.seq), true)
  assert.equal(isProtected(window, second.seq - 1), false)
})

test('window with no human messages protects nothing and is still safe', () => {
  const session = new FakeSession()
  addRuntimeContext(session, '只有运行时上下文')
  const window = computeProtectedWindow(session, 5)
  assert.equal(window.start, null)
  assert.deepEqual(window.protectedSeqs, [])
  assert.equal(isProtected(window, 0), false)
})

test('recentHumanText returns only human text', () => {
  const session = new FakeSession()
  addHuman(session, '请记住默认用 pnpm')
  addAssistant(session, '好的')
  assert.equal(recentHumanText(session, 5), '请记住默认用 pnpm')
})
