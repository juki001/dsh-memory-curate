/**
 * Okapi BM25 over already-tokenized documents.
 *
 * Parameters are fixed (k1 = 1.2, b = 0.75) so the value is reproducible and
 * can be asserted by unit tests. Ties are resolved by the caller.
 */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

/**
 * @param {string[]} query - query terms (duplicates allowed; they act as term weight).
 * @param {string[][]} docs - one token array per document.
 * @returns {number[]} score per document.
 */
export function bm25Scores (query, docs) {
  const n = docs.length
  if (n === 0) return []
  const lengths = docs.map((doc) => doc.length)
  const avg = lengths.reduce((sum, value) => sum + value, 0) / n
  const terms = [...new Set(query)]
  const scores = new Array(n).fill(0)
  if (avg === 0) return scores
  for (const term of terms) {
    let df = 0
    for (const doc of docs) if (doc.includes(term)) df++
    if (df === 0) continue
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    for (let i = 0; i < n; i++) {
      const doc = docs[i]
      let tf = 0
      for (const token of doc) if (token === term) tf++
      if (tf === 0) continue
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (lengths[i] / avg))
      scores[i] += idf * ((tf * (BM25_K1 + 1)) / denom)
    }
  }
  return scores
}
