/**
 * Protected-window computation over the current session surface.
 *
 * The window is anchored on real human user messages only: runtime-context
 * snapshots, compaction checkpoints and tool traffic never count as turns. The
 * window starts at the N-th most recent human message (N = protectTurns) and
 * protects every surface node from there to the tail. When fewer human
 * messages exist, the earliest one starts the window, so a new session
 * protects everything it has.
 */
export function humanMessageSeqs (session) {
  const seqs = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = event.data?.source ?? event.data?.message?.source
    if (source?.kind === 'user') seqs.push(seq)
  }
  return seqs
}

export function computeProtectedWindow (session, protectTurns = 5) {
  const turns = Math.max(1, Math.floor(protectTurns))
  const nodes = [...session.surface.nodes]
  const humans = humanMessageSeqs(session)
  if (humans.length === 0) {
    return { start: null, startIndex: null, humans, protectedSeqs: [], protected: false }
  }
  const start = humans[Math.max(0, humans.length - turns)]
  const startIndex = nodes.indexOf(start)
  return {
    start,
    startIndex,
    humans,
    protectedSeqs: startIndex < 0 ? [] : nodes.slice(startIndex),
    protected: true
  }
}

/**
 * Seq of the surface node 0 `system/message` — the host's protected head.
 *
 * A compaction range that starts there is accepted by the compaction engine,
 * which appends `compaction/summary` first and only then applies the surface
 * replacement; the replacement is rejected by the session core (node 0 may be
 * rewritten only by a `system/message` over exactly that node). The summary is
 * already on disk by then, so every later resume fails the v4 format check
 * "compaction cannot shadow the protected system head". Ranges must therefore
 * start after node 0 whenever it holds the system prompt.
 *
 * Only node 0 is protected: later `system/message` nodes may be shadowed.
 */
export function protectedHeadSeq (session) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  return session.eventAt(nodes[0])?.type === 'system/message' ? nodes[0] : null
}

/** True when `seq` belongs to the protected tail of the current surface. */
export function isProtected (window, seq) {
  if (window.start === null) return false
  return seq >= window.start
}

/** Human messages of the most recent turn (window start to the tail). */
export function recentHumanText (session, protectTurns = 5, limit = 4000) {
  const window = computeProtectedWindow(session, protectTurns)
  const parts = []
  for (const seq of window.protectedSeqs) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    parts.push(textOf(event.data.message ?? event.data))
  }
  return parts.join('\n').slice(-limit)
}

function textOf (message) {
  const blocks = message?.content ?? []
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}
