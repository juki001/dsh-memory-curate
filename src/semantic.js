/**
 * Optional semantic retrieval layer.
 *
 * The plugin stays zero-config: the default is pure tag/trigger/BM25 recall and
 * nothing here runs. When a user configures an OpenAI-compatible `/embeddings`
 * endpoint the service embeds the query and the candidate memories, fuses the
 * vector ranking with the BM25 ranking through reciprocal rank fusion (RRF),
 * and falls back to BM25 on any failure. Vectors are cached in memory only:
 * the NDJSON store stays a plain, inspectable record of memories and audits.
 */

const DEFAULT_TIMEOUT_MS = 20000
const CACHE_LIMIT = 4096
const BATCH_SIZE = 32

/** Resolve an OpenAI-compatible embeddings endpoint from a base URL. */
export function resolveEmbeddingEndpoint (baseURL) {
  if (typeof baseURL !== 'string') return null
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return null
  if (trimmed.endsWith('/embeddings')) return trimmed
  return `${trimmed}/embeddings`
}

function readApiKey (envName) {
  if (typeof envName !== 'string' || envName.trim().length === 0) return undefined
  const value = process.env[envName.trim()]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Build one embedder over an OpenAI-compatible endpoint.
 *
 * `configured` is false when the base URL or model is missing; callers must
 * then keep using BM25 instead of attempting a network call.
 */
export function createEmbedder ({ baseURL, model, apiKeyEnv, timeoutMs } = {}) {
  const endpoint = resolveEmbeddingEndpoint(baseURL)
  const modelName = typeof model === 'string' ? model.trim() : ''
  const configured = endpoint !== null && modelName.length > 0
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  const cache = new Map()

  async function requestBatch (batch, signal) {
    const headers = { 'content-type': 'application/json' }
    const key = readApiKey(apiKeyEnv)
    if (key !== undefined) headers.authorization = `Bearer ${key}`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelName, input: batch }),
      signal: signal ?? AbortSignal.timeout(timeout)
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`embeddings HTTP ${response.status}: ${body.slice(0, 200)}`)
    }
    const payload = await response.json()
    const data = Array.isArray(payload?.data) ? payload.data : []
    if (data.length !== batch.length) {
      throw new Error(`embeddings returned ${data.length} vectors for ${batch.length} inputs`)
    }
    return data.map((entry, index) => {
      const vector = entry?.embedding
      if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
        throw new Error(`embeddings vector ${index} is malformed`)
      }
      return vector
    })
  }

  function remember (text, vector) {
    cache.set(text, vector)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  return {
    configured,
    endpoint,
    model: modelName,
    /** Cache hit count, for diagnostics and tests. */
    get cacheSize () { return cache.size },
    async embed (texts) {
      if (!configured) throw new Error('embeddings are not configured')
      const inputs = texts.map((text) => String(text ?? ''))
      const missing = [...new Set(inputs.filter((text) => !cache.has(text)))]
      for (let index = 0; index < missing.length; index += BATCH_SIZE) {
        const batch = missing.slice(index, index + BATCH_SIZE)
        const vectors = await requestBatch(batch)
        batch.forEach((text, offset) => remember(text, vectors[offset]))
      }
      return inputs.map((text) => cache.get(text))
    }
  }
}

/** Cosine similarity; zero when either vector is empty or degenerate. */
export function cosine (left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

/**
 * Reciprocal rank fusion over several ranked id lists.
 *
 * RRF is rank-based, so an embedding score with a different scale can be fused
 * with BM25 without calibrating the two distributions against each other.
 * @param {Array<{ids: string[], weight?: number}>} lists
 * @param {{k?: number}} [options]
 * @returns {Map<string, number>} fused score per id
 */
export function rrfFuse (lists, options = {}) {
  const k = Number.isFinite(options.k) && options.k > 0 ? options.k : 60
  const fused = new Map()
  for (const list of lists ?? []) {
    if (list === null || typeof list !== 'object' || !Array.isArray(list.ids)) continue
    const weight = Number.isFinite(list.weight) && list.weight > 0 ? list.weight : 1
    list.ids.forEach((id, rank) => {
      if (typeof id !== 'string') return
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + rank + 1))
    })
  }
  return fused
}
