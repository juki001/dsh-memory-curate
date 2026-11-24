import { tokenize } from './tokenize.js'

export const WEIGHTS = Object.freeze({ tag: 0.35, trigger: 0.35, bm25: 0.30 })
const BM25_K1 = 1.2
const BM25_B = 0.75
const DEFAULT_DECAY_HALF_LIFE_DAYS = 90
const DECAY_FLOOR = 0.25

/**
 * Recency weight for one memory: half-life decay over `lastUsedAt` (or the last
 * update when it was never recalled), floored so an old-but-correct convention
 * never disappears from the candidate set.
 */
export function recencyFactor (memory, nowMs, halfLifeDays = DEFAULT_DECAY_HALF_LIFE_DAYS) {
  if (!(halfLifeDays > 0)) return 1
  const reference = Date.parse(memory?.lastUsedAt ?? memory?.updatedAt ?? memory?.ts ?? '')
  if (!Number.isFinite(reference)) return 1
  const ageDays = Math.max(0, (nowMs - reference) / 86400000)
  return Math.max(DECAY_FLOOR, Math.pow(0.5, ageDays / halfLifeDays))
}

/** Importance 1..5 maps to 0.6..1.0 so an untagged row keeps a neutral rank. */
export function importanceFactor (memory) {
  const raw = Number(memory?.importance ?? 3)
  const importance = Number.isFinite(raw) ? Math.min(5, Math.max(1, raw)) : 3
  return 0.6 + 0.4 * ((importance - 1) / 4)
}

function normalizeText (value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

function matches (tokens, values) {
  const hits = []
  for (const token of tokens) {
    for (const value of values) {
      if (value.includes(token)) {
        hits.push(token)
        break
      }
    }
  }
  return [...new Set(hits)]
}

/**
 * Build the reusable search index for one stable memory set.
 *
 * The service caches this per NDJSON store revision, so a query no longer
 * re-tokenizes every memory: it looks up term postings, the precomputed BM25
 * lengths, and normalized tag/trigger strings. The index is a plain object so
 * callers can rebuild it after an update/delete and drop the old one.
 *
 * @param {Array<object>} memories - active memory rows.
 */
export function buildIndex (memories) {
  const n = memories.length
  const lengths = new Array(n)
  const tagTexts = new Array(n)
  const triggerTexts = new Array(n)
  const postings = new Map()
  let totalLength = 0
  for (let index = 0; index < n; index++) {
    const memory = memories[index]
    const tokens = tokenize([
      memory.text,
      ...(memory.tags ?? []),
      ...(memory.triggers ?? []),
      ...(memory.entities ?? [])
    ].join('\n'))
    lengths[index] = tokens.length
    totalLength += tokens.length
    tagTexts[index] = (memory.tags ?? []).map(normalizeText)
    triggerTexts[index] = (memory.triggers ?? []).map(normalizeText)
    const frequencies = new Map()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    for (const [term, tf] of frequencies) {
      let list = postings.get(term)
      if (list === undefined) {
        list = []
        postings.set(term, list)
      }
      list.push([index, tf])
    }
  }
  return {
    size: n,
    lengths,
    averageLength: n === 0 ? 0 : totalLength / n,
    tagTexts,
    triggerTexts,
    postings
  }
}

function bm25FromIndex (tokens, index) {
  const { size, lengths, averageLength, postings } = index
  const scores = new Float64Array(size)
  if (size === 0 || averageLength === 0) return scores
  for (const term of new Set(tokens)) {
    const list = postings.get(term)
    if (list === undefined) continue
    const df = list.length
    const idf = Math.log(1 + (size - df + 0.5) / (df + 0.5))
    for (const [docIndex, tf] of list) {
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (lengths[docIndex] / averageLength))
      scores[docIndex] += idf * ((tf * (BM25_K1 + 1)) / denominator)
    }
  }
  return scores
}

/**
 * Rank active memories for one query.
 *
 * Three independent signals are combined with fixed weights: tag match (0.35),
 * trigger-word match (0.35) and BM25 (0.30). BM25 is normalized by the best
 * score in the candidate set so one unusually long memory cannot dominate
 * through raw score scale. The combined score is then scaled by importance
 * (0.6..1.0) and by a floored recency half-life, so old-but-correct memories
 * stay reachable while recently reinforced rows rank first. The returned `why`
 * object is what the recall audit stores, so a later reader can see why a row
 * surfaced without replaying the scorer.
 *
 * @param {string} query
 * @param {Array<object>} memories - active memory rows.
 * @param {{limit?: number, index?: object, now?: number, decayHalfLifeDays?: number, includeExpired?: boolean, minScore?: number}} [options] - index must be built from these memories.
 */
export function recall (query, memories, options = {}) {
  const tokens = tokenize(query)
  const includeExpired = options.includeExpired === true
  const candidates = includeExpired ? memories : memories.filter((memory) => memory?.status !== 'expired')
  if (tokens.length === 0 || candidates.length === 0) {
    return { hits: [], totalHits: 0 }
  }
  const index = options.index ?? buildIndex(candidates)
  if (index.size !== candidates.length) throw new Error('recall: index does not match the supplied memories')
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now()
  const halfLife = Number.isFinite(options.decayHalfLifeDays) ? options.decayHalfLifeDays : DEFAULT_DECAY_HALF_LIFE_DAYS
  const minScore = Number.isFinite(options.minScore) && options.minScore > 0 ? options.minScore : 0
  const raw = bm25FromIndex(tokens, index)
  const maxRaw = raw.reduce((max, value) => Math.max(max, value), 0)
  const scored = candidates.map((memory, docIndex) => {
    const tagHits = matches(tokens, index.tagTexts[docIndex])
    const triggerHits = matches(tokens, index.triggerTexts[docIndex])
    const tagScore = tagHits.length / tokens.length
    const triggerScore = triggerHits.length / tokens.length
    const bm25Score = maxRaw > 0 ? raw[docIndex] / maxRaw : 0
    const base = WEIGHTS.tag * tagScore + WEIGHTS.trigger * triggerScore + WEIGHTS.bm25 * bm25Score
    const decay = recencyFactor(memory, nowMs, halfLife)
    const importance = importanceFactor(memory)
    const score = base * decay * importance
    return {
      memory,
      score,
      tagHits: tagHits.length,
      why: {
        tags: tagHits,
        triggers: triggerHits,
        bm25: raw[docIndex],
        terms: tokens,
        base: Number(base.toFixed(6)),
        decay: Number(decay.toFixed(6)),
        importance: Number(importance.toFixed(6))
      }
    }
  }).filter((entry) => entry.score > 0 && entry.score >= minScore)
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (right.tagHits !== left.tagHits) return right.tagHits - left.tagHits
    const leftAt = left.memory.updatedAt ?? left.memory.ts ?? ''
    const rightAt = right.memory.updatedAt ?? right.memory.ts ?? ''
    if (rightAt !== leftAt) return rightAt.localeCompare(leftAt)
    return String(left.memory.id).localeCompare(String(right.memory.id))
  })
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : scored.length
  return {
    hits: scored.slice(0, limit).map((entry) => ({
      id: entry.memory.id,
      text: entry.memory.text,
      tags: entry.memory.tags ?? [],
      triggers: entry.memory.triggers ?? [],
      importance: entry.memory.importance ?? 3,
      status: entry.memory.status ?? 'active',
      validUntil: entry.memory.validUntil ?? null,
      lastUsedAt: entry.memory.lastUsedAt ?? null,
      score: Number(entry.score.toFixed(6)),
      why: entry.why
    })),
    totalHits: scored.length
  }
}

/** Score one memory against another for duplicate detection. */
export function similarity (left, right) {
  const a = new Set(tokenize([left.text, ...(left.tags ?? []), ...(left.triggers ?? [])].join('\n')))
  const b = new Set(tokenize([right.text, ...(right.tags ?? []), ...(right.triggers ?? [])].join('\n')))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / Math.min(a.size, b.size)
}

/** Find active memories close enough to a candidate write to warn about duplication. */
export function duplicates (candidate, memories, threshold = 0.82) {
  return memories
    .map((memory) => ({ id: memory.id, score: similarity(candidate, memory), text: memory.text }))
    .filter((entry) => entry.score >= threshold)
    .sort((left, right) => right.score - left.score)
}
