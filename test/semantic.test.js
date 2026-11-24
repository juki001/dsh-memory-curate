import test from 'node:test'
import assert from 'node:assert/strict'
import { cosine, rrfFuse, resolveEmbeddingEndpoint, createEmbedder } from '../src/semantic.js'
import { tempStore, makeCurateService } from './helpers.js'

test('SEM-01 cosine handles orthogonal, parallel and malformed vectors', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([], [1]), 0)
  assert.equal(cosine([1, 2], [1]), 0)
})

test('SEM-02 RRF fuses rank lists by rank, not raw scale', () => {
  const fused = rrfFuse([
    { ids: ['a', 'b'], weight: 1 },
    { ids: ['b', 'c'], weight: 1 }
  ])
  assert.ok(fused.get('b') > fused.get('a'))
  assert.ok(fused.get('b') > fused.get('c'))
  assert.ok(fused.get('a') > 0)
  assert.equal(fused.get('z'), undefined)
})

test('SEM-03 embedding endpoints resolve from base URLs', () => {
  assert.equal(resolveEmbeddingEndpoint('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1/embeddings')
  assert.equal(resolveEmbeddingEndpoint('https://api.example.com/v1/embeddings'), 'https://api.example.com/v1/embeddings')
  assert.equal(resolveEmbeddingEndpoint(''), null)
  assert.equal(resolveEmbeddingEndpoint(undefined), null)
})

test('SEM-04 the embedder batches, caches and validates payloads', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    return {
      ok: true,
      async json () {
        return { data: body.input.map(() => ({ embedding: [1, 0] })) }
      }
    }
  }
  try {
    const embedder = createEmbedder({ baseURL: 'http://127.0.0.1:1234/v1', model: 'local-embed' })
    assert.equal(embedder.configured, true)
    const vectors = await embedder.embed(['a', 'b', 'a'])
    assert.equal(vectors.length, 3)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/embeddings')
    assert.deepEqual(calls[0].body.input, ['a', 'b'])
    await embedder.embed(['a'])
    assert.equal(calls.length, 1, 'second call must come from cache')
  } finally {
    globalThis.fetch = original
  }
})

test('SEM-05 a malformed embedding payload rejects instead of poisoning the cache', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: ['x'] }] }) })
  try {
    const embedder = createEmbedder({ baseURL: 'http://127.0.0.1:1234/v1', model: 'local-embed' })
    await assert.rejects(() => embedder.embed(['a']), /malformed/)
    assert.equal(embedder.cacheSize, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('SEM-06 hybrid recall falls back to BM25 and audits the failure', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.saveMemory({ text: '默认使用 pnpm 安装依赖', tags: ['构建'], sessionId: 's1' })
    const service = makeCurateService({
      store,
      config: { retrievalMode: 'hybrid', embeddingBaseURL: 'http://127.0.0.1:9/v1', embeddingModel: 'm' }
    })
    service.semantic.embedder = { configured: true, embed: async () => { throw new Error('boom') } }
    const result = await service.recallWithAudit({ query: 'pnpm 安装', limit: 5 })
    assert.ok(result.hits.length > 0)
    assert.equal(result.hits[0].id.startsWith('m_'), true)
    const audit = store.auditRows().filter((row) => row.op === 'recall').at(-1)
    assert.equal(audit.mode, 'hybrid')
    assert.match(audit.fallback, /boom/)
  } finally { await cleanup() }
})

test('SEM-07 fusion surfaces a paraphrase that BM25 cannot match', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const target = await store.saveMemory({ text: '发布前必须先跑自检脚本', tags: ['流程'], sessionId: 's1' })
    const service = makeCurateService({
      store,
      config: { retrievalMode: 'hybrid', embeddingBaseURL: 'http://x/v1', embeddingModel: 'm', embeddingWeight: 0.5 }
    })
    service.semantic.embedder = {
      configured: true,
      async embed (texts) {
        return texts.map((text) => (/自检|校验/.test(text) ? [1, 0] : [0, 1]))
      }
    }
    const bm25Only = service.recall('上线前校验', 5)
    assert.equal(bm25Only.hits.length, 0, 'token overlap must be empty for this fixture')
    const result = await service.recallWithAudit({ query: '上线前校验', limit: 5 })
    assert.equal(result.hits[0].id, target.id)
    assert.ok(result.hits[0].why.cosine > 0)
    assert.equal(result.hits[0].why.bm25Rank, null)
  } finally { await cleanup() }
})
