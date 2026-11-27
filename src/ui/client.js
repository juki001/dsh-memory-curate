/**
 * Browser half of dsh-memory-curate: one settings section («记忆») that browses,
 * filters, edits (append-only supersede) and deletes memories through the host
 * routes registered by src/browser-routes.js.
 *
 * Loaded by the DSH module loader through `package.json` → `dsh.client` →
 * `exports["./client"]`. Plain JavaScript, no JSX, no bundler: React comes from
 * the loader's `require('react')`.
 * @module ui/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-curate',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const ROUTE_BASE = '/plugins/dsh-memory-curate'
    const STATUS_PATH = `${ROUTE_BASE}/status`
    const BROWSE_PATH = `${ROUTE_BASE}/browse`
    const TRACE_PATH = `${ROUTE_BASE}/trace`
    const UPDATE_PATH = `${ROUTE_BASE}/update`
    const DELETE_PATH = `${ROUTE_BASE}/delete`
    const CONFIG_PATH = `${ROUTE_BASE}/config`
    const KEY_HEADER = 'x-memory-curate-key'
    const SECTION_SLOT = 'settings.section'
    const SECTION_ID = 'memory-curate'
    const REQUEST_TIMEOUT_MS = 15000
    const STATUS_LABELS = { active: '有效', superseded: '已取代', deleted: '已删除', expired: '已过期', missing: '缺失' }
    const EMPTY_FORM = { text: '', tags: '', triggers: '', importance: '', validUntil: '', reason: '' }

    // Learned from /status (the body copy; the route also sets an HttpOnly cookie).
    let controlKey

    // Local to this settings surface. Never style host buttons, headings or forms globally.
    const PANEL_CSS = `
      .dmc-panel { --dmc-accent: light-dark(#245fc5,#91b7ff); --dmc-danger: light-dark(#b42318,#ffaaa1);
        --dmc-warn: light-dark(#946000,#eec46a); --dmc-ok: light-dark(#18734a,#87d6aa);
        --dmc-line: color-mix(in srgb,currentColor 17%,transparent);
        --dmc-tint: color-mix(in srgb,currentColor 4%,transparent);
        max-width: 1100px; padding: 20px 4px; line-height: 1.6; font-size: 13px; overflow-wrap: anywhere; color: inherit; }
      .dmc-panel *, .dmc-panel *::before, .dmc-panel *::after { box-sizing: border-box; }
      .dmc-panel [hidden] { display: none !important; }
      .dmc-panel h2, .dmc-panel h3, .dmc-panel p { margin: 0; }
      .dmc-panel h2 { font-size: 22px; letter-spacing: -.03em; line-height: 1.4; }
      .dmc-panel h3 { font-size: 13px; font-weight: 650; }
      .dmc-panel button, .dmc-panel input, .dmc-panel select, .dmc-panel textarea { font: inherit; }
      .dmc-panel :is(button,a,input,select,textarea):focus-visible { outline: 2px solid var(--dmc-accent); outline-offset: 2px; }
      .dmc-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
      .dmc-muted { opacity: .74; font-size: 12px; }
      .dmc-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .dmc-button { min-height: 34px; padding: 5px 12px; border: 1px solid var(--dmc-line); border-radius: 9px;
        background: var(--dmc-tint); color: inherit; cursor: pointer; }
      .dmc-button:not(:disabled):hover { box-shadow: 0 0 0 2px var(--dmc-line); }
      .dmc-button:disabled { opacity: .55; cursor: wait; }
      .dmc-primary { border-color: var(--dmc-accent); background: color-mix(in srgb,var(--dmc-accent) 14%,transparent); font-weight: 600; }
      .dmc-danger { border-color: var(--dmc-danger); color: var(--dmc-danger); }
      .dmc-input { min-height: 34px; padding: 6px 9px; border: 1px solid var(--dmc-line); border-radius: 9px;
        background: var(--dmc-tint); color: inherit; max-width: 100%; }
      .dmc-textarea { width: 100%; min-height: 76px; resize: vertical; }
      .dmc-toolbar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end;
        padding: 10px 0 14px; border-top: 1px solid var(--dmc-line); border-bottom: 1px solid var(--dmc-line); margin-bottom: 14px; }
      .dmc-search { display: flex; gap: 8px; flex: 1 1 260px; min-width: 0; }
      .dmc-search .dmc-input { flex: 1 1 auto; min-width: 0; }
      .dmc-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
      .dmc-field-column { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
      .dmc-check { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; font-size: 12px; }
      .dmc-body { display: grid; grid-template-columns: minmax(200px,.9fr) minmax(280px,1.3fr); gap: 18px; align-items: start; }
      .dmc-list, .dmc-detail { min-width: 0; }
      .dmc-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px;
        max-height: min(560px, 58vh); overflow: auto; }
      .dmc-row { margin: 0; }
      .dmc-row-button { width: 100%; text-align: start; font: inherit; color: inherit; background: transparent;
        border: 1px solid var(--dmc-line); border-radius: 12px; padding: 10px 12px; cursor: pointer;
        display: flex; flex-direction: column; gap: 6px; }
      .dmc-row-selected .dmc-row-button { border-color: var(--dmc-accent);
        background: color-mix(in srgb,var(--dmc-accent) 10%,transparent); }
      .dmc-row-text { font-weight: 550; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .dmc-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: 11.5px; opacity: .82; }
      .dmc-tags { display: flex; flex-wrap: wrap; gap: 4px; }
      .dmc-chip { border: 1px solid var(--dmc-line); border-radius: 99px; padding: 0 7px; font-size: 11px; opacity: .92; }
      .dmc-status-active { border-color: color-mix(in srgb,var(--dmc-ok) 55%,transparent); color: var(--dmc-ok); }
      .dmc-id { font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .8; }
      .dmc-detail { border: 1px solid var(--dmc-line); border-radius: 14px; padding: 16px; }
      .dmc-detail-content > * + * { margin-top: 12px; }
      .dmc-detail-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
      .dmc-detail-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .dmc-body-text { white-space: pre-wrap; font-size: 13.5px; }
      .dmc-source { padding: 10px 12px; border: 1px solid var(--dmc-line); border-radius: 10px; background: var(--dmc-tint); }
      .dmc-source > * + * { margin-top: 4px; }
      .dmc-audit { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px;
        max-height: 320px; overflow: auto; }
      .dmc-audit-row { border-left: 2px solid var(--dmc-line); padding: 4px 0 4px 10px; }
      .dmc-audit-text { white-space: pre-wrap; max-height: 120px; overflow: auto; }
      .dmc-audit-reason { font-size: 12px; opacity: .85; }
      .dmc-edit, .dmc-delete { border-top: 1px solid var(--dmc-line); padding-top: 12px; }
      .dmc-edit > * + *, .dmc-delete > * + * { margin-top: 8px; }
      .dmc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
      .dmc-error { border-left: 3px solid var(--dmc-danger); border-radius: 8px; padding: 8px 12px;
        background: color-mix(in srgb,var(--dmc-danger) 7%,transparent); }
      .dmc-notice { border-left: 3px solid var(--dmc-ok); border-radius: 8px; padding: 8px 12px; margin: 8px 0;
        background: color-mix(in srgb,var(--dmc-ok) 8%,transparent); }
      .dmc-banner { border-left: 3px solid var(--dmc-warn); border-radius: 8px; padding: 8px 12px; margin: 8px 0;
        background: color-mix(in srgb,var(--dmc-warn) 8%,transparent); }
      .dmc-delete .dmc-actions .dmc-input { flex: 1 1 220px; }
      .dmc-config { margin-top: 16px; padding-top: 12px; border-top: 1px solid light-dark(#e5e5e5,#3a3a3a); }
      .dmc-config > * + * { margin-top: 8px; }
      @media (max-width: 760px) {
        .dmc-body { grid-template-columns: 1fr; }
        .dmc-rows { max-height: 320px; }
        .dmc-panel { padding: 12px 0; }
      }
    `

    /* ---------------------------------------------------------------- helpers */

    function messageOf (error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** One JSON request with a timeout. Script errors are turned into friendly text. */
    async function requestJson (path, init) {
      if (typeof fetch !== 'function') throw new Error('当前宿主不支持 fetch，无法加载记忆面板。')
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(path, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...(controller === undefined ? {} : { signal: controller.signal }),
          ...(init ?? {})
        })
        let body
        try { body = await response.json() } catch { body = undefined }
        if (!response.ok) {
          const detail = body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== ''
            ? body.error
            : `HTTP ${response.status}`
          const error = new Error(detail)
          error.status = response.status
          throw error
        }
        if (body === undefined) throw new Error('主机返回了非 JSON 响应（记忆路由可能没有注册）。')
        return body
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时（15 秒）。')
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    /** Read /status, which is the only thing that knows this launch's key. */
    async function readStatus () {
      const data = await requestJson(STATUS_PATH, { headers: { accept: 'application/json' } })
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error('记忆服务没有响应（主机未注册路由，或插件尚未重启）。')
      }
      if (typeof data.key !== 'string' || data.key === '') {
        throw new Error('主机没有返回控制密钥；记忆面板无法写入。')
      }
      controlKey = data.key
      return data
    }

    function keyHeaders () {
      return controlKey === undefined ? {} : { [KEY_HEADER]: controlKey }
    }

    /** GET with the control key; refresh the key and retry exactly once on 401. */
    async function readWithKey (path) {
      let statusError
      if (controlKey === undefined) {
        try { await readStatus() } catch (error) { statusError = error }
      }
      const send = () => requestJson(path, { headers: { accept: 'application/json', ...keyHeaders() } })
      try {
        return await send()
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.status === 401) {
          try { await readStatus() } catch { /* the retry below reports the failure */ }
          try { return await send() } catch (retryError) { throw statusError ?? retryError }
        }
        throw statusError ?? error
      }
    }

    /** POST with the control key; same single 401 retry as reads. */
    async function postWithKey (path, payload) {
      let statusError
      if (controlKey === undefined) {
        try { await readStatus() } catch (error) { statusError = error }
      }
      const send = () => requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...keyHeaders() },
        body: JSON.stringify(payload ?? {})
      })
      try {
        return await send()
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.status === 401) {
          try { await readStatus() } catch { /* the retry below reports the failure */ }
          try { return await send() } catch (retryError) { throw statusError ?? retryError }
        }
        throw statusError ?? error
      }
    }

    function formatTime (value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      try { return date.toLocaleString() } catch { return value }
    }

    function splitList (text) {
      return String(text ?? '').split(/[,，]/u).map((item) => item.trim()).filter((item) => item !== '')
    }

    function mergeTags (previous, rows) {
      const merged = new Set(previous)
      for (const row of rows) {
        for (const tag of Array.isArray(row.tags) ? row.tags : []) {
          if (typeof tag === 'string' && tag !== '') merged.add(tag)
        }
      }
      return [...merged].sort((left, right) => left.localeCompare(right))
    }

    function formOfRow (row) {
      return {
        text: typeof row?.text === 'string' ? row.text : '',
        tags: Array.isArray(row?.tags) ? row.tags.join(', ') : '',
        triggers: Array.isArray(row?.triggers) ? row.triggers.join(', ') : '',
        importance: typeof row?.importance === 'number' ? String(row.importance) : '',
        validUntil: typeof row?.validUntil === 'string' ? row.validUntil : '',
        reason: ''
      }
    }

    /* ------------------------------------------------------------- components */

    function StatusBadge ({ status }) {
      const value = typeof status === 'string' && status !== '' ? status : 'unknown'
      const label = typeof STATUS_LABELS[value] === 'string' ? STATUS_LABELS[value] : value
      const tone = typeof STATUS_LABELS[value] === 'string' ? value : 'unknown'
      return h('span', { className: `dmc-chip dmc-status-${tone}` }, label)
    }

    function MemoryRow ({ row, selected, onSelect }) {
      const tags = Array.isArray(row.tags) ? row.tags : []
      const importance = typeof row.importance === 'number' ? String(row.importance) : '—'
      const namespace = typeof row.namespace === 'string' && row.namespace !== '' ? row.namespace : 'default'
      const visibility = typeof row.visibility === 'string' && row.visibility !== '' ? row.visibility : 'shared'
      return h('li', { className: selected === true ? 'dmc-row dmc-row-selected' : 'dmc-row' },
        h('button', {
          type: 'button',
          className: 'dmc-row-button',
          'aria-current': selected === true ? 'true' : undefined,
          onClick: () => onSelect(row)
        }, [
          h('span', { key: 'text', className: 'dmc-row-text' },
            typeof row.text === 'string' && row.text !== '' ? row.text : '（空正文）'),
          h('span', { key: 'meta', className: 'dmc-meta' }, [
            h(StatusBadge, { key: 'status', status: row.status }),
            h('span', { key: 'scope', className: 'dmc-chip' }, `${namespace} · ${visibility}`),
            h('span', { key: 'importance' }, `重要度 ${importance}`),
            h('span', { key: 'updated' }, `更新 ${formatTime(row.updatedAt ?? row.createdAt ?? row.ts)}`)
          ]),
          tags.length > 0
            ? h('span', { key: 'tags', className: 'dmc-tags' },
              tags.map((tag, index) => h('span', { key: `${String(tag)}-${index}`, className: 'dmc-chip' }, String(tag))))
            : null
        ]))
    }

    function AuditRow ({ row }) {
      const kind = typeof row.kind === 'string' ? row.kind : 'row'
      const op = typeof row.op === 'string' && row.op !== '' ? ` · ${row.op}` : ''
      const decision = typeof row.decision === 'string' && row.decision !== '' ? row.decision : undefined
      const reason = typeof row.reason === 'string' && row.reason !== '' ? row.reason : ''
      const body = kind === 'memory' && typeof row.text === 'string' ? row.text : ''
      return h('li', { className: 'dmc-audit-row' }, [
        h('div', { key: 'head', className: 'dmc-meta' }, [
          h('code', { key: 'kind' }, `${kind}${op}`),
          h('span', { key: 'ts' }, formatTime(row.ts ?? row.updatedAt ?? row.createdAt)),
          decision === undefined ? null : h('span', { key: 'decision', className: 'dmc-chip' }, decision),
          typeof row.id === 'string' ? h('code', { key: 'id', className: 'dmc-id' }, row.id) : null
        ]),
        body === '' ? null : h('p', { key: 'text', className: 'dmc-audit-text' }, body),
        reason === '' ? null : h('p', { key: 'reason', className: 'dmc-audit-reason' }, `原因：${reason}`)
      ])
    }

    function SourceList ({ source }) {
      const sessionId = source !== null && typeof source === 'object' &&
        typeof source.sessionId === 'string' && source.sessionId !== '' ? source.sessionId : undefined
      const seqs = source !== null && typeof source === 'object' && Array.isArray(source.seqs) ? source.seqs : []
      return h('div', { className: 'dmc-source' }, [
        h('h3', { key: 'title' }, '来源'),
        h('p', { key: 'session', className: 'dmc-meta' }, [
          h('span', { key: 'label' }, '会话：'),
          sessionId === undefined ? h('span', { key: 'none' }, '—') : h('code', { key: 'id' }, sessionId)
        ]),
        h('p', { key: 'seqs', className: 'dmc-meta' }, seqs.length === 0
          ? [h('span', { key: 'label' }, '对话位置：'), h('span', { key: 'none' }, '—')]
          : [h('span', { key: 'label' }, '对话位置：'),
              ...seqs.map((seq, index) => h('span', { key: `seq-${index}`, className: 'dmc-chip' }, `#${String(seq)}`))])
      ])
    }

    const CONFIG_FIELDS = [
      { key: 'retrievalMode', label: '检索模式', type: 'select', options: [['bm25', 'BM25（仅词面）'], ['hybrid', 'hybrid（BM25 + 向量）']] },
      { key: 'embeddingBaseURL', label: '嵌入端点', type: 'text', placeholder: 'http://127.0.0.1:1236/v1' },
      { key: 'embeddingModel', label: '嵌入模型', type: 'text', placeholder: 'bge-m3' },
      { key: 'embeddingApiKeyEnv', label: 'API Key 环境变量', type: 'text', placeholder: '本地可留空' },
      { key: 'embeddingWeight', label: '向量权重 (0.05-0.95)', type: 'number', step: '0.05' },
      { key: 'headroomRatio', label: '余量比例 (下限 8192)', type: 'number', step: '0.0001' }
    ]

    function configPayload (form) {
      const payload = {}
      for (const field of CONFIG_FIELDS) {
        const raw = form[field.key]
        if (field.type === 'number') {
          const number = Number(raw)
          if (Number.isFinite(number)) payload[field.key] = number
        } else {
          payload[field.key] = raw
        }
      }
      return payload
    }

    function ConfigPanel () {
      const [form, setForm] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const load = React.useCallback(async () => {
        try {
          const data = await readWithKey(CONFIG_PATH)
          if (!alive.current) return
          if (data === null || typeof data !== 'object' || data.ok !== true) {
            throw new Error('主机没有返回检索设置。')
          }
          const config = data.config ?? {}
          const next = {}
          for (const field of CONFIG_FIELDS) next[field.key] = config[field.key] ?? ''
          setForm(next)
          setError(undefined)
        } catch (loadError) {
          if (alive.current) setError(messageOf(loadError))
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const setField = (key, value) => setForm((previous) => ({ ...previous, [key]: value }))

      const submit = async (event) => {
        event.preventDefault()
        if (form === undefined) return
        setSaving(true)
        setError(undefined)
        setNotice(undefined)
        try {
          const data = await postWithKey(CONFIG_PATH, configPayload(form))
          if (data === null || typeof data !== 'object' || data.ok !== true) {
            throw new Error('主机没有接受这次设置。')
          }
          const config = data.config ?? {}
          const next = {}
          for (const field of CONFIG_FIELDS) next[field.key] = config[field.key] ?? ''
          setForm(next)
          setNotice('已保存，即时生效。')
        } catch (saveError) {
          setError(messageOf(saveError))
        } finally {
          setSaving(false)
        }
      }

      if (form === undefined) {
        return h('div', { className: 'dmc-config' }, [
          h('h3', { key: 'title' }, '检索与压缩设置'),
          h('p', { key: 'state', className: 'dmc-muted' }, error === undefined ? '读取设置中…' : `读取失败：${error}`)
        ])
      }

      return h('form', { className: 'dmc-config', onSubmit: submit }, [
        h('h3', { key: 'title' }, '检索与压缩设置'),
        h('p', { key: 'hint', className: 'dmc-muted' },
          'hybrid 需要可用的 /embeddings 端点；余量按模型上下文比例计算，最小 8192。'),
        h('div', { key: 'grid', className: 'dmc-grid' }, CONFIG_FIELDS.map((field) => {
          let input
          if (field.type === 'select') {
            input = h('select', {
              key: 'input', className: 'dmc-input', value: form[field.key] ?? '',
              onChange: (event) => setField(field.key, event.target.value)
            }, field.options.map(([value, label]) => h('option', { key: value, value }, label)))
          } else {
            input = h('input', {
              key: 'input', className: 'dmc-input',
              type: field.type === 'number' ? 'number' : 'text',
              step: field.step ?? undefined,
              placeholder: field.placeholder ?? '',
              value: form[field.key] ?? '',
              onChange: (event) => setField(field.key, event.target.value)
            })
          }
          return h('label', { key: field.key, className: 'dmc-field-column' }, [
            h('span', { key: 'label' }, field.label),
            input
          ])
        })),
        error === undefined ? null : h('div', { key: 'error', className: 'dmc-error' }, `保存失败：${error}`),
        notice === undefined ? null : h('div', { key: 'notice', className: 'dmc-notice' }, notice),
        h('div', { key: 'actions', className: 'dmc-actions' }, [
          h('button', {
            key: 'save', type: 'submit', className: 'dmc-button dmc-primary',
            disabled: saving
          }, saving ? '保存中…' : '保存设置')
        ])
      ])
    }

    function MemoryPanel () {
      const [query, setQuery] = React.useState('')
      const [tag, setTag] = React.useState('')
      const [includeExpired, setIncludeExpired] = React.useState(false)
      const [list, setList] = React.useState({ loading: true, error: undefined, rows: [], total: 0 })
      const [host, setHost] = React.useState({
        ready: false, error: undefined, enabled: true, readOnly: false, promptVersion: null, capabilities: undefined
      })
      const [tagOptions, setTagOptions] = React.useState([])
      const [selected, setSelected] = React.useState(undefined)
      const [detail, setDetail] = React.useState({ loading: false, error: undefined, rows: [] })
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [actionError, setActionError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [deleteReason, setDeleteReason] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const alive = React.useRef(true)
      const sequence = React.useRef(0)

      React.useEffect(() => () => { alive.current = false }, [])

      /* Ask the host what it supports once; browse/trace still work without it. */
      React.useEffect(() => {
        let cancelled = false
        readStatus()
          .then((data) => {
            if (cancelled) return
            setHost({
              ready: true,
              error: undefined,
              enabled: data.enabled !== false,
              readOnly: data.readOnly === true,
              promptVersion: typeof data.promptVersion === 'string' ? data.promptVersion : null,
              capabilities: data.capabilities !== null && typeof data.capabilities === 'object' ? data.capabilities : undefined
            })
          })
          .catch((error) => {
            if (cancelled) return
            setHost((previous) => ({ ...previous, ready: true, error: messageOf(error) }))
          })
        return () => { cancelled = true }
      }, [])

      const load = React.useCallback(async () => {
        const current = ++sequence.current
        setList((previous) => ({ ...previous, loading: true, error: undefined }))
        try {
          const params = new URLSearchParams()
          const trimmed = query.trim()
          if (trimmed !== '') params.set('q', trimmed)
          if (tag !== '') params.set('tag', tag)
          if (includeExpired) params.set('includeExpired', '1')
          params.set('limit', '100')
          const data = await readWithKey(`${BROWSE_PATH}?${params.toString()}`)
          if (!alive.current || sequence.current !== current) return
          const rows = Array.isArray(data.rows) ? data.rows.filter((row) => row !== null && typeof row === 'object') : []
          setList({
            loading: false,
            error: undefined,
            rows,
            total: Number.isInteger(data.total) ? data.total : rows.length
          })
          setTagOptions((previous) => mergeTags(previous, rows))
        } catch (error) {
          if (!alive.current || sequence.current !== current) return
          setList((previous) => ({ ...previous, loading: false, error: messageOf(error) }))
        }
      }, [query, tag, includeExpired])

      /* Typing in the search box should show results without a submit. */
      React.useEffect(() => {
        const timer = setTimeout(() => { void load() }, 250)
        return () => clearTimeout(timer)
      }, [load])

      const loadDetail = React.useCallback(async (memoryId) => {
        const params = new URLSearchParams({ memoryId })
        const data = await readWithKey(`${TRACE_PATH}?${params.toString()}`)
        return Array.isArray(data.rows) ? data.rows.filter((row) => row !== null && typeof row === 'object') : []
      }, [])

      React.useEffect(() => {
        if (selected === undefined) {
          setDetail({ loading: false, error: undefined, rows: [] })
          return undefined
        }
        let cancelled = false
        setDetail({ loading: true, error: undefined, rows: [] })
        loadDetail(selected.id)
          .then((rows) => { if (!cancelled) setDetail({ loading: false, error: undefined, rows }) })
          .catch((error) => { if (!cancelled) setDetail({ loading: false, error: messageOf(error), rows: [] }) })
        return () => { cancelled = true }
      }, [selected, loadDetail])

      /* The form starts from the selected row and resets after every save/selection. */
      React.useEffect(() => {
        setForm(selected === undefined ? EMPTY_FORM : formOfRow(selected))
        setActionError(undefined)
      }, [selected])

      const setField = React.useCallback((name, value) => {
        setForm((previous) => ({ ...previous, [name]: value }))
      }, [])

      const resetForm = React.useCallback(() => {
        setForm(selected === undefined ? EMPTY_FORM : formOfRow(selected))
        setActionError(undefined)
      }, [selected])

      const refresh = React.useCallback(() => {
        void load()
        if (selected === undefined) return
        loadDetail(selected.id)
          .then((rows) => setDetail({ loading: false, error: undefined, rows }))
          .catch((error) => setDetail({ loading: false, error: messageOf(error), rows: [] }))
      }, [load, loadDetail, selected])

      const save = React.useCallback(async (event) => {
        event.preventDefault()
        if (selected === undefined || busy) return
        const text = form.text.trim()
        if (text === '') {
          setActionError('正文不能为空。')
          return
        }
        const payload = {
          memoryId: selected.id,
          text,
          tags: splitList(form.tags),
          triggers: splitList(form.triggers),
          reason: form.reason.trim() === '' ? 'edited in the memory browser' : form.reason.trim()
        }
        const importanceText = form.importance.trim()
        if (importanceText !== '') {
          const importance = Number(importanceText)
          if (!Number.isFinite(importance)) {
            setActionError('重要度必须是数字，或留空。')
            return
          }
          payload.importance = importance
        }
        const validUntilText = form.validUntil.trim()
        if (validUntilText !== '') {
          if (Number.isNaN(Date.parse(validUntilText))) {
            setActionError('有效期必须是 ISO 时间（例如 2026-12-31T00:00:00Z），或留空。')
            return
          }
          payload.validUntil = validUntilText
        }
        setBusy(true)
        setActionError(undefined)
        try {
          const data = await postWithKey(UPDATE_PATH, payload)
          if (data !== null && typeof data === 'object' && data.ok === false) {
            throw new Error(typeof data.error === 'string' && data.error !== '' ? data.error : '保存被拒绝')
          }
          const newId = typeof data.id === 'string' ? data.id : undefined
          setNotice(`已保存为新的记忆行${newId === undefined ? '' : ` ${newId}`}；旧行仍保留在审计与 NDJSON 中。`)
          if (newId !== undefined) {
            setSelected({
              ...selected,
              id: newId,
              text: payload.text,
              tags: payload.tags,
              triggers: payload.triggers,
              importance: payload.importance,
              validUntil: payload.validUntil,
              status: 'active',
              updatedAt: new Date().toISOString()
            })
          }
          await load()
        } catch (error) {
          setActionError(messageOf(error))
        } finally {
          setBusy(false)
        }
      }, [selected, busy, form, load])

      const remove = React.useCallback(async () => {
        if (selected === undefined || busy) return
        const question = '删除后记忆不再参与召回，但墓碑与审计记录会永久保留在 NDJSON 中。确定删除吗？'
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(question)
          : true
        if (!confirmed) return
        const reference = selected
        setBusy(true)
        setActionError(undefined)
        try {
          const data = await postWithKey(DELETE_PATH, { memoryId: reference.id, reason: deleteReason.trim() })
          if (data !== null && typeof data === 'object' && data.ok === false) {
            throw new Error(typeof data.error === 'string' && data.error !== '' ? data.error : '删除被拒绝')
          }
          const tombstoneId = typeof data.tombstoneId === 'string' ? data.tombstoneId : undefined
          setNotice(`已删除 ${String(reference.id)}${tombstoneId === undefined ? '' : `（墓碑 ${tombstoneId}）`}；记忆行与审计仍保留在 NDJSON 中。`)
          setSelected(undefined)
          setDeleteReason('')
          await load()
        } catch (error) {
          setActionError(messageOf(error))
        } finally {
          setBusy(false)
        }
      }, [selected, busy, deleteReason, load])

      const capabilities = host.capabilities
      const updateAllowed = (capabilities === undefined || capabilities.update !== false) && host.readOnly !== true
      const deleteAllowed = (capabilities === undefined || capabilities.delete !== false) && host.readOnly !== true
      const browseAllowed = capabilities === undefined || capabilities.browse !== false

      const warnings = []
      if (host.ready === true) {
        if (host.enabled === false) {
          warnings.push('记忆存储当前不可用：主机的 NDJSON 文件无法读写，浏览会失败，编辑与删除会被拒绝。')
        }
        if (host.readOnly === true) {
          warnings.push('另一个 DSH 进程持有 store 写锁：当前实例只读，编辑与删除已禁用（浏览与回溯仍可用）。')
        }
        if (capabilities !== undefined &&
            (capabilities.browse === false || capabilities.trace === false ||
             capabilities.update === false || capabilities.delete === false)) {
          warnings.push('当前主机只提供部分记忆 API；未提供的能力已在界面中禁用。请升级 dsh-memory-curate / DSH 后重启。')
        }
      }

      let source
      if (selected !== undefined) {
        if (selected.source !== null && typeof selected.source === 'object') source = selected.source
        else {
          const memoryRow = detail.rows.find((row) =>
            row.kind === 'memory' && row.id === selected.id && row.source !== null && typeof row.source === 'object')
          if (memoryRow !== undefined) source = memoryRow.source
        }
      }

      const listChildren = []
      if (list.error !== undefined) {
        listChildren.push(h('div', { key: 'error', className: 'dmc-error', role: 'alert' }, [
          h('p', { key: 'message' }, `读取失败：${list.error}`),
          h('button', {
            key: 'retry', type: 'button', className: 'dmc-button',
            onClick: () => { void load() }
          }, '重试')
        ]))
      }
      if (list.loading && list.rows.length === 0) {
        listChildren.push(h('p', { key: 'loading', className: 'dmc-muted' }, '正在读取记忆…'))
      }
      if (!list.loading && list.error === undefined && list.rows.length === 0) {
        listChildren.push(h('p', { key: 'empty', className: 'dmc-muted' },
          query.trim() !== '' || tag !== '' ? '没有匹配的记忆。' : '还没有保存任何记忆。'))
      }
      if (list.rows.length > 0) {
        listChildren.push(h('ul', { key: 'rows', className: 'dmc-rows' }, list.rows.map((row, index) => h(MemoryRow, {
          key: typeof row.id === 'string' ? row.id : `row-${index}`,
          row,
          selected: selected !== undefined && row.id === selected.id,
          onSelect: setSelected
        }))))
      }

      const detailChildren = []
      if (selected === undefined) {
        detailChildren.push(h('p', { key: 'placeholder', className: 'dmc-muted' },
          '从左侧选择一条记忆，查看正文、来源会话与完整审计轨迹。'))
      } else {
        detailChildren.push(
          h('div', { key: 'head', className: 'dmc-detail-head' }, [
            h('div', { key: 'title', className: 'dmc-detail-title' }, [
              h(StatusBadge, { key: 'status', status: selected.status }),
              h('code', { key: 'id', className: 'dmc-id' }, String(selected.id))
            ]),
            h('div', { key: 'times', className: 'dmc-meta' }, [
              h('span', { key: 'created' }, `创建 ${formatTime(selected.createdAt ?? selected.ts)}`),
              h('span', { key: 'updated' }, `更新 ${formatTime(selected.updatedAt ?? selected.createdAt ?? selected.ts)}`),
              h('span', { key: 'importance' }, `重要度 ${typeof selected.importance === 'number' ? selected.importance : '—'}`),
              typeof selected.validUntil === 'string' && selected.validUntil !== ''
                ? h('span', { key: 'validUntil' }, `有效期至 ${formatTime(selected.validUntil)}`)
                : null
            ])
          ]),
          h('p', { key: 'body', className: 'dmc-body-text' }, typeof selected.text === 'string' ? selected.text : ''),
          h(SourceList, { key: 'source', source })
        )

        detailChildren.push(actionError === undefined
          ? null
          : h('div', { key: 'action-error', className: 'dmc-error', role: 'alert' }, `操作失败：${actionError}`))
        detailChildren.push(h('h3', { key: 'audit-title' }, `审计记录（${detail.rows.length} 条）`))
        if (detail.loading) {
          detailChildren.push(h('p', { key: 'audit-loading', className: 'dmc-muted' }, '正在读取审计记录…'))
        }
        if (detail.error !== undefined) {
          detailChildren.push(h('div', { key: 'audit-error', className: 'dmc-error', role: 'alert' },
            `审计记录读取失败：${detail.error}`))
        }
        if (!detail.loading && detail.error === undefined && detail.rows.length === 0) {
          detailChildren.push(h('p', { key: 'audit-empty', className: 'dmc-muted' }, '没有可显示的审计记录。'))
        }
        if (detail.rows.length > 0) {
          detailChildren.push(h('ul', { key: 'audit', className: 'dmc-audit' }, detail.rows.map((row, index) => h(AuditRow, {
            key: typeof row.id === 'string' ? row.id : `audit-${index}`,
            row
          }))))
        }

        const field = (key, label, input) => h('label', { key, className: 'dmc-field-column' }, [
          h('span', { key: 'label' }, label),
          input
        ])
        detailChildren.push(h('form', { key: 'edit', className: 'dmc-edit', onSubmit: save }, [
          h('h3', { key: 'title' }, '编辑（追加式取代）'),
          field('text', '正文', h('textarea', {
            key: 'input', className: 'dmc-input dmc-textarea', rows: 3,
            value: form.text, onChange: (event) => setField('text', event.target.value)
          })),
          h('div', { key: 'grid', className: 'dmc-grid' }, [
            field('tags', '标签（逗号分隔）', h('input', {
              key: 'input', type: 'text', className: 'dmc-input',
              value: form.tags, onChange: (event) => setField('tags', event.target.value)
            })),
            field('triggers', '触发词（逗号分隔）', h('input', {
              key: 'input', type: 'text', className: 'dmc-input',
              value: form.triggers, onChange: (event) => setField('triggers', event.target.value)
            })),
            field('importance', '重要度（数字，可留空）', h('input', {
              key: 'input', type: 'number', step: '0.01', className: 'dmc-input',
              value: form.importance, onChange: (event) => setField('importance', event.target.value)
            })),
            field('validUntil', '有效期（ISO 时间，可留空）', h('input', {
              key: 'input', type: 'text', className: 'dmc-input', placeholder: '2026-12-31T00:00:00Z',
              value: form.validUntil, onChange: (event) => setField('validUntil', event.target.value)
            }))
          ]),
          field('reason', '修改原因（写入审计）', h('input', {
            key: 'input', type: 'text', className: 'dmc-input', placeholder: '为什么修改这条记忆',
            value: form.reason, onChange: (event) => setField('reason', event.target.value)
          })),
          h('div', { key: 'actions', className: 'dmc-actions' }, [
            h('button', {
              key: 'save', type: 'submit', className: 'dmc-button dmc-primary',
              disabled: busy || !updateAllowed
            }, busy ? '保存中…' : '保存修改'),
            h('button', {
              key: 'reset', type: 'button', className: 'dmc-button',
              disabled: busy, onClick: resetForm
            }, '还原')
          ])
        ]))

        detailChildren.push(h('div', { key: 'delete', className: 'dmc-delete' }, [
          h('h3', { key: 'title' }, '删除'),
          h('p', { key: 'hint', className: 'dmc-muted' },
            '删除是不可撤回的召回操作：记忆不再被召回，但墓碑与审计永久保留。'),
          h('div', { key: 'actions', className: 'dmc-actions' }, [
            h('input', {
              key: 'reason', type: 'text', className: 'dmc-input',
              placeholder: '删除原因（可选，写入审计）', value: deleteReason,
              onChange: (event) => setDeleteReason(event.target.value)
            }),
            h('button', {
              key: 'go', type: 'button', className: 'dmc-button dmc-danger',
              disabled: busy || !deleteAllowed, onClick: remove
            }, busy ? '处理中…' : '删除这条记忆')
          ])
        ]))
      }

      return h('div', { className: 'dmc-panel' }, [
        h('style', { key: 'css' }, PANEL_CSS),
        h('div', { key: 'head', className: 'dmc-head' }, [
          h('div', { key: 'titles' }, [
            h('h2', { key: 'title' }, '记忆'),
            h('p', { key: 'subtitle', className: 'dmc-muted' },
              '单文件 NDJSON · 追加式审计 · 编辑以新行取代旧行 · 删除以墓碑保留记录'),
            host.promptVersion !== null
              ? h('p', { key: 'prompt', className: 'dmc-muted' }, `当前抽取提示版本：${host.promptVersion}`)
              : null
          ]),
          h('div', { key: 'actions', className: 'dmc-actions' }, [
            h('span', { key: 'count', className: 'dmc-muted' }, list.loading ? '读取中…' : `共 ${list.total} 条`),
            h('button', {
              key: 'refresh', type: 'button', className: 'dmc-button',
              disabled: list.loading, onClick: refresh
            }, '刷新')
          ])
        ]),
        ...warnings.map((text, index) => h('div', {
          key: `warning-${index}`, className: 'dmc-banner', role: 'status'
        }, text)),
        notice === undefined
          ? null
          : h('div', { key: 'notice', className: 'dmc-notice', role: 'status' }, notice),
        h(ConfigPanel, { key: 'config' }),
        h('div', { key: 'toolbar', className: 'dmc-toolbar' }, [
          h('form', {
            key: 'search', className: 'dmc-search', role: 'search',
            onSubmit: (event) => { event.preventDefault(); void load() }
          }, [
            h('input', {
              key: 'input', type: 'search', className: 'dmc-input', value: query,
              placeholder: '搜索正文、标签或触发词', 'aria-label': '搜索记忆',
              onChange: (event) => setQuery(event.target.value)
            }),
            h('button', {
              key: 'go', type: 'submit', className: 'dmc-button',
              disabled: list.loading || !browseAllowed
            }, '搜索')
          ]),
          h('label', { key: 'tag', className: 'dmc-field' }, [
            h('span', { key: 'label' }, '标签过滤'),
            h('select', {
              key: 'select', className: 'dmc-input', value: tag,
              onChange: (event) => setTag(event.target.value)
            }, [
              h('option', { key: 'all', value: '' }, '全部标签'),
              ...tagOptions.map((option) => h('option', { key: option, value: option }, option))
            ])
          ]),
          h('label', { key: 'expired', className: 'dmc-check' }, [
            h('input', {
              key: 'box', type: 'checkbox', checked: includeExpired,
              onChange: (event) => setIncludeExpired(event.target.checked)
            }),
            h('span', { key: 'text' }, '显示已过期')
          ])
        ]),
        h('div', { key: 'body', className: 'dmc-body' }, [
          h('section', {
            key: 'list', className: 'dmc-list', 'aria-label': '记忆列表',
            'aria-busy': list.loading ? 'true' : undefined
          }, listChildren),
          h('section', { key: 'detail', className: 'dmc-detail', 'aria-label': '记忆详情' }, detailChildren)
        ])
      ])
    }

    /** Last line of defence: a rendering bug must not break the host settings surface. */
    class PanelBoundary extends React.Component {
      constructor (props) {
        super(props)
        this.state = { error: undefined }
      }

      static getDerivedStateFromError (error) {
        return { error }
      }

      componentDidCatch () {
        // The fallback below is the user-visible report; the host console already has it.
      }

      render () {
        if (this.state.error !== undefined) {
          return h('div', { className: 'dmc-panel' }, [
            h('style', { key: 'css' }, PANEL_CSS),
            h('div', { key: 'error', className: 'dmc-error', role: 'alert' },
              `记忆面板渲染失败：${messageOf(this.state.error)}`),
            h('p', { key: 'hint', className: 'dmc-muted' },
              '这是记忆面板自身的问题，不影响 DSH 其他功能；关闭设置后重新打开可重试。')
          ])
        }
        return this.props.children
      }
    }

    function MemoryBrowser () {
      return h(PanelBoundary, null, h(MemoryPanel))
    }

    /* ------------------------------------------------------------------ entry */

    const name = 'dsh-memory-curate-client'
    const inject = ['slots']

    function apply (ctx) {
      try {
        if (ctx === undefined || ctx === null || ctx.slots === undefined) return
        ctx.slots.inject(SECTION_SLOT, () => {
          try {
            return ctx.slots.register({
              name: SECTION_SLOT,
              id: SECTION_ID,
              order: 60,
              label: () => '记忆'
            }, MemoryBrowser)
          } catch (error) {
            try {
              ctx.logger?.warn?.(`memory-curate: settings section not registered: ${messageOf(error)}`)
            } catch { /* host logging is best effort */ }
            return () => {}
          }
        })
      } catch (error) {
        try {
          ctx?.logger?.warn?.(`memory-curate: settings section not registered: ${messageOf(error)}`)
        } catch { /* host logging is best effort */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  }
})
