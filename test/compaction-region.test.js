import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSession, addSystem, addHuman, addAssistant, addToolResult, fakeTokenMeter } from './helpers.js'
import { computeProtectedWindow } from '../src/window.js'
import { selectCompactionRegion, regionText, regionQuery, routedTarget } from '../src/compaction.js'

function longSession () {
  const session = new FakeSession()
  for (let index = 0; index < 8; index++) {
    addHuman(session, `第 ${index} 轮任务说明`)
    addAssistant(session, `回答 ${index}`)
  }
  return session
}

test('CM-region never includes a seq at or after the protected window start', () => {
  const session = longSession()
  const window = computeProtectedWindow(session, 5)
  const region = selectCompactionRegion(session, window, fakeTokenMeter(100))
  assert.ok(region !== null)
  assert.equal(region.seqs.every((seq) => seq < window.start), true)
  assert.equal(region.start, session.surface.nodes[0])
  assert.equal(region.end, session.surface.nodes[window.startIndex - 1])
})

test('CM-region starts after the protected system head at node 0', () => {
  const session = new FakeSession()
  addSystem(session, 'system prompt')
  for (let index = 0; index < 8; index++) {
    addHuman(session, `任务 ${index}`)
    addAssistant(session, `回答 ${index}`)
  }
  const window = computeProtectedWindow(session, 5)
  const region = selectCompactionRegion(session, window, fakeTokenMeter(100))
  assert.ok(region !== null)
  assert.equal(region.seqs.includes(session.surface.nodes[0]), false)
  assert.equal(region.start, session.surface.nodes[1])
  assert.equal(region.end, session.surface.nodes[window.startIndex - 1])
})

test('region is null when everything is protected', () => {
  const session = new FakeSession()
  addHuman(session, '唯一一轮')
  addAssistant(session, '回答')
  const window = computeProtectedWindow(session, 5)
  assert.equal(selectCompactionRegion(session, window, fakeTokenMeter(100)), null)
})

test('region is null when the eligible span is below the token floor', () => {
  const session = longSession()
  const window = computeProtectedWindow(session, 5)
  assert.equal(selectCompactionRegion(session, window, fakeTokenMeter(1)), null)
})

test('regionText and regionQuery read the span, not the protected tail', () => {
  const session = longSession()
  const window = computeProtectedWindow(session, 5)
  const region = selectCompactionRegion(session, window, fakeTokenMeter(100))
  const text = regionText(session, region.seqs)
  assert.match(text, /第 0 轮任务说明/)
  assert.equal(text.includes('第 7 轮任务说明'), false)
  assert.ok(regionQuery(text).length > 0)
})

test('routedTarget reads the latest request header', () => {
  const session = new FakeSession()
  assert.equal(routedTarget(session), null)
  session.header = { config: { provider: 'deepseek', model: 'deepseek-chat' } }
  assert.deepEqual(routedTarget(session), { provider: 'deepseek', model: 'deepseek-chat' })
})

test('region ends on an even node when the surface ends with a tool result', () => {
  const session = new FakeSession()
  for (let index = 0; index < 6; index++) {
    addHuman(session, `任务 ${index}`)
    addToolResult(session, `工具结果 ${index}`)
    addAssistant(session, `回答 ${index}`)
  }
  const window = computeProtectedWindow(session, 4)
  const region = selectCompactionRegion(session, window, fakeTokenMeter(100))
  assert.ok(region !== null)
  const endEvent = session.eventAt(region.end)
  assert.notEqual(endEvent.type, 'tool/result')
})
