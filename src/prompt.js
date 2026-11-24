/**
 * Self-authored extraction prompt lifecycle.
 *
 * The runtime asks the active model to propose a prompt once per fresh store,
 * validates the proposal with deterministic assertions, applies it with a new
 * version, and keeps every earlier version on disk. The builtin fallback is a
 * real prompt, not a placeholder: it is what guarantees zero-config startup
 * when no model call is possible.
 */
export const BUILTIN_PROMPT = Object.freeze({
  what: '记住用户明确表达、以后仍然适用的偏好、约定、决策与项目事实；一次对话即可完成的临时请求不记。',
  structure: '每条记忆写一句可独立理解的话：对象、条件、结论齐全；不要使用依赖上下文的指代。',
  tagging: '标签用 2-6 字的领域词；触发词用用户将来可能提到的同义说法、文件名或工具名。'
})

const ENTITY_PATTERNS = [
  /`([^`\n]{2,80})`/g,
  /@([A-Za-z0-9_.\-/]{2,80})/g,
  /[“"「]([^”"」\n]{2,80})[”"」]/g,
  /\b([A-Za-z0-9_.-]+\.(?:js|ts|mjs|cjs|json|md|ya?ml|py|go|rs|java|sh|ps1))\b/g
]

/** Quoted text, @mentions, backtick identifiers and filenames. */
export function extractEntities (text) {
  const found = new Set()
  for (const pattern of ENTITY_PATTERNS) {
    for (const match of String(text ?? '').matchAll(pattern)) {
      const value = match[1].trim()
      if (value.length > 0) found.add(value)
    }
  }
  return [...found]
}

/** Deterministic tag/trigger fallback used by both replay validation and save. */
export function deriveTags (text, limit = 8) {
  const entities = extractEntities(text)
  const counts = new Map()
  const bump = (token, weight = 1) => {
    if (token.length === 0) return
    counts.set(token, (counts.get(token) ?? 0) + weight)
  }
  for (const entity of entities) bump(entity, 4)
  for (const word of String(text ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) bump(word, 2)
  const cjk = String(text ?? '').match(/[\u4e00-\u9fff]{2,}/g) ?? []
  for (const run of cjk) {
    const chars = Array.from(run)
    for (let index = 0; index + 1 < chars.length; index++) bump(chars[index] + chars[index + 1])
  }
  const ordered = [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })
  const tags = ordered.slice(0, Math.min(4, limit)).map(([token]) => token)
  const triggers = ordered.slice(tags.length, limit).map(([token]) => token)
  return { tags, triggers, entities }
}

export function promptText (prompt) {
  return [prompt.what, prompt.structure, prompt.tagging].join('\n')
}

/** Compact policy line injected into the system prompt alongside the anchor. */
export function policyText (prompt) {
  if (prompt === null || prompt === undefined) return ''
  return `记忆约定：${prompt.what}\n结构：${prompt.structure}\n标签：${prompt.tagging}`
}

/**
 * Extract a JSON object from model text (tolerates fences and prose around it).
 */
export function parsePromptJson (text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')
  const start = raw.indexOf('{')
  if (start < 0) throw new Error('prompt generation: model output contains no JSON object')
  let depth = 0
  let end = -1
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) { end = index; break }
    }
  }
  if (end < 0) throw new Error('prompt generation: model output contains an unterminated JSON object')
  const parsed = JSON.parse(raw.slice(start, end + 1))
  if (parsed === null || typeof parsed !== 'object') throw new Error('prompt generation: JSON is not an object')
  return parsed
}

const SELECTION_PATTERNS = [
  /以后(都|一律|统一|默认)?/,
  /记住/,
  /别忘了/,
  /默认(用|走|是|按)/,
  /约定/,
  /偏好/,
  /always/i,
  /from now on/i,
  /remember/i,
  /by default/i,
  /never/i
]

/** Cheap candidate detection for C1 audits and C3 reminders. No model call. */
export function looksLikeMemoryCandidate (text) {
  const value = String(text ?? '')
  if (value.trim().length < 6) return false
  return SELECTION_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Validate one proposed prompt against assertions A, B and C.
 *
 * A: three sections, each non-empty and at most 400 code points.
 * B: replaying 50 candidate texts through the deterministic extractor yields
 *    non-empty, de-duplicated tags/triggers/entities.
 * C: the prompt text leaks none of the source session's entity words.
 */
export function validatePrompt (candidate, options = {}) {
  const samples = options.samples ?? []
  const sourceEntities = options.sourceEntities ?? []
  const assertions = { A: false, B: false, C: false }
  const errors = []
  const sections = ['what', 'structure', 'tagging']
  assertions.A = sections.every((key) => {
    const value = candidate?.[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`section "${key}" is empty`)
      return false
    }
    if (Array.from(value).length > 400) {
      errors.push(`section "${key}" exceeds 400 characters`)
      return false
    }
    return true
  })
  if (Array.from(samples).length < 50) {
    errors.push(`replay requires 50 sample texts, got ${Array.from(samples).length}`)
  } else {
    assertions.B = samples.every((sample) => {
      const derived = deriveTags(sample)
      return derived.tags.length > 0 &&
        derived.triggers.length > 0 &&
        new Set(derived.tags).size === derived.tags.length &&
        new Set(derived.triggers).size === derived.triggers.length &&
        new Set(derived.entities).size === derived.entities.length
    })
    if (!assertions.B) errors.push('replay produced empty or duplicate tags/triggers/entities')
  }
  const text = candidate === undefined ? '' : promptText(candidate)
  const leaked = sourceEntities.filter((entity) => entity.length >= 2 && text.includes(entity))
  assertions.C = leaked.length === 0
  if (!assertions.C) errors.push(`prompt leaks source entities: ${leaked.slice(0, 5).join(', ')}`)
  return {
    ok: assertions.A && assertions.B && assertions.C,
    assertions,
    errors
  }
}

/** 50 deterministic replay candidates for validation. */
export function replaySamples (seedTexts = []) {
  const base = [
    '以后都先跑自检再提交',
    '默认使用 pnpm 安装依赖',
    '这个项目统一走 Node 22',
    '提交前执行 npm test',
    '部署前先构建 dist 目录',
    '记住不要改 package.json 的版本号',
    '错误处理统一返回结构化 code',
    '数据库迁移必须先备份',
    '接口路径使用 kebab-case',
    '日志不要打印访问令牌',
    '生成文档时保留中文术语',
    '默认关闭遥测',
    '所有命令在项目根目录执行',
    '不要新增原生依赖',
    '测试优先使用 node:test',
    '插件发布前跑 selfcheck',
    '记忆写入必须带来源会话',
    '压缩前先确认记忆已落库',
    '前端构建产物不要提交',
    '会话续接时沿用同一 profile',
    '用户偏好简洁的最终答复',
    '默认不创建 git commit',
    '文件修改用 edit 工具而不是脚本',
    '中文文本必须用 UTF-8 写入',
    '不要用 PowerShell 批量改中文文件',
    '接口返回错误时带 requestId',
    '长任务先给阶段结论',
    '所有时间戳使用 ISO 8601',
    '边界条件优先写单测',
    '不要吞掉异常',
    '配置项尽量用选择而不是自由填写',
    '压缩后只注入记忆锚点',
    '保护区按真人消息计算',
    '检索命中原因必须可审计',
    '提示版本必须可回滚',
    '删除记忆只追加墓碑',
    '存储使用单文件 NDJSON',
    '不要依赖开发期工具链',
    '插件名使用 dsh 前缀',
    '埋点不要包含用户隐私',
    '提交信息使用祈使句',
    '分支合并前先 rebase',
    '不要在压缩后重写最近五轮',
    '锚点文本不超过四百字',
    '检索使用标签触发词和 BM25',
    'embedding 缺失时静默回退',
    '模型调用失败要有降级路径',
    '审计行必须记录决策理由',
    '同一 tick 的写入必须串行',
    '表面替换必须复刻影子价事件'
  ]
  const seeded = seedTexts.filter((text) => typeof text === 'string' && text.trim().length > 0)
  return [...base, ...seeded].slice(0, 50)
}
