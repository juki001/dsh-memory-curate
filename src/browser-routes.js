/**
 * Host half of the memory browser: HTTP routes behind the settings panel.
 *
 * src/index.js calls `registerMemoryRoutes(ctx, service)` once from `apply()`.
 * The function must never throw during boot: a broken UI route must not take
 * the memory tools, or DSH itself, down with it.
 *
 * The mechanism mirrors dsh-plugin-health's browser UI
 * (`src/ui/repair-route.js` and `src/ui/guard.js`):
 *
 *   - routes live on the host web server: `ctx.inject(['webServer'], ...)` plus
 *     `webServer.register({ kind: 'exact', path, handler })`;
 *   - every route is loopback-only, checked against both the Host header and the
 *     peer socket address (the part a client cannot choose);
 *   - reads pass the status-request guard (Origin + Sec-Fetch-Site); browse and
 *     trace additionally require the per-launch control key;
 *   - writes require `Content-Type: application/json`, the same Origin /
 *     Sec-Fetch-Site guard, and the control key, compared in constant time;
 *   - failures are `{ error: string }` JSON with no CORS headers, so a page on
 *     another origin cannot read the answer.
 *
 * Routes (absolute, so the browser half can call them from the DSH origin):
 *
 *   GET  /plugins/dsh-memory-curate/status   capabilities + this launch's control key
 *   GET  /plugins/dsh-memory-curate/browse   search / list memories
 *   GET  /plugins/dsh-memory-curate/trace    stored rows for one memory id
 *   POST /plugins/dsh-memory-curate/update   append-only supersede of one memory
 *   POST /plugins/dsh-memory-curate/delete   append-only tombstone for one memory
 *
 * This module never writes the NDJSON store itself: update/delete call the
 * service methods (`updateMemory` / `deleteById`), which own the append-only
 * rows and audits.
 * @module browser-routes
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Route namespace, absolute so the browser half can call it from the DSH origin. */
export const ROUTE_BASE = '/plugins/dsh-memory-curate'
export const STATUS_PATH = `${ROUTE_BASE}/status`
export const BROWSE_PATH = `${ROUTE_BASE}/browse`
export const TRACE_PATH = `${ROUTE_BASE}/trace`
export const UPDATE_PATH = `${ROUTE_BASE}/update`
export const DELETE_PATH = `${ROUTE_BASE}/delete`

/** Cookie that carries the per-launch control key to the browser (mirrors plugin-health). */
const KEY_COOKIE = 'memory_curate_key'
/** Header the browser half may send instead of the cookie; both are compared the same way. */
const KEY_HEADER = 'x-memory-curate-key'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_TAGS = 20
const MEMORY_ID = /^[A-Za-z0-9_-]{1,200}$/u

function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

function warn (ctxLike, message) {
  try {
    ctxLike?.logger?.warn?.(`memory-curate: ${message}`)
  } catch {
    // Logging is best effort only.
  }
}

function invalid (message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/* ------------------------------------------------------------------ response */

function send (res, status, body, extraHeaders) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
    ...(extraHeaders ?? {})
  })
  res.end(payload)
}

function failure (res, error) {
  const message = messageOf(error)
  let status = 500
  if (error !== null && typeof error === 'object') {
    if (error.code === 'MEMORY_UI_UNAVAILABLE') status = 503
    else if (error.code === 'STORE_UNAVAILABLE') status = 503
    else if (error.code === 'STORE_READ_ONLY') status = 503
    else if (error.code === 'PERMISSION_DENIED') status = 403
    else if (error.code === 'INVALID_ARGUMENT' || error.code === 'SOURCE_REQUIRED') status = 400
    else if (Number.isInteger(error.status)) status = error.status
  }
  try {
    send(res, status, { error: message })
  } catch {
    // The client is already gone; there is nothing left to answer.
  }
}

/**
 * Read a small JSON body without buffering unbounded input.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<any>} parsed body; `{}` for an empty body.
 */
async function readBody (req, limit = MAX_BODY_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw invalid('request body is not valid JSON')
  }
}

/* ------------------------------------------------------------------- control */

/** Constant-time comparison over SHA-256 digests (same reasoning as plugin-health). */
function sameKey (expected, presented) {
  if (typeof presented !== 'string' || presented === '') return false
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(presented).digest()
  return timingSafeEqual(left, right)
}

function presentedKey (req) {
  const header = req?.headers?.[KEY_HEADER]
  if (typeof header === 'string' && header !== '') return header
  const cookie = req?.headers?.cookie
  if (typeof cookie !== 'string') return undefined
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === KEY_COOKIE) return part.slice(index + 1).trim()
  }
  return undefined
}

function keyCookieHeaders (key) {
  if (typeof key !== 'string' || key === '') return {}
  return {
    // No `Max-Age`: the cookie dies with the browser session, matching the per-launch key.
    'set-cookie': `${KEY_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict`
  }
}

function hostnameOf (hostHeader) {
  const text = String(hostHeader ?? '').trim().toLowerCase()
  if (text === '') return ''
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'))
  return text.split(':')[0]
}

/* -------------------------------------------------------------------- fences */
/* Inlined from dsh-plugin-health src/ui/guard.js (MIT); semantics must match. */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function mediaTypeOf (req) {
  const raw = req?.headers?.['content-type']
  if (typeof raw !== 'string') return ''
  return raw.split(';')[0].trim().toLowerCase()
}

function checkStatusRequest (req) {
  const origin = checkOrigin(req)
  return origin.ok ? checkFetchSite(req) : origin
}

function checkWriteRequest (req) {
  if (READ_METHODS.has(String(req?.method ?? '').toUpperCase())) return { ok: true }

  const mediaType = mediaTypeOf(req)
  // An empty body is legitimate for actions with no arguments, but when a body is
  // present it must declare itself JSON. A chunked request has no length, so only
  // an explicit zero counts as empty.
  const declared = req?.headers?.['content-length']
  const chunked = req?.headers?.['transfer-encoding'] !== undefined
  const mayBeEmpty = mediaType === '' && !chunked && (declared === undefined || declared === '0' || declared === 0)
  if (!mayBeEmpty && mediaType !== 'application/json') {
    return { ok: false, status: 415, error: 'write requests must be application/json' }
  }
  return checkStatusRequest(req)
}

function checkOrigin (req) {
  const origin = req?.headers?.origin
  if (origin === undefined) return { ok: true }
  try {
    if (typeof origin !== 'string') throw new Error('invalid origin')
    const parsed = new URL(origin)
    const expected = new URL(`${req?.socket?.encrypted ? 'https' : 'http'}://${req?.headers?.host}`)
    if (parsed.origin !== origin || parsed.origin !== expected.origin) throw new Error('different origin')
  } catch {
    return { ok: false, status: 403, error: 'cross-origin request refused' }
  }
  return { ok: true }
}

function checkFetchSite (req) {
  const site = req?.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: 'cross-site request refused' }
  }
  return { ok: true }
}

const LOOPBACK_ADDRESSES = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u,
  /^::1$/u,
  /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u,
  /^0:0:0:0:0:0:0:1$/u
]

function checkLoopbackPeer (req) {
  const address = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress
  // No socket means a hand-built request (tests, internal calls); every real request has one.
  if (typeof address !== 'string' || address === '') return { ok: true }
  if (LOOPBACK_ADDRESSES.some((pattern) => pattern.test(address))) return { ok: true }
  return { ok: false, status: 403, error: 'loopback only' }
}

function authorizeStatus (req, res) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req?.headers?.host))) {
    send(res, 403, { error: 'loopback only' })
    return false
  }
  const peer = checkLoopbackPeer(req)
  if (!peer.ok) { send(res, peer.status, { error: peer.error }); return false }
  if (String(req?.method ?? '').toUpperCase() !== 'GET') {
    send(res, 405, { error: 'method not allowed' })
    return false
  }
  const guard = checkStatusRequest(req)
  if (!guard.ok) { send(res, guard.status, { error: guard.error }); return false }
  return true
}

function authorizeRead (req, res, key) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req?.headers?.host))) {
    send(res, 403, { error: 'loopback only' })
    return false
  }
  const peer = checkLoopbackPeer(req)
  if (!peer.ok) { send(res, peer.status, { error: peer.error }); return false }
  if (String(req?.method ?? '').toUpperCase() !== 'GET') {
    send(res, 405, { error: 'method not allowed' })
    return false
  }
  const guard = checkStatusRequest(req)
  if (!guard.ok) { send(res, guard.status, { error: guard.error }); return false }
  if (!sameKey(key, presentedKey(req))) {
    send(res, 401, { error: 'missing or invalid control key' })
    return false
  }
  return true
}

function authorizeWrite (req, res, key) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req?.headers?.host))) {
    send(res, 403, { error: 'loopback only' })
    return false
  }
  const peer = checkLoopbackPeer(req)
  if (!peer.ok) { send(res, peer.status, { error: peer.error }); return false }
  if (String(req?.method ?? '').toUpperCase() !== 'POST') {
    send(res, 405, { error: 'method not allowed' })
    return false
  }
  // Runs before the key check: a cross-site page must not even reach the comparison.
  const guard = checkWriteRequest(req)
  if (!guard.ok) { send(res, guard.status, { error: guard.error }); return false }
  if (!sameKey(key, presentedKey(req))) {
    send(res, 401, { error: 'missing or invalid control key' })
    return false
  }
  return true
}

/* --------------------------------------------------------------- input shapes */

function readMemoryId (value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('memoryId is required')
  const id = value.trim()
  if (!MEMORY_ID.test(id)) throw invalid('memoryId must be a stored memory id')
  return id
}

function requiredText (value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalText (value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  return value.trim()
}

function stringList (value, name) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalid(`${name} must be an array of strings`)
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') throw invalid(`${name} must contain only strings`)
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function readTags (params) {
  const out = []
  const seen = new Set()
  for (const raw of params.getAll('tag')) {
    for (const piece of String(raw).split(/[,，]/u)) {
      const tag = piece.trim()
      if (tag === '' || seen.has(tag)) continue
      seen.add(tag)
      out.push(tag)
    }
  }
  if (out.length > MAX_TAGS) throw invalid(`at most ${MAX_TAGS} tags can be filtered at once`)
  return out
}

function readLimit (value) {
  if (value === null || value === '') return DEFAULT_LIMIT
  const number = Number(value)
  if (!Number.isFinite(number)) throw invalid('limit must be a number')
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(number)))
}

function readFlag (value) {
  if (value === null) return false
  const text = String(value).toLowerCase()
  return text === '1' || text === 'true' || text === 'yes' || text === 'on'
}

function normalizeUpdate (body) {
  if (!isObject(body)) throw invalid('a JSON object body is required')
  const memoryId = readMemoryId(body.memoryId)
  const text = requiredText(body.text, 'text')
  const input = { memoryId, text }

  const tags = stringList(body.tags, 'tags')
  if (tags !== undefined) input.tags = tags
  const triggers = stringList(body.triggers, 'triggers')
  if (triggers !== undefined) input.triggers = triggers

  if (body.importance !== undefined && body.importance !== null && body.importance !== '') {
    const importance = Number(body.importance)
    if (!Number.isFinite(importance)) throw invalid('importance must be a finite number')
    input.importance = importance
  }
  if (body.validUntil !== undefined && body.validUntil !== null && body.validUntil !== '') {
    if (typeof body.validUntil !== 'string') throw invalid('validUntil must be an ISO date string')
    if (Number.isNaN(Date.parse(body.validUntil))) throw invalid('validUntil must be an ISO date string')
    input.validUntil = body.validUntil
  }

  const reason = optionalText(body.reason, 'reason')
  if (reason !== undefined) input.reason = reason
  return input
}

/* ----------------------------------------------------------------- handlers */

/**
 * Build the handler set. Exported as a test seam (tests can drive it without a
 * web server); production code only calls `registerMemoryRoutes`.
 * @param {object} service - the CurateService singleton.
 * @param {string} key - this launch's control key.
 */
export function createMemoryHandlers (service, key) {
  const callable = (name) => {
    if (typeof service?.[name] !== 'function') {
      const error = new Error(
        `memory-curate: the running host does not provide service.${name}(); ` +
        'the memory browser needs a newer host integration'
      )
      error.code = 'MEMORY_UI_UNAVAILABLE'
      throw error
    }
  }

  const storeEnabled = () => {
    try {
      return service?.enabled !== false
    } catch {
      return true
    }
  }

  const promptVersion = () => {
    try {
      return typeof service?.promptVersion === 'function' ? service.promptVersion() : null
    } catch {
      return null
    }
  }

  /**
   * GET /status — the issuer of the control key, exactly like plugin-health's
   * status route. It has no key check of its own (nothing would work otherwise);
   * loopback, peer and Origin/Sec-Fetch-Site guards still apply, and the answer
   * cannot be read cross-origin because no CORS headers are sent.
   */
  async function status (req, res) {
    try {
      if (!authorizeStatus(req, res)) return
      send(res, 200, {
        ok: true,
        enabled: storeEnabled(),
        readOnly: service?.readOnly === true,
        namespace: typeof service?.config?.namespace === 'string' ? service.config.namespace : null,
        promptVersion: promptVersion(),
        key,
        capabilities: {
          browse: typeof service?.browse === 'function',
          trace: typeof service?.trace === 'function',
          update: typeof service?.updateMemory === 'function',
          delete: typeof service?.deleteById === 'function'
        }
      }, keyCookieHeaders(key))
    } catch (error) {
      failure(res, error)
    }
  }

  /** GET /browse?q=&tag=&limit=&includeExpired=1 */
  async function browse (req, res) {
    try {
      if (!authorizeRead(req, res, key)) return
      callable('browse')

      const url = new URL(req.url ?? BROWSE_PATH, 'http://127.0.0.1')
      const query = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim()
      const tags = readTags(url.searchParams)
      const limit = readLimit(url.searchParams.get('limit'))
      const includeExpired = readFlag(url.searchParams.get('includeExpired'))

      const result = await service.browse({ query, tags, limit, includeExpired, admin: true })
      if (isObject(result) && result.ok === false) {
        const error = new Error(typeof result.error === 'string' && result.error !== '' ? result.error : 'memory store unavailable')
        error.code = 'MEMORY_UI_UNAVAILABLE'
        throw error
      }
      const rows = (Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []))
        .filter((row) => row !== null && typeof row === 'object')
      const total = isObject(result) && Number.isInteger(result.total) ? result.total : rows.length
      send(res, 200, { ok: true, rows, total, promptVersion: promptVersion() })
    } catch (error) {
      failure(res, error)
    }
  }

  /** GET /trace?memoryId=... — every stored row for that id, oldest first. */
  async function trace (req, res) {
    try {
      if (!authorizeRead(req, res, key)) return
      callable('trace')

      const url = new URL(req.url ?? TRACE_PATH, 'http://127.0.0.1')
      const memoryId = readMemoryId(url.searchParams.get('memoryId'))
      const result = await service.trace({ memoryId, admin: true })
      const rows = (Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []))
        .filter((row) => row !== null && typeof row === 'object')
      send(res, 200, { ok: true, memoryId, rows })
    } catch (error) {
      failure(res, error)
    }
  }

  /** POST /update — append-only supersede through `service.updateMemory`. */
  async function update (req, res) {
    try {
      if (!authorizeWrite(req, res, key)) return
      callable('updateMemory')

      const body = await readBody(req)
      const input = normalizeUpdate(body)
      const result = await service.updateMemory({ ...input, admin: true })
      if (isObject(result) && result.ok === false) {
        throw invalid(typeof result.error === 'string' && result.error !== '' ? result.error : 'the memory store rejected the edit')
      }
      send(res, 200, { ok: true, id: typeof result?.id === 'string' ? result.id : null })
    } catch (error) {
      failure(res, error)
    }
  }

  /** POST /delete — append-only tombstone through `service.deleteById`. */
  async function remove (req, res) {
    try {
      if (!authorizeWrite(req, res, key)) return
      callable('deleteById')

      const body = await readBody(req)
      if (!isObject(body)) throw invalid('a JSON object body is required')
      const memoryId = readMemoryId(body.memoryId)
      const reason = optionalText(body.reason, 'reason') ?? ''

      const result = await service.deleteById({ memoryId, reason, admin: true })
      if (isObject(result) && result.ok === false) {
        throw invalid(typeof result.error === 'string' && result.error !== '' ? result.error : 'the memory store rejected the deletion')
      }
      send(res, 200, { ok: true, tombstoneId: typeof result?.tombstoneId === 'string' ? result.tombstoneId : null })
    } catch (error) {
      failure(res, error)
    }
  }

  return { status, browse, trace, update, remove }
}

/**
 * Mount the memory-browser routes on the host's web server.
 *
 * Never throws during boot. The `webServer` dependency is injected later, so a
 * CLI-only profile (or a test context without a web server) simply never mounts
 * the routes; the browser half then shows its error state instead of crashing.
 *
 * @param {object} ctx - Cordis host context (must expose `inject`).
 * @param {object} service - CurateService singleton.
 * @returns {{ok: boolean, error?: string}}
 */
export function registerMemoryRoutes (ctx, service) {
  try {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') {
      return { ok: false, error: 'the host context has no inject(); memory browser routes were not registered' }
    }

    // Minted per boot; sibling code does not need it, the browser learns it from /status.
    const key = randomBytes(24).toString('hex')
    const handlers = createMemoryHandlers(service, key)

    ctx.inject(['webServer'], (webCtx) => {
      try {
        if (webCtx === undefined || webCtx === null || webCtx.webServer === undefined ||
            typeof webCtx.webServer.register !== 'function') {
          warn(webCtx, 'the host has no webServer.register(); the memory browser will stay unavailable')
          return
        }
        webCtx.effect(() => {
          const disposers = []
          const mount = (path, handler) => {
            disposers.push(webCtx.webServer.register({ kind: 'exact', path, handler }))
          }
          try {
            mount(STATUS_PATH, handlers.status)
            mount(BROWSE_PATH, handlers.browse)
            mount(TRACE_PATH, handlers.trace)
            mount(UPDATE_PATH, handlers.update)
            mount(DELETE_PATH, handlers.remove)
          } catch (error) {
            // A duplicate path means the route was already mounted by a stale instance.
            // Remove what this effect added, then report; never leave half a route table.
            for (const dispose of disposers) {
              try { dispose() } catch { /* the route was never added */ }
            }
            throw error
          }
          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch { /* already disposed */ }
            }
          }
        })
      } catch (error) {
        warn(webCtx, `memory browser routes were not registered: ${messageOf(error)}`)
      }
    })

    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export default registerMemoryRoutes
