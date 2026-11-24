import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_PROMPT,
  deriveTags,
  extractEntities,
  looksLikeMemoryCandidate,
  parsePromptJson,
  replaySamples,
  validatePrompt
} from '../src/prompt.js'

test('PR-A rejects empty and oversized sections', () => {
  const result = validatePrompt({ what: '', structure: 'x', tagging: 'y' }, { samples: replaySamples() })
  assert.equal(result.assertions.A, false)
  const long = validatePrompt({
    what: '字'.repeat(401),
    structure: '结构',
    tagging: '标签'
  }, { samples: replaySamples() })
  assert.equal(long.assertions.A, false)
})

test('PR-B replay requires fifty samples and non-empty dedup output', () => {
  const short = validatePrompt(BUILTIN_PROMPT, { samples: replaySamples().slice(0, 10) })
  assert.equal(short.assertions.B, false)
  const full = validatePrompt(BUILTIN_PROMPT, { samples: replaySamples() })
  assert.equal(full.assertions.B, true)
  assert.equal(replaySamples().length, 50)
})

test('PR-C rejects prompts that leak source entities', () => {
  const leaking = { ...BUILTIN_PROMPT, tagging: `${BUILTIN_PROMPT.tagging} pnpm` }
  const result = validatePrompt(leaking, { samples: replaySamples(), sourceEntities: ['pnpm'] })
  assert.equal(result.assertions.C, false)
  assert.match(result.errors.join(';'), /pnpm/)
})

test('a clean candidate passes all three assertions', () => {
  const result = validatePrompt(BUILTIN_PROMPT, {
    samples: replaySamples(),
    sourceEntities: ['src/index.js', 'pnpm']
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.assertions, { A: true, B: true, C: true })
})

test('parsePromptJson tolerates fenced output and prose', () => {
  const parsed = parsePromptJson('说明文字\n```json\n{"what":"a","structure":"b","tagging":"c"}\n```')
  assert.deepEqual(parsed, { what: 'a', structure: 'b', tagging: 'c' })
  assert.throws(() => parsePromptJson('没有 JSON'))
})

test('entity extraction covers backticks, mentions, quotes and filenames', () => {
  const entities = extractEntities('改 `src/index.js`，问 @alice，参考“部署清单”，文件 config.json')
  assert.ok(entities.includes('src/index.js'))
  assert.ok(entities.includes('alice'))
  assert.ok(entities.includes('部署清单'))
  assert.ok(entities.includes('config.json'))
})

test('deterministic tag derivation is stable and de-duplicated', () => {
  const first = deriveTags('以后都先跑自检再提交 pnpm')
  const second = deriveTags('以后都先跑自检再提交 pnpm')
  assert.deepEqual(first.tags, second.tags)
  assert.deepEqual(first.triggers, second.triggers)
  assert.equal(new Set(first.tags).size, first.tags.length)
})

test('candidate detection finds durable phrasing only', () => {
  assert.equal(looksLikeMemoryCandidate('以后都用 pnpm 安装依赖'), true)
  assert.equal(looksLikeMemoryCandidate('remember to run tests'), true)
  assert.equal(looksLikeMemoryCandidate('把这段代码格式化一下'), false)
})
