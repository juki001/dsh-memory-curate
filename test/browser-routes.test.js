import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMemoryHandlers,
  registerMemoryRoutes,
  STATUS_PATH,
  BROWSE_PATH,
  TRACE_PATH,
  UPDATE_PATH,
  DELETE_PATH
} from '../src/browser-routes.js'

function fakeRes () {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead (status, headers) {
      res.status = status
      res.headers = headers
    },
    end (payload) {
      res.body = payload === undefined ? undefined : JSON.parse(payload)
    }
  }
  return res
}

function fakeReq ({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress }
  }
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    // Real HTTP bodies carry a length (or chunked encoding); the write guard uses
    // that to tell "empty body" from "body without a JSON content type".
    if (req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined) {
      req.headers['content-length'] = String(Buffer.byteLength(text, 'utf8'))
    }
    req[Symbol.asyncIterator] = async function * () {
      yield Buffer.from(text, 'utf8')
    }
  } else {
    req[Symbol.asyncIterator] = async function * () {}
  }
  return req
}

function fakeService (overrides = {}) {
  return {
    enabled: true,
    promptVersion: () => 'p1',
    browse: async () => ({ ok: true, rows: [{ id: 'm_1', text: '默认使用 pnpm', tags: ['构建'] }], total: 1 }),
    trace: async () => [{ kind: 'memory', id: 'm_1', text: '默认使用 pnpm' }],
    updateMemory: async (input) => ({ ok: true, id: 'm_2', input }),
    deleteById: async (input) => ({ ok: true, tombstoneId: 't_1', input }),
    ...overrides
  }
}

const KEY = 'test-key'

test('UI-01 status issues the control key inside the loopback fence', async () => {
  const handlers = createMemoryHandlers(fakeService(), KEY)
  const res = fakeRes()
  await handlers.status(fakeReq({ url: STATUS_PATH }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.key, KEY)
  assert.equal(res.body.capabilities.update, true)
  assert.match(res.headers['set-cookie'], /memory_curate_key=test-key/)
})

test('UI-02 a non-loopback Host is refused before any handler runs', async () => {
  const handlers = createMemoryHandlers(fakeService(), KEY)
  const res = fakeRes()
  await handlers.status(fakeReq({ headers: { host: '10.0.0.5:3080' } }), res)
  assert.equal(res.status, 403)
})

test('UI-03 browse requires the control key', async () => {
  const handlers = createMemoryHandlers(fakeService(), KEY)
  const denied = fakeRes()
  await handlers.browse(fakeReq({ url: `${BROWSE_PATH}?q=pnpm` }), denied)
  assert.equal(denied.status, 401)

  const allowed = fakeRes()
  await handlers.browse(fakeReq({
    url: `${BROWSE_PATH}?q=pnpm&tag=%E6%9E%84%E5%BB%BA`,
    headers: { 'x-memory-curate-key': KEY }
  }), allowed)
  assert.equal(allowed.status, 200)
  assert.equal(allowed.body.rows.length, 1)
  assert.equal(allowed.body.total, 1)
})

test('UI-04 a write without a JSON content type is refused', async () => {
  const handlers = createMemoryHandlers(fakeService(), KEY)
  const res = fakeRes()
  await handlers.update(fakeReq({
    method: 'POST',
    url: UPDATE_PATH,
    headers: { 'x-memory-curate-key': KEY },
    body: { memoryId: 'm_1', text: 'x' }
  }), res)
  assert.equal(res.status, 415)
})

test('UI-05 an authorized edit reaches the append-only service method', async () => {
  const calls = []
  const service = fakeService({
    updateMemory: async (input) => {
      calls.push(input)
      return { ok: true, id: 'm_2' }
    }
  })
  const handlers = createMemoryHandlers(service, KEY)
  const res = fakeRes()
  await handlers.update(fakeReq({
    method: 'POST',
    url: UPDATE_PATH,
    headers: { 'content-type': 'application/json', 'x-memory-curate-key': KEY },
    body: { memoryId: 'm_1', text: '更新后的正文', tags: ['构建'], importance: 4, reason: 'clarity' }
  }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.id, 'm_2')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].memoryId, 'm_1')
  assert.deepEqual(calls[0].tags, ['构建'])
  assert.equal(calls[0].importance, 4)
})

test('UI-06 delete returns the tombstone id', async () => {
  const handlers = createMemoryHandlers(fakeService(), KEY)
  const res = fakeRes()
  await handlers.remove(fakeReq({
    method: 'POST',
    url: DELETE_PATH,
    headers: { 'content-type': 'application/json', 'x-memory-curate-key': KEY },
    body: { memoryId: 'm_1', reason: 'obsolete' }
  }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.tombstoneId, 't_1')
})

test('UI-07 malformed input is rejected with 400, not a crash', async () => {
  const handlers = createMemoryHandlers(fakeService(), KEY)
  const badJson = fakeRes()
  await handlers.update(fakeReq({
    method: 'POST',
    url: UPDATE_PATH,
    headers: { 'content-type': 'application/json', 'x-memory-curate-key': KEY },
    body: '{not json'
  }), badJson)
  assert.equal(badJson.status, 400)

  const badId = fakeRes()
  await handlers.remove(fakeReq({
    method: 'POST',
    url: DELETE_PATH,
    headers: { 'content-type': 'application/json', 'x-memory-curate-key': KEY },
    body: { memoryId: '../../etc/passwd' }
  }), badId)
  assert.equal(badId.status, 400)
})

test('UI-08 a host without the service is reported as 503, not a boot failure', async () => {
  const handlers = createMemoryHandlers({ enabled: true }, KEY)
  const res = fakeRes()
  await handlers.browse(fakeReq({
    url: BROWSE_PATH,
    headers: { 'x-memory-curate-key': KEY }
  }), res)
  assert.equal(res.status, 503)
  assert.match(res.body.error, /does not provide service\.browse/)
})

test('UI-09 registration mounts five exact routes and never throws', () => {
  const paths = []
  const ctx = {
    inject: (_names, callback) => callback({
      webServer: {
        register (route) {
          paths.push(`${route.kind} ${route.path}`)
          return () => {}
        }
      },
      effect: (fn) => fn(),
      logger: { warn: () => {} }
    })
  }
  const result = registerMemoryRoutes(ctx, fakeService())
  assert.equal(result.ok, true)
  assert.deepEqual(paths, [
    `exact ${STATUS_PATH}`,
    `exact ${BROWSE_PATH}`,
    `exact ${TRACE_PATH}`,
    `exact ${UPDATE_PATH}`,
    `exact ${DELETE_PATH}`
  ])
  assert.equal(registerMemoryRoutes({}, fakeService()).ok, false)
})
