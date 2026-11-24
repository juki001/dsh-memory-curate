#!/usr/bin/env node
/**
 * Convert the official LoCoMo file (locomo10.json) to the JSONL schema consumed
 * by bench/eval.mjs.
 *
 * Choice: one memory row per dialogue turn (not per session summary). LoCoMo
 * evidence is expressed as dia_id values, so turn rows give a direct
 * question -> evidence mapping. Memory id = "<sample_id>:<dia_id>"; text =
 * "[session date] speaker: utterance"; QA evidence becomes gold. One
 * whole-corpus JSON object is emitted per conversation to keep LoCoMo's
 * per-conversation evaluation boundary (eval.mjs accepts several corpus lines).
 *
 * The script never downloads data.
 *
 * Usage:
 *   node bench/locomo-to-jsonl.mjs <path/to/locomo10.json> [--out bench/datasets/locomo.jsonl]
 * Without --out, JSONL goes to stdout and statistics to stderr.
 */
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'

const USAGE = 'Usage: node bench/locomo-to-jsonl.mjs <locomo10.json> [--out path.jsonl]'
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message) => { throw new Error(message) }
const need = (value, where) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${where} must be a non-empty string`)
  return value.trim()
}
const sessionNo = (key) => Number(/^session_(\d+)$/.exec(key)[1])

function parseArgs (argv) {
  const out = { input: null, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--help' || raw === '-h') { out.help = true; continue }
    if (raw === '--out') {
      const value = argv[++i]
      if (value === undefined || value === '') fail('--out requires a path')
      out.out = resolve(process.cwd(), value)
    } else if (raw.startsWith('--out=')) {
      const value = raw.slice('--out='.length)
      if (!value) fail('--out requires a path')
      out.out = resolve(process.cwd(), value)
    } else if (raw.startsWith('--')) {
      fail(`unknown option: ${raw}`)
    } else if (out.input === null) {
      out.input = resolve(process.cwd(), raw)
    } else {
      fail(`unexpected argument: ${raw}`)
    }
  }
  if (!out.help && out.input === null) fail('missing <locomo10.json> path')
  return out
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(USAGE + '\n'); return }
  if (options.out === options.input) fail('--out must differ from the input file')
  let raw
  try {
    raw = await fs.readFile(options.input, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${options.input}: ${error?.message ?? error}\nPass the official LoCoMo locomo10.json path; this script never downloads datasets.`)
  }
  let data
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (error) {
    throw new Error(`input is not valid JSON: ${error?.message ?? error}`)
  }
  if (!Array.isArray(data)) throw new Error('input must be a JSON array of LoCoMo conversation samples')
  if (data.length === 0) throw new Error('input array is empty')

  const stats = { samples: 0, memories: 0, queries: 0, noEvidence: 0, unresolved: 0, emptyTurns: 0, skippedSamples: 0 }
  const sampleIds = new Set()
  const corpora = []
  for (let si = 0; si < data.length; si++) {
    const sample = data[si]
    const sampleId = need(sample?.sample_id, `sample[${si}].sample_id`)
    if (sampleIds.has(sampleId)) fail(`duplicate sample_id "${sampleId}"`)
    sampleIds.add(sampleId)
    const conversation = sample?.conversation
    if (!plain(conversation)) fail(`sample "${sampleId}": conversation must be an object`)
    const keys = Object.keys(conversation)
      .filter((key) => /^session_\d+$/.test(key))
      .sort((a, b) => sessionNo(a) - sessionNo(b))
    if (keys.length === 0) fail(`sample "${sampleId}": no session_<n> arrays`)
    const memories = []
    const byDia = new Map()
    for (const key of keys) {
      const turns = conversation[key]
      if (!Array.isArray(turns)) fail(`sample "${sampleId}": conversation.${key} must be an array`)
      const date = conversation[`${key}_date_time`]
      if (date !== undefined && typeof date !== 'string') fail(`sample "${sampleId}": conversation.${key}_date_time must be a string`)
      const number = sessionNo(key)
      for (let ti = 0; ti < turns.length; ti++) {
        const turn = turns[ti]
        const where = `sample "${sampleId}" ${key} turn #${ti + 1}`
        if (!plain(turn)) fail(`${where}: expected an object`)
        const dia = need(turn.dia_id, `${where}.dia_id`)
        const speaker = need(turn.speaker, `${where}.speaker`)
        if (turn.text !== undefined && typeof turn.text !== 'string') fail(`${where}.text must be a string`)
        const text = typeof turn.text === 'string' ? turn.text.trim() : ''
        if (!text) { stats.emptyTurns += 1; continue }
        if (byDia.has(dia)) fail(`sample "${sampleId}": duplicate dia_id "${dia}"`)
        const id = `${sampleId}:${dia}`
        const prefix = date && date.trim() ? `[${date.trim()}] ` : ''
        memories.push({ id, text: `${prefix}${speaker}: ${text}`, tags: [speaker, `session-${number}`] })
        byDia.set(dia, id)
      }
    }
    if (memories.length === 0) { stats.skippedSamples += 1; continue }
    const qa = sample.qa
    if (!Array.isArray(qa)) fail(`sample "${sampleId}": qa must be an array`)
    const queries = []
    for (let qi = 0; qi < qa.length; qi++) {
      const item = qa[qi]
      const where = `sample "${sampleId}" qa #${qi + 1}`
      if (!plain(item)) fail(`${where}: expected an object`)
      const question = need(item.question, `${where}.question`)
      const evidence = item.evidence
      if (evidence === undefined || evidence === null || (Array.isArray(evidence) && evidence.length === 0)) {
        stats.noEvidence += 1
        continue
      }
      if (!Array.isArray(evidence)) fail(`${where}.evidence must be an array`)
      const ids = []
      for (const entry of evidence) {
        if (typeof entry !== 'string') fail(`${where}.evidence entries must be strings`)
        for (const token of entry.split(/[;,\s]+/)) if (token) ids.push(token)
      }
      const gold = []
      let missing = 0
      for (const id of ids) {
        const memoryId = byDia.get(id) ?? byDia.get(id.startsWith(`${sampleId}:`) ? id.slice(sampleId.length + 1) : id)
        if (memoryId === undefined) { missing += 1; continue }
        if (!gold.includes(memoryId)) gold.push(memoryId)
      }
      if (missing > 0) { stats.unresolved += 1; continue }
      if (gold.length === 0) { stats.noEvidence += 1; continue }
      queries.push({ query: question, gold })
    }
    if (queries.length === 0) { stats.skippedSamples += 1; continue }
    corpora.push({ name: sampleId, memories, queries })
    stats.samples += 1
    stats.memories += memories.length
    stats.queries += queries.length
  }
  if (corpora.length === 0) throw new Error(`no usable conversations produced (${JSON.stringify(stats)})`)
  const output = corpora.map((corpus) => JSON.stringify(corpus)).join('\n') + '\n'
  if (options.out !== null) {
    await fs.mkdir(dirname(options.out), { recursive: true })
    await fs.writeFile(options.out, output, 'utf8')
  } else {
    process.stdout.write(output)
  }
  process.stderr.write(`converted ${stats.samples} conversations -> ${stats.memories} memories, ${stats.queries} queries\n`)
  process.stderr.write(`skipped: ${stats.noEvidence} qa without evidence, ${stats.unresolved} qa with unresolved evidence, ${stats.emptyTurns} empty turns, ${stats.skippedSamples} samples without usable turns/queries\n`)
  if (options.out !== null) process.stderr.write(`wrote ${options.out}\n`)
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
