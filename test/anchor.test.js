import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnchor } from '../src/anchor.js'

const memory = (index, tags, triggers = []) => ({
  id: `m_${index}`,
  text: `第 ${index} 条约定正文`,
  tags,
  triggers
})

test('AN-01 anchor carries tags, trigger words and counts only', () => {
  const anchor = buildAnchor([
    memory(1, ['构建'], ['pnpm', '安装依赖', '依赖']),
    memory(2, ['构建'], ['npm']),
    memory(3, ['发布'], ['npm publish'])
  ], { detail: '标准' })
  assert.match(anchor.text, /构建\(2\)/)
  assert.match(anchor.text, /发布\(1\)/)
  assert.equal(anchor.text.includes('第 1 条约定正文'), false)
  assert.ok(Array.from(anchor.text).length <= 400)
  assert.equal(anchor.tags, 2)
  assert.equal(anchor.memories, 3)
})

test('AN-02 identical memories yield identical bytes', () => {
  const memories = [memory(1, ['构建'], ['pnpm'])]
  assert.equal(buildAnchor(memories).text, buildAnchor([...memories]).text)
})

test('AN-03 500 memories still fit the 400-code-point cap', () => {
  const memories = Array.from({ length: 500 }, (_, index) => memory(index, [`标签${index}`], [`触发${index}`]))
  const anchor = buildAnchor(memories, { maxChars: 400 })
  assert.ok(Array.from(anchor.text).length <= 400)
  assert.equal(anchor.truncated, true)
})

test('AN-04 detail level changes how many triggers are shown', () => {
  const memories = [memory(1, ['构建'], ['a', 'b', 'c', 'd', 'e'])]
  const brief = buildAnchor(memories, { detail: '精简' }).text
  const full = buildAnchor(memories, { detail: '详细' }).text
  assert.ok(full.length > brief.length)
})

test('AN-05 no memories yields an empty anchor', () => {
  const anchor = buildAnchor([])
  assert.equal(anchor.text, '')
  assert.equal(anchor.memories, 0)
})
