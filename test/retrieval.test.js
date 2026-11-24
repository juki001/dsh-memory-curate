import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../src/tokenize.js'
import { bm25Scores } from '../src/bm25.js'
import { recall, buildIndex, duplicates, similarity, WEIGHTS } from '../src/retrieval.js'

const memory = (overrides) => ({
  id: overrides.id ?? 'm_1',
  text: overrides.text ?? '',
  tags: overrides.tags ?? [],
  triggers: overrides.triggers ?? [],
  entities: overrides.entities ?? [],
  updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  ...overrides
})

test('BM25-01 score matches the hand-computed Okapi value', () => {
  const scores = bm25Scores(['alpha'], [['alpha', 'beta'], ['gamma', 'delta']])
  const expected = Math.log(2) * (1 * 2.2) / (1 + 1.2 * (1 - 0.75 + 0.75 * 1))
  assert.ok(Math.abs(scores[0] - expected) < 1e-9)
  assert.equal(scores[1], 0)
  assert.equal(WEIGHTS.tag, 0.35)
  assert.equal(WEIGHTS.trigger, 0.35)
  assert.equal(WEIGHTS.bm25, 0.30)
})

test('tokenizer keeps 2-grams and the whole CJK run', () => {
  const tokens = tokenize('记忆插件')
  assert.deepEqual(tokens, ['记忆', '忆插', '插件', '记忆插件'])
})

test('RC-01 recall reports why a memory matched', () => {
  const memories = [
    memory({ id: 'm_a', text: '安装依赖统一使用 pnpm', tags: ['构建'], triggers: ['安装依赖'] }),
    memory({ id: 'm_b', text: '提交信息使用祈使句', tags: ['规范'], triggers: ['提交信息'] })
  ]
  const result = recall('安装依赖用 pnpm', memories)
  assert.equal(result.hits[0].id, 'm_a')
  assert.ok(result.hits[0].why.triggers.length > 0)
  assert.equal(result.hits[0].why.tags.includes('构建'), false)
  assert.ok(result.hits[0].why.bm25 >= 0)
})

test('RC-02 tag match outranks an otherwise identical trigger match', () => {
  const memories = [
    memory({ id: 'm_tag', text: '同一句约定', tags: ['构建'], triggers: [], updatedAt: '2026-01-01T00:00:00.000Z' }),
    memory({ id: 'm_trigger', text: '同一句约定', tags: [], triggers: ['构建'], updatedAt: '2026-01-01T00:00:00.000Z' })
  ]
  const result = recall('构建', memories)
  assert.equal(result.hits[0].id, 'm_tag')
})

test('RC-03 same score falls back to newest updatedAt', () => {
  const memories = [
    memory({ id: 'm_old', text: '同一句约定', tags: ['构建'], updatedAt: '2026-01-01T00:00:00.000Z' }),
    memory({ id: 'm_new', text: '同一句约定', tags: ['构建'], updatedAt: '2026-02-01T00:00:00.000Z' })
  ]
  const result = recall('构建', memories)
  assert.equal(result.hits[0].id, 'm_new')
})

test('RC-04 empty and unrelated queries yield no hits', () => {
  const memories = [memory({ id: 'm_a', text: '安装依赖统一使用 pnpm', tags: ['构建'] })]
  assert.deepEqual(recall('', memories), { hits: [], totalHits: 0 })
  assert.equal(recall('量子纠缠', memories).hits.length, 0)
})

test('RC-05 limit caps hits but totalHits counts all matches', () => {
  const memories = Array.from({ length: 5 }, (_, index) =>
    memory({ id: `m_${index}`, text: `约定条目 ${index}`, tags: ['构建'] }))
  const result = recall('构建', memories, { limit: 2 })
  assert.equal(result.hits.length, 2)
  assert.equal(result.totalHits, 5)
})

test('pre-tokenized docs produce identical rankings', () => {
  const memories = [
    memory({ id: 'm_a', text: '安装依赖统一使用 pnpm', tags: ['构建'], triggers: ['安装依赖'] }),
    memory({ id: 'm_b', text: '提交信息使用祈使句', tags: ['规范'], triggers: ['提交信息'] })
  ]
  const plain = recall('安装依赖用 pnpm', memories)
  const cached = recall('安装依赖用 pnpm', memories, { index: buildIndex(memories) })
  assert.deepEqual(cached, plain)
  assert.equal(buildIndex(memories).size, memories.length)
})

test('duplicate detection uses containment similarity', () => {
  const stored = [memory({ id: 'm_a', text: '默认使用 pnpm 安装依赖', tags: ['构建'], triggers: ['安装'] })]
  const same = { text: '默认使用 pnpm 安装依赖', tags: ['构建'], triggers: ['安装'] }
  assert.ok(similarity(same, stored[0]) >= 0.82)
  assert.equal(duplicates(same, stored).length, 1)
  assert.equal(duplicates({ text: '完全无关的一句话', tags: [], triggers: [] }, stored).length, 0)
})
