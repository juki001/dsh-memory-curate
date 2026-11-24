import { computeProtectedWindow, protectedHeadSeq } from './window.js'
import { deriveTags, extractEntities } from './prompt.js'

/**
 * Choose the largest legal span the plugin is willing to hand to the host
 * compaction engine.
 *
 * The plugin never lets the engine choose the range: it computes the span
 * itself from the current surface, cuts it strictly before the protected
 * window, and requires a real multi-node span with meaningful content. That
 * filtering right is what keeps the protected turns out of the summary even
 * though the host has no "skip these seqs" parameter.
 */
export function selectCompactionRegion (session, window, tokenMeter, options = {}) {
  const minTokens = options.minTokens ?? 120
  const nodes = [...session.surface.nodes]
  const protectedIndex = window.startIndex === null ? nodes.length : window.startIndex
  const firstIndex = protectedHeadSeq(session) === null ? 0 : 1
  const candidates = nodes.slice(firstIndex, protectedIndex)
  if (candidates.length < 2) return null
  const start = candidates[0]
  const end = candidates[candidates.length - 1]
  let tokens = 0
  try {
    const measurement = tokenMeter.measure(session)
    const bySeq = new Map(measurement.nodes.map((node) => [node.seq, node.tokens]))
    for (const seq of candidates) tokens += bySeq.get(seq) ?? 0
  } catch {
    tokens = candidates.length * 100
  }
  if (tokens < minTokens) return null
  return { start, end, seqs: candidates, tokens }
}

/** Flattened text of a span, bounded so gate checks stay cheap. */
export function regionText (session, seqs, limit = 4000) {
  const parts = []
  for (const seq of seqs) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.join('\n').length > limit) break
  }
  return parts.join('\n').slice(0, limit)
}

/** Core entities of a span, falling back to derived tags. */
export function regionQuery (text) {
  const entities = extractEntities(text)
  if (entities.length > 0) return entities.slice(0, 8).join(' ')
  const derived = deriveTags(text)
  return [...derived.tags, ...derived.triggers].slice(0, 8).join(' ')
}

/** Resolve the routed provider/model of the latest request. */
export function routedTarget (session) {
  const config = session?.requestHeader?.()?.config
  if (config === undefined || config === null) return null
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
  if (config.provider.length === 0 || config.model.length === 0) return null
  return { provider: config.provider, model: config.model }
}

export { computeProtectedWindow }
