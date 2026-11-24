/**
 * Deterministic tool-result folding with a protected recent-turn window.
 *
 * The folding algorithm is byte-compatible with the host's
 * `dsh-compaction-tool-result-pruner` (head 4096 + marker + tail 1024 over
 * Unicode code points) so a user who already knows the host behaviour sees the
 * same output. Every replacement is preceded by a `compaction/prune`
 * shadow-price event priced through the injected token meter; without that
 * event pure consumers such as `tokenMeter` would over-count the surface.
 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
export const PRUNE_DEFAULTS = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })

export function codePointLength (text) {
  return Array.from(text).length
}

export function measureContent (blocks) {
  let chars = 0
  for (const block of blocks ?? []) if (block.type === 'text') chars += codePointLength(block.text)
  return chars
}

/**
 * Return folded content (or null when under budget).
 * Copy of the host algorithm: text is sliced by code point, rich blocks keep
 * their order, and exactly one marker replaces the removed middle span.
 */
export function pruneContent (blocks, config = PRUNE_DEFAULTS) {
  const { thresholdChars, headChars, tailChars } = { ...PRUNE_DEFAULTS, ...config }
  const totalChars = measureContent(blocks)
  if (totalChars <= thresholdChars) return null
  const removedStart = headChars
  const removedEnd = totalChars - tailChars
  const pruned = []
  let consumed = 0
  let markerInserted = false
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : ''
    if (marker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }
  if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
  return pruned
}

/**
 * Fold every over-budget tool result outside the protected window.
 *
 * @param {object} input
 * @param {object} input.session - live session
 * @param {object} input.tokenMeter - ctx.tokenMeter
 * @param {object} input.protectedWindow - result of computeProtectedWindow
 * @param {boolean} [input.protectToolResults] - keep protected results untouched
 * @returns {{pruned: Array, skipped: Array, charsRemoved: number}}
 */
export function foldToolResults ({ session, tokenMeter, protectedWindow, protectToolResults = false, config = PRUNE_DEFAULTS }) {
  const candidates = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/result') candidates.push({ seq, event })
  }
  const pruned = []
  const skipped = []
  let charsRemoved = 0
  for (const { seq, event } of candidates) {
    const original = session.deriveEventMessage(event)
    const content = pruneContent(original.content, config)
    if (content === null) continue
    const inWindow = protectedWindow.start !== null && seq >= protectedWindow.start
    if (protectToolResults && inWindow) {
      skipped.push({ seq, reason: 'protected' })
      continue
    }
    const charsBefore = measureContent(original.content)
    const charsAfter = measureContent(content)
    const message = structuredClone({ ...original, content })
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: tokenMeter.estimateMessage(original)
    })
    const replacement = session.append('tool/result', {
      ...event.data,
      message
    }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq]
    })
    pruned.push({
      originalSeq: seq,
      replacementSeq: replacement.seq,
      callId: event.data?.message?.source?.callId,
      charsBefore,
      charsAfter,
      protected: inWindow
    })
    charsRemoved += charsBefore - charsAfter
  }
  return { pruned, skipped, charsRemoved }
}
