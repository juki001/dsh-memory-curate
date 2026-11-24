/**
 * Anchor text for the system prompt: tags, a few trigger words and counts.
 *
 * Deliberately tiny and body-free: the model gets a map of what exists and
 * calls `memory_curate_recall` for the actual text. Keeping the anchor stable
 * (identical bytes while memories are unchanged) preserves the provider's
 * prefix cache.
 */
const DETAIL_TRIGGERS = { '精简': 1, '标准': 3, '详细': 5 }

export function buildAnchor (memories, options = {}) {
  const maxChars = options.maxChars ?? 400
  const detail = options.detail ?? '标准'
  const triggerLimit = DETAIL_TRIGGERS[detail] ?? 3
  const groups = new Map()
  for (const memory of memories) {
    for (const tag of memory.tags ?? []) {
      const key = String(tag).trim()
      if (key.length === 0) continue
      const group = groups.get(key) ?? { tag: key, count: 0, triggers: new Map() }
      group.count++
      for (const trigger of memory.triggers ?? []) {
        const text = String(trigger).trim()
        if (text.length === 0) continue
        group.triggers.set(text, (group.triggers.get(text) ?? 0) + 1)
      }
      groups.set(key, group)
    }
  }
  const ordered = [...groups.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count
    return left.tag.localeCompare(right.tag)
  })
  if (ordered.length === 0) return { text: '', truncated: false, tags: 0, memories: memories.length }
  const header = `记忆锚点（${memories.length} 条，按标签聚合；需要正文时调用 memory_curate_recall）：`
  const lines = []
  let used = codePoints(header)
  let truncated = false
  for (const group of ordered) {
    const triggers = [...group.triggers.entries()]
      .sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1]
        return left[0].localeCompare(right[0])
      })
      .slice(0, triggerLimit)
      .map(([text]) => text)
    const line = `- ${group.tag}(${group.count})` + (triggers.length > 0 ? ` ← ${triggers.join('/')}` : '')
    const cost = codePoints(line) + 1
    if (used + cost > maxChars) {
      truncated = true
      continue
    }
    lines.push(line)
    used += cost
  }
  return {
    text: lines.length === 0 ? '' : header + '\n' + lines.join('\n'),
    truncated,
    tags: ordered.length,
    memories: memories.length
  }
}

function codePoints (text) {
  return Array.from(text).length
}
