/**
 * Non-destructive consolidation proposals.
 *
 * Memories accumulate as independent assertions. This module finds pairs that
 * are close enough to overlap (same convention recorded twice, or two rows that
 * contradict each other) and describes the fix as a *proposal*. Nothing is
 * overwritten: applying a proposal is an explicit admin action that appends a
 * superseding row, so the audit trail keeps both the old and the new statement.
 */

const NEGATIVE = [
  /不要/, /禁用/, /禁止/, /别用/, /绝不/, /避免/, /不允许/, /不再/, /废弃/,
  /\bnever\b/i, /\bavoid\b/i, /\bdisable[ds]?\b/i, /\bdeprecated\b/i, /\bdo not\b/i, /\bdon't\b/i
]

const POSITIVE = [
  /必须/, /启用/, /统一/, /默认/, /要求/, /应当/, /一定要/, /优先/,
  /\balways\b/i, /\bmust\b/i, /\benable[ds]?\b/i, /\bprefer\b/i, /\buse\b/i, /\bshould\b/i
]

/** -1 = prohibition, 1 = requirement, 0 = neutral.
 * An explicit negation marker wins over requirement wording: "默认不要启用 X"
 * is a prohibition even though it also contains 启用 and 默认. */
export function polarity (text) {
  const value = String(text ?? '')
  if (NEGATIVE.some((pattern) => pattern.test(value))) return -1
  if (POSITIVE.some((pattern) => pattern.test(value))) return 1
  return 0
}

/** True when two statements pull in opposite directions. */
export function contradictions (leftText, rightText) {
  const left = polarity(leftText)
  const right = polarity(rightText)
  return left !== 0 && right !== 0 && left !== right
}

/** Stable key for one unordered pair, so re-runs do not duplicate proposals. */
export function pairKey (leftId, rightId) {
  const ids = [String(leftId), String(rightId)].sort()
  return ids.join('|')
}

/**
 * Propose merge/conflict candidates among a memory set.
 *
 * @param {Array<object>} memories - active rows.
 * @param {{minSimilarity?: number, limit?: number, similarityFn: (a: object, b: object) => number}} options
 * @returns {Array<{key: string, action: 'merge'|'conflict', targetIds: string[], similarity: number, rationale: string}>}
 */
export function proposePairs (memories, options) {
  const rows = Array.isArray(memories) ? memories : []
  const similarityFn = options.similarityFn
  if (typeof similarityFn !== 'function') throw new Error('proposePairs: similarityFn is required')
  const minSimilarity = Number.isFinite(options.minSimilarity) ? options.minSimilarity : 0.55
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5
  const pairs = []
  for (let left = 0; left < rows.length; left++) {
    for (let right = left + 1; right < rows.length; right++) {
      const a = rows[left]
      const b = rows[right]
      if (typeof a?.id !== 'string' || typeof b?.id !== 'string') continue
      const score = similarityFn(a, b)
      if (!(score >= minSimilarity)) continue
      const conflict = contradictions(a.text, b.text)
      pairs.push({
        key: pairKey(a.id, b.id),
        action: conflict ? 'conflict' : 'merge',
        targetIds: [a.id, b.id],
        similarity: Number(score.toFixed(4)),
        rationale: conflict
          ? '两条记忆高度相似但一正一反，建议确认后合并为一条明确表述'
          : '两条记忆高度相似，建议确认后合并为一条，旧行保留在审计里'
      })
    }
  }
  pairs.sort((left, right) => {
    if (right.similarity !== left.similarity) return right.similarity - left.similarity
    return left.key.localeCompare(right.key)
  })
  return pairs.slice(0, limit)
}

/**
 * Default proposal text. The plugin never invents a merged statement on its
 * own: it keeps the higher-importance row (then the longer text) verbatim and
 * lets the user/model accept or edit it before applying.
 */
export function suggestedText (left, right) {
  if (left === null || left === undefined) return right?.text ?? ''
  if (right === null || right === undefined) return left.text ?? ''
  const leftImportance = Number(left.importance ?? 3)
  const rightImportance = Number(right.importance ?? 3)
  if (rightImportance > leftImportance) return right.text
  if (leftImportance > rightImportance) return left.text
  const leftLength = Array.from(String(left.text ?? '')).length
  const rightLength = Array.from(String(right.text ?? '')).length
  return rightLength > leftLength ? right.text : left.text
}
