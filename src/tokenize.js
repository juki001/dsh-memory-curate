/**
 * Deterministic tokenizer for mixed Chinese/ASCII memory text.
 *
 * Chinese has no word delimiter, so every CJK run contributes its 2-grams plus
 * the whole run (a long query keeps a chance to match an identical stored
 * phrase). ASCII runs contribute whole lower-cased words. No language model and
 * no dictionary: the same text always yields the same tokens across processes.
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const WORD = /[a-z0-9_]+/g

export function tokenize (input) {
  const text = String(input ?? '').normalize('NFKC').toLowerCase()
  const tokens = []
  const seen = new Set()
  const push = (token) => {
    if (token.length === 0 || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }
  for (const word of text.match(WORD) ?? []) push(word)
  for (const run of text.match(CJK) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) {
      push(chars[0])
      continue
    }
    for (let index = 0; index + 1 < chars.length; index++) push(chars[index] + chars[index + 1])
    push(run)
  }
  return tokens
}

/** Tokens minus the raw-run gram, used for symmetric term comparisons. */
export function queryTokens (input) {
  return tokenize(input)
}
